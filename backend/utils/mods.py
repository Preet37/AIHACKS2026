"""Mod registry: each browser customization Conjure builds is a "mod".

A mod is a self-contained MV3 content-script bundle living in its own directory
under ``<project_dir>/mods/<mod_id>/`` plus a record in
``<project_dir>/mods/registry.json``. Keeping each mod isolated lets us list,
remove, re-generate, and sandbox-verify them independently, and lets the Chrome
extension register one ``chrome.userScripts`` entry per mod.

The registry is intentionally file-based (not Redis): the generated code already
lives on disk, so co-locating the index keeps a mod and its files atomic and
makes the whole thing trivially inspectable.
"""

from __future__ import annotations

import json
import math
import re
import time
import uuid
from pathlib import Path
from typing import Any, Mapping


REGISTRY_FILENAME = "registry.json"
VISUAL_EDIT_TYPES = {"setText", "setStyle", "hide", "setBox"}
VISUAL_EDIT_STYLE_PROPERTIES = {
    "color",
    "backgroundColor",
    "fontSize",
    "padding",
    "margin",
    "borderRadius",
    "opacity",
}
VISUAL_EDIT_BOX_PROPERTIES = {"x", "y", "width", "height", "fontScale"}
VISUAL_EDIT_BOX_SIZING_AXES = {"width", "height"}
VISUAL_EDIT_BOX_SIZING_VALUES = {"fixed", "hug"}
VISUAL_EDIT_BOX_HUG_PROPERTIES = {"left", "right", "top", "bottom"}


def mods_root(project_dir: Path) -> Path:
    return project_dir / "mods"


def registry_path(project_dir: Path) -> Path:
    return mods_root(project_dir) / REGISTRY_FILENAME


def mod_dir(project_dir: Path, mod_id: str) -> Path:
    return mods_root(project_dir) / sanitize_mod_id(mod_id)


def new_mod_id() -> str:
    return uuid.uuid4().hex[:12]


def sanitize_mod_id(mod_id: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "", str(mod_id))
    if not cleaned:
        raise ValueError("Invalid mod id")
    return cleaned[:40]


def _now() -> float:
    return time.time()


def _load_registry(project_dir: Path) -> dict[str, Any]:
    path = registry_path(project_dir)
    if not path.is_file():
        return {"mods": []}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"mods": []}
    if not isinstance(data, dict) or not isinstance(data.get("mods"), list):
        return {"mods": []}
    return data


def _save_registry(project_dir: Path, registry: dict[str, Any]) -> None:
    root = mods_root(project_dir)
    root.mkdir(parents=True, exist_ok=True)
    registry_path(project_dir).write_text(
        json.dumps(registry, indent=2, sort_keys=True), encoding="utf-8"
    )


def _string_value(value: Any, *, max_length: int = 100_000) -> str:
    return str(value)[:max_length]


def _finite_number(value: Any) -> float | int | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    if not math.isfinite(float(value)):
        return None
    return value


def normalize_visual_edits(value: Any) -> list[dict[str, Any]]:
    """Return only v1 structured visual-edit operations safe to persist/compile."""
    if value is None:
        return []
    if not isinstance(value, list):
        raise ValueError("visual_edits must be a list")

    normalized: list[dict[str, Any]] = []
    for raw in value:
        if not isinstance(raw, Mapping):
            continue
        operation_type = raw.get("type")
        selector = raw.get("selector")
        if operation_type not in VISUAL_EDIT_TYPES or not isinstance(selector, str) or not selector.strip():
            continue

        operation: dict[str, Any] = {
            "id": _string_value(raw.get("id") or uuid.uuid4().hex[:12], max_length=80),
            "type": operation_type,
            "selector": selector.strip()[:2000],
        }
        if isinstance(raw.get("url"), str):
            operation["url"] = raw["url"][:2000]

        if operation_type == "setText":
            operation["value"] = _string_value(raw.get("value", ""))
        elif operation_type == "setStyle":
            styles = raw.get("styles")
            if not isinstance(styles, Mapping):
                continue
            clean_styles: dict[str, str] = {}
            for property_name, property_value in styles.items():
                if property_name in VISUAL_EDIT_STYLE_PROPERTIES and isinstance(property_value, str):
                    clean_styles[str(property_name)] = property_value[:1000]
            if not clean_styles:
                continue
            operation["styles"] = clean_styles
        elif operation_type == "hide":
            operation["hidden"] = bool(raw.get("hidden", True))
        elif operation_type == "setBox":
            box = raw.get("box")
            if not isinstance(box, Mapping):
                continue
            clean_box: dict[str, Any] = {}
            for property_name, property_value in box.items():
                if property_name not in VISUAL_EDIT_BOX_PROPERTIES:
                    continue
                number = _finite_number(property_value)
                if number is not None:
                    clean_box[str(property_name)] = number
            sizing = box.get("sizing")
            if isinstance(sizing, Mapping):
                clean_sizing: dict[str, str] = {}
                for axis, mode in sizing.items():
                    if axis in VISUAL_EDIT_BOX_SIZING_AXES and mode in VISUAL_EDIT_BOX_SIZING_VALUES:
                        clean_sizing[str(axis)] = str(mode)
                if clean_sizing:
                    clean_box["sizing"] = clean_sizing
            hug = box.get("hug")
            if isinstance(hug, Mapping):
                clean_hug: dict[str, float | int] = {}
                for property_name, property_value in hug.items():
                    if property_name not in VISUAL_EDIT_BOX_HUG_PROPERTIES:
                        continue
                    number = _finite_number(property_value)
                    if number is not None:
                        clean_hug[str(property_name)] = number
                if clean_hug:
                    clean_box["hug"] = clean_hug
            if not clean_box:
                continue
            operation["box"] = clean_box

        normalized.append(operation)

    return normalized


def compile_visual_edits(visual_edits: Any) -> str:
    """Compile structured visual-edit operations into retrying DOM patch JS."""
    operations = normalize_visual_edits(visual_edits)
    if not operations:
        return ""

    operations_json = json.dumps(operations, ensure_ascii=True, separators=(",", ":"))
    return f"""
;(function () {{
  var edits = {operations_json};
  var retryTimer = null;
  function kebab(value) {{
    return String(value).replace(/[A-Z]/g, function (letter) {{ return "-" + letter.toLowerCase(); }});
  }}
  function px(value) {{
    return typeof value === "number" && Number.isFinite(value) ? value + "px" : null;
  }}
  function clamp(value, min, max) {{
    return Math.max(min, Math.min(max, value));
  }}
  function finiteOrFallback(value, fallback) {{
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }}
  function currentTranslate(element) {{
    var transform = getComputedStyle(element).transform;
    if (!transform || transform === "none") return {{ x: 0, y: 0 }};
    var matrix3d = /^matrix3d\\((.+)\\)$/.exec(transform);
    if (matrix3d) {{
      var values3d = matrix3d[1].split(",").map(function (value) {{ return parseFloat(value.trim()); }});
      return {{
        x: Number.isFinite(values3d[12]) ? values3d[12] : 0,
        y: Number.isFinite(values3d[13]) ? values3d[13] : 0
      }};
    }}
    var matrix = /^matrix\\((.+)\\)$/.exec(transform);
    if (matrix) {{
      var values = matrix[1].split(",").map(function (value) {{ return parseFloat(value.trim()); }});
      return {{
        x: Number.isFinite(values[4]) ? values[4] : 0,
        y: Number.isFinite(values[5]) ? values[5] : 0
      }};
    }}
    var translate = /translate(?:3d)?\\(([^,)]+),\\s*([^,)]+)/.exec(transform);
    if (translate) {{
      var x = parseFloat(translate[1]);
      var y = parseFloat(translate[2]);
      return {{
        x: Number.isFinite(x) ? x : 0,
        y: Number.isFinite(y) ? y : 0
      }};
    }}
    return {{ x: 0, y: 0 }};
  }}
  function includeHugBounds(bounds, left, top, right, bottom) {{
    if (![left, top, right, bottom].every(Number.isFinite)) return;
    if (right <= left || bottom <= top) return;
    bounds.left = Math.min(bounds.left, left);
    bounds.right = Math.max(bounds.right, right);
    bounds.top = Math.min(bounds.top, top);
    bounds.bottom = Math.max(bounds.bottom, bottom);
    bounds.hasContent = true;
  }}
  function includeDirectTextBounds(element, rootRect, bounds) {{
    for (var index = 0; index < element.childNodes.length; index += 1) {{
      var node = element.childNodes[index];
      if (node.nodeType !== 3 || !String(node.textContent || "").trim()) continue;
      var range = document.createRange();
      range.selectNodeContents(node);
      var rects = range.getClientRects();
      for (var rectIndex = 0; rectIndex < rects.length; rectIndex += 1) {{
        var rect = rects[rectIndex];
        includeHugBounds(
          bounds,
          rect.left - rootRect.left,
          rect.top - rootRect.top,
          rect.right - rootRect.left,
          rect.bottom - rootRect.top
        );
      }}
      if (range.detach) range.detach();
    }}
  }}
  function isVisibleHugElement(element) {{
    var style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }}
  function isHugContentElement(element) {{
    var tag = String(element.tagName || "").toLowerCase();
    return element.children.length === 0 ||
      hasDirectText(element) ||
      /^(INPUT|TEXTAREA)$/.test(element.tagName || "") ||
      /^(BUTTON|CANVAS|IMG|PICTURE|SVG|VIDEO)$/i.test(tag);
  }}
  function measureHugContentBounds(root) {{
    if (!root || !root.querySelectorAll || !isVisibleHugElement(root)) return null;
    var rootRect = root.getBoundingClientRect();
    var bounds = {{
      left: Number.POSITIVE_INFINITY,
      right: Number.NEGATIVE_INFINITY,
      top: Number.POSITIVE_INFINITY,
      bottom: Number.NEGATIVE_INFINITY,
      hasContent: false
    }};
    includeDirectTextBounds(root, rootRect, bounds);
    var elements = root.querySelectorAll("*");
    for (var index = 0; index < elements.length; index += 1) {{
      var element = elements[index];
      if (!element || !element.style || !isVisibleHugElement(element)) continue;
      includeDirectTextBounds(element, rootRect, bounds);
      if (!isHugContentElement(element)) continue;
      var rect = element.getBoundingClientRect();
      includeHugBounds(
        bounds,
        rect.left - rootRect.left,
        rect.top - rootRect.top,
        rect.right - rootRect.left,
        rect.bottom - rootRect.top
      );
      if (/^(INPUT|TEXTAREA)$/.test(element.tagName || "")) {{
        includeHugBounds(
          bounds,
          rect.left - rootRect.left,
          rect.top - rootRect.top,
          rect.left - rootRect.left + Math.max(element.scrollWidth || 0, rect.width),
          rect.top - rootRect.top + Math.max(element.scrollHeight || 0, rect.height)
        );
      }}
    }}
    if (!bounds.hasContent) return null;
    return {{
      left: bounds.left,
      right: bounds.right,
      top: bounds.top,
      bottom: bounds.bottom,
      width: bounds.right - bounds.left,
      height: bounds.bottom - bounds.top
    }};
  }}
  function hugInsets(box, bounds, currentWidth, currentHeight) {{
    var hug = box.hug || {{}};
    return {{
      left: finiteOrFallback(hug.left, Math.max(0, bounds.left)),
      right: finiteOrFallback(hug.right, Math.max(0, currentWidth - bounds.right)),
      top: finiteOrFallback(hug.top, Math.max(0, bounds.top)),
      bottom: finiteOrFallback(hug.bottom, Math.max(0, currentHeight - bounds.bottom))
    }};
  }}
  function applyHugSizing(element, box) {{
    var sizing = box.sizing || {{}};
    if (sizing.width !== "hug" && sizing.height !== "hug") return;
    var bounds = measureHugContentBounds(element);
    if (!bounds) return;
    var rect = element.getBoundingClientRect();
    var insets = hugInsets(box, bounds, finiteOrFallback(box.width, rect.width), finiteOrFallback(box.height, rect.height));
    if (sizing.width === "hug") {{
      var styleWidth = Math.max(
        8,
        Math.ceil(bounds.width + insets.left + insets.right),
        Math.ceil(bounds.right + insets.right)
      );
      element.style.width = styleWidth + "px";
    }}
    if (sizing.height === "hug") {{
      var styleHeight = Math.max(
        8,
        Math.ceil(bounds.height + insets.top + insets.bottom),
        Math.ceil(bounds.bottom + insets.bottom)
      );
      element.style.height = styleHeight + "px";
    }}
  }}
  function hasDirectText(element) {{
    for (var index = 0; index < element.childNodes.length; index += 1) {{
      var node = element.childNodes[index];
      if (node.nodeType === 3 && String(node.textContent || "").trim()) return true;
    }}
    return false;
  }}
  function hasVisibleText(element) {{
    if (/^(INPUT|TEXTAREA)$/.test(element.tagName || "")) {{
      return Boolean(element.value || element.placeholder);
    }}
    return Boolean(String(element.innerText || element.textContent || "").trim());
  }}
  function textScaleTargets(root) {{
    var elements = [root].concat(Array.prototype.slice.call(root.querySelectorAll ? root.querySelectorAll("*") : []));
    return elements.filter(function (element) {{
      if (!element || !element.style || !hasVisibleText(element)) return false;
      return hasDirectText(element) || /^(INPUT|TEXTAREA|SPAN|P|LABEL|STRONG|EM|SMALL|H1|H2|H3|H4|H5|H6|A|LI|FIGCAPTION|CODE|PRE|B|I)$/i.test(element.tagName || "");
    }});
  }}
  function baseFontSize(element) {{
    if (typeof element.__conjureVisualBaseFontSize === "number" && Number.isFinite(element.__conjureVisualBaseFontSize)) {{
      return element.__conjureVisualBaseFontSize;
    }}
    var size = parseFloat(getComputedStyle(element).fontSize || "16");
    element.__conjureVisualBaseFontSize = Number.isFinite(size) ? size : 16;
    return element.__conjureVisualBaseFontSize;
  }}
  function fitTextToParent(element, containerOverride) {{
    var parent = element.parentElement;
    var container = containerOverride || (parent && parent !== document.documentElement ? parent : element);
    var availableWidth = Math.max(1, container.clientWidth || container.getBoundingClientRect().width);
    var availableHeight = Math.max(1, container.clientHeight || container.getBoundingClientRect().height);
    if (!availableWidth || !availableHeight) return;
    element.style.maxWidth = "100%";
    element.style.maxHeight = "100%";
    element.style.overflow = "hidden";
    element.style.overflowWrap = "anywhere";
    element.style.wordBreak = "break-word";
    element.style.boxSizing = "border-box";
    if (getComputedStyle(element).display === "inline") {{
      element.style.display = "inline-block";
    }}
    for (var attempt = 0; attempt < 8; attempt += 1) {{
      var overflowWidth = element.scrollWidth > availableWidth + 1;
      var overflowHeight = element.scrollHeight > availableHeight + 1;
      if (!overflowWidth && !overflowHeight) break;
      var current = parseFloat(getComputedStyle(element).fontSize || "16");
      if (!Number.isFinite(current) || current <= 8) break;
      var widthRatio = overflowWidth ? availableWidth / Math.max(1, element.scrollWidth) : 1;
      var heightRatio = overflowHeight ? availableHeight / Math.max(1, element.scrollHeight) : 1;
      element.style.fontSize = Math.max(8, Math.floor(current * Math.min(widthRatio, heightRatio) * 0.98)) + "px";
    }}
  }}
  function scaleTextForBox(root, scale) {{
    if (typeof scale !== "number" || !Number.isFinite(scale)) return;
    var boundedScale = clamp(scale, 0.25, 4);
    textScaleTargets(root).forEach(function (element) {{
      element.style.fontSize = Math.max(8, Math.round(baseFontSize(element) * boundedScale)) + "px";
      fitTextToParent(element, element === root ? root : undefined);
    }});
  }}
  function applyContainingHugBoxes(element) {{
    edits.forEach(function (edit) {{
      if (edit.type !== "setBox") return;
      var box = edit.box || {{}};
      var sizing = box.sizing || {{}};
      if (sizing.width !== "hug" && sizing.height !== "hug") return;
      var boxElement;
      try {{
        boxElement = document.querySelector(edit.selector);
      }} catch (_error) {{
        return;
      }}
      if (boxElement && boxElement.contains(element)) applyEdit(edit);
    }});
  }}
  function applyEdit(edit) {{
    var element;
    try {{
      element = document.querySelector(edit.selector);
    }} catch (_error) {{
      return false;
    }}
    if (!element) return false;
    var style = element.style || {{}};
    if (edit.type === "setText") {{
      if ("value" in element && /^(INPUT|TEXTAREA)$/.test(element.tagName || "")) {{
        element.value = String(edit.value || "");
      }} else {{
        element.textContent = String(edit.value || "");
      }}
      applyContainingHugBoxes(element);
      fitTextToParent(element, /^(BUTTON|INPUT|TEXTAREA)$/.test(element.tagName || "") ? element : undefined);
      return true;
    }}
    if (edit.type === "setStyle") {{
      Object.keys(edit.styles || {{}}).forEach(function (property) {{
        style.setProperty(kebab(property), String(edit.styles[property]));
      }});
      if (edit.styles && typeof edit.styles.fontSize === "string") {{
        applyContainingHugBoxes(element);
        fitTextToParent(element);
      }}
      return true;
    }}
    if (edit.type === "hide") {{
      style.display = edit.hidden ? "none" : "";
      return true;
    }}
    if (edit.type === "setBox") {{
      var box = edit.box || {{}};
      var translate = currentTranslate(element);
      var x = finiteOrFallback(box.x, translate.x);
      var y = finiteOrFallback(box.y, translate.y);
      style.transform = "translate(" + x + "px, " + y + "px)";
      var width = px(box.width);
      var height = px(box.height);
      if (width) style.width = width;
      if (height) style.height = height;
      style.boxSizing = "border-box";
      style.overflow = "hidden";
      scaleTextForBox(element, box.fontScale);
      applyHugSizing(element, box);
      return true;
    }}
    return false;
  }}
  function applyAll() {{
    edits.forEach(applyEdit);
    edits.forEach(function (edit) {{
      if (edit.type === "setBox") applyEdit(edit);
    }});
  }}
  function start() {{
    applyAll();
    if (typeof MutationObserver === "undefined") return;
    var root = document.documentElement || document.body;
    if (!root) return;
    new MutationObserver(function () {{
      clearTimeout(retryTimer);
      retryTimer = setTimeout(applyAll, 80);
    }}).observe(root, {{ childList: true, subtree: true }});
  }}
  if (document.readyState === "loading") {{
    document.addEventListener("DOMContentLoaded", start, {{ once: true }});
  }} else {{
    start();
  }}
}})();
""".strip()


def list_mods(project_dir: Path) -> list[dict[str, Any]]:
    """Return all mod records, importing any legacy single-bundle project once.

    Each record is enriched with the concrete ``matches`` and ``websites`` (host
    labels) from its bundle so the extension can show which sites a multi-site
    mod covers."""
    migrate_legacy(project_dir)
    mods = _load_registry(project_dir).get("mods", [])
    enriched: list[dict[str, Any]] = []
    for mod in mods:
        record = dict(mod)
        mod_id = str(mod.get("id", ""))
        bundle = mod_bundle(project_dir, mod_id) if mod_id else None
        if bundle is not None:
            matches = list(bundle.get("matches", []))
            record["matches"] = matches
            record["websites"] = website_hosts_for_matches(matches)
        enriched.append(record)
    return sorted(enriched, key=lambda m: m.get("created_at", 0))


def get_mod(project_dir: Path, mod_id: str) -> dict[str, Any] | None:
    for mod in _load_registry(project_dir).get("mods", []):
        if mod.get("id") == mod_id:
            return mod
    return None


def upsert_mod(project_dir: Path, record: Mapping[str, Any]) -> dict[str, Any]:
    registry = _load_registry(project_dir)
    mods = registry.get("mods", [])
    incoming = dict(record)
    if "visual_edits" in incoming:
        incoming["visual_edits"] = normalize_visual_edits(incoming.get("visual_edits"))
    merged: dict[str, Any] | None = None
    for index, mod in enumerate(mods):
        if mod.get("id") == incoming.get("id"):
            merged = {**mod, **incoming, "updated_at": _now()}
            mods[index] = merged
            break
    if merged is None:
        merged = {"created_at": _now(), "updated_at": _now(), **incoming}
        mods.append(merged)
    registry["mods"] = mods
    _save_registry(project_dir, registry)
    return merged


def create_mod(
    project_dir: Path,
    *,
    prompt: str,
    name: str = "",
    mod_id: str | None = None,
) -> dict[str, Any]:
    """Create a fresh mod record and its (empty) workspace directory."""
    resolved_id = sanitize_mod_id(mod_id) if mod_id else new_mod_id()
    directory = mod_dir(project_dir, resolved_id)
    directory.mkdir(parents=True, exist_ok=True)
    record = {
        "id": resolved_id,
        "name": name or "Untitled mod",
        "prompt": prompt,
        "status": "active",
        "visual_edits": [],
        "created_at": _now(),
        "updated_at": _now(),
        "last_verified": None,
    }
    return upsert_mod(project_dir, record)


def delete_mod(project_dir: Path, mod_id: str) -> bool:
    registry = _load_registry(project_dir)
    mods = registry.get("mods", [])
    remaining = [mod for mod in mods if mod.get("id") != mod_id]
    if len(remaining) == len(mods):
        return False
    registry["mods"] = remaining
    _save_registry(project_dir, registry)
    directory = mod_dir(project_dir, mod_id)
    if directory.is_dir():
        for child in sorted(directory.rglob("*"), reverse=True):
            try:
                child.unlink() if child.is_file() else child.rmdir()
            except OSError:
                pass
        try:
            directory.rmdir()
        except OSError:
            pass
    return True


def read_bundle(directory: Path) -> dict[str, Any] | None:
    """Read an MV3 content-script bundle (matches + JS + CSS) from a directory."""
    manifest_path = directory / "manifest.json"
    if not manifest_path.is_file():
        # Fallback: some models nest files in a subdirectory named after the mod_id.
        # Check immediate subdirectories for a manifest.json.
        for child in directory.iterdir():
            if child.is_dir() and (child / "manifest.json").is_file():
                directory = child
                manifest_path = child / "manifest.json"
                break
        else:
            return None
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    content_scripts = manifest.get("content_scripts")
    if not isinstance(content_scripts, list) or not content_scripts:
        return None

    matches: list[str] = []
    js_parts: list[str] = []
    css_parts: list[str] = []
    run_at = "document_idle"
    resolved_root = directory.resolve()

    for entry in content_scripts:
        if not isinstance(entry, Mapping):
            continue
        for pattern in entry.get("matches", []) or []:
            if isinstance(pattern, str) and pattern not in matches:
                matches.append(pattern)
        if isinstance(entry.get("run_at"), str):
            run_at = entry["run_at"]
        for rel in entry.get("js", []) or []:
            file_path = (directory / str(rel)).resolve()
            if file_path.is_file() and resolved_root in file_path.parents:
                js_parts.append(file_path.read_text(encoding="utf-8", errors="replace"))
        for rel in entry.get("css", []) or []:
            file_path = (directory / str(rel)).resolve()
            if file_path.is_file() and resolved_root in file_path.parents:
                css_parts.append(file_path.read_text(encoding="utf-8", errors="replace"))

    if not matches or (not js_parts and not css_parts):
        return None

    return {
        "name": str(manifest.get("name", "Conjure customization")),
        "matches": matches,
        "run_at": run_at,
        "js": "\n\n".join(js_parts),
        "css": "\n\n".join(css_parts),
    }


def mod_bundle(project_dir: Path, mod_id: str) -> dict[str, Any] | None:
    bundle = read_bundle(mod_dir(project_dir, mod_id))
    if bundle is None:
        return None
    record = get_mod(project_dir, mod_id) or {}
    try:
        visual_edits_js = compile_visual_edits(record.get("visual_edits"))
    except ValueError:
        visual_edits_js = ""
    if visual_edits_js:
        bundle["js"] = "\n\n".join(part for part in [bundle.get("js", ""), visual_edits_js] if part)
    return {"mod_id": mod_id, **bundle}


def active_bundles(project_dir: Path) -> list[dict[str, Any]]:
    """Every active mod's bundle, for the extension to register/apply."""
    bundles: list[dict[str, Any]] = []
    for mod in list_mods(project_dir):
        if mod.get("status") != "active":
            continue
        bundle = mod_bundle(project_dir, str(mod.get("id")))
        if bundle is not None:
            bundle["scope_mode"] = mod.get("scope_mode", "generated")
            bundles.append(bundle)
    return bundles


def target_urls_for_matches(matches: list[str]) -> list[str]:
    """Derive one concrete URL per website in a set of Chrome match patterns.

    Scheme variants and repeated path patterns for the same host are collapsed,
    while wildcard subdomains are verified at their concrete base domain.
    """
    urls: list[str] = []
    seen_hosts: set[str] = set()
    for pattern in matches:
        match = re.match(r"^(\*|https?)://([^/*]+)", pattern)
        if not match:
            continue
        host = match.group(2).removeprefix("*.")
        if not host or host == "*":
            continue
        normalized_host = host.lower()
        if normalized_host in seen_hosts:
            continue
        seen_hosts.add(normalized_host)
        scheme = "https" if match.group(1) == "*" else match.group(1)
        urls.append(f"{scheme}://{host}")
    return urls or ["https://example.com"]


def target_url_for_matches(matches: list[str]) -> str:
    """Return the first concrete target URL (legacy single-site helper)."""
    return target_urls_for_matches(matches)[0]


def website_hosts_for_matches(matches: list[str]) -> list[str]:
    """Return the distinct host labels represented by Chrome match patterns."""
    hosts: list[str] = []
    for pattern in matches:
        if pattern == "<all_urls>":
            return ["All websites"]
        match = re.match(r"^(?:\*|https?)://([^/*]+)", pattern)
        if not match:
            continue
        host = match.group(1)
        if host == "*":
            return ["All websites"]
        if host not in hosts:
            hosts.append(host)
    return hosts


def migrate_legacy(project_dir: Path) -> None:
    """Import a pre-mods project (single manifest at the project root) as one mod
    so existing customizations show up in the list exactly once."""
    if registry_path(project_dir).is_file():
        return
    legacy_manifest = project_dir / "manifest.json"
    if not legacy_manifest.is_file():
        # Nothing to migrate, but create an empty registry so we don't re-scan.
        _save_registry(project_dir, {"mods": []})
        return

    bundle = read_bundle(project_dir)
    if bundle is None:
        _save_registry(project_dir, {"mods": []})
        return

    mod_id = new_mod_id()
    directory = mod_dir(project_dir, mod_id)
    directory.mkdir(parents=True, exist_ok=True)
    # Move the legacy files referenced by the manifest into the mod directory.
    # Consuming (not copying) the originals means migration runs exactly once and
    # a mod the user later removes cannot be resurrected from leftover root files.
    try:
        manifest = json.loads(legacy_manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        manifest = {}
    (directory / "manifest.json").write_text(
        json.dumps(manifest, indent=2), encoding="utf-8"
    )
    consumed: list[Path] = [legacy_manifest]
    for entry in manifest.get("content_scripts", []) or []:
        if not isinstance(entry, Mapping):
            continue
        for rel in list(entry.get("js", []) or []) + list(entry.get("css", []) or []):
            src = project_dir / str(rel)
            if src.is_file():
                (directory / str(rel)).parent.mkdir(parents=True, exist_ok=True)
                (directory / str(rel)).write_text(
                    src.read_text(encoding="utf-8", errors="replace"), encoding="utf-8"
                )
                consumed.append(src)
    for path in consumed:
        try:
            path.unlink()
        except OSError:
            pass

    record = {
        "id": mod_id,
        "name": str(manifest.get("name", "Imported mod")),
        "prompt": str(manifest.get("description", "Imported from legacy project")),
        "status": "active",
        "visual_edits": [],
        "created_at": _now(),
        "updated_at": _now(),
        "last_verified": None,
        "imported": True,
    }
    _save_registry(project_dir, {"mods": [record]})
