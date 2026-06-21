from __future__ import annotations

import json
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


Issue = dict[str, str]


VALID_MV3_KEYS = {
    "action",
    "author",
    "background",
    "chrome_settings_overrides",
    "chrome_url_overrides",
    "commands",
    "content_scripts",
    "content_security_policy",
    "cross_origin_embedder_policy",
    "cross_origin_opener_policy",
    "declarative_net_request",
    "default_locale",
    "description",
    "devtools_page",
    "externally_connectable",
    "homepage_url",
    "host_permissions",
    "icons",
    "incognito",
    "key",
    "manifest_version",
    "minimum_chrome_version",
    "name",
    "oauth2",
    "offline_enabled",
    "omnibox",
    "optional_host_permissions",
    "optional_permissions",
    "options_page",
    "options_ui",
    "permissions",
    "requirements",
    "sandbox",
    "short_name",
    "side_panel",
    "storage",
    "tts_engine",
    "update_url",
    "version",
    "version_name",
    "web_accessible_resources",
}


VALID_MV3_PERMISSIONS = {
    "activeTab",
    "alarms",
    "bookmarks",
    "browsingData",
    "certificateProvider",
    "clipboardRead",
    "clipboardWrite",
    "contentSettings",
    "contextMenus",
    "cookies",
    "debugger",
    "declarativeContent",
    "declarativeNetRequest",
    "declarativeNetRequestFeedback",
    "declarativeNetRequestWithHostAccess",
    "desktopCapture",
    "downloads",
    "fontSettings",
    "gcm",
    "geolocation",
    "history",
    "identity",
    "idle",
    "loginState",
    "management",
    "nativeMessaging",
    "notifications",
    "offscreen",
    "pageCapture",
    "platformKeys",
    "power",
    "printerProvider",
    "privacy",
    "proxy",
    "readingList",
    "scripting",
    "search",
    "sessions",
    "sidePanel",
    "storage",
    "system.cpu",
    "system.display",
    "system.memory",
    "system.storage",
    "tabCapture",
    "tabGroups",
    "tabs",
    "topSites",
    "tts",
    "ttsEngine",
    "unlimitedStorage",
    "vpnProvider",
    "wallpaper",
    "webAuthenticationProxy",
    "webNavigation",
    "webRequest",
    "webRequestAuthProvider",
}


MV3_REMOVED_API_PATTERNS = (
    (re.compile(r"\bchrome\.browserAction\b"), "chrome.browserAction is MV2-only; use chrome.action in MV3"),
    (re.compile(r"\bchrome\.pageAction\b"), "chrome.pageAction is MV2-only; use chrome.action in MV3"),
    (
        re.compile(r"\bchrome\.tabs\.executeScript\b"),
        "chrome.tabs.executeScript is removed in MV3; use chrome.scripting.executeScript",
    ),
    (
        re.compile(r"\bchrome\.tabs\.insertCSS\b"),
        "chrome.tabs.insertCSS is removed in MV3; use chrome.scripting.insertCSS",
    ),
    (
        re.compile(r"\bchrome\.extension\.getURL\b"),
        "chrome.extension.getURL is deprecated; use chrome.runtime.getURL",
    ),
)


SERVICE_WORKER_UNAVAILABLE_PATTERNS = (
    (re.compile(r"\bXMLHttpRequest\b"), "XMLHttpRequest is unavailable in MV3 service workers; use fetch"),
    (re.compile(r"\blocalStorage\b"), "localStorage is unavailable in MV3 service workers; use chrome.storage"),
    (re.compile(r"\bdocument\b"), "document is unavailable in MV3 service workers"),
    (re.compile(r"\bwindow\b"), "window is unavailable in MV3 service workers"),
)


SKIPPED_SCAN_DIRS = {"node_modules", ".git", "__pycache__"}


@dataclass(frozen=True)
class ManifestPath:
    raw_path: str
    category: str
    required: bool = True
    allow_glob: bool = False


def validate_extension(project_dir: str | Path) -> list[Issue]:
    """Run deterministic MV3 static checks for a generated Chrome extension."""
    root = Path(project_dir).resolve()
    issues: list[Issue] = []

    manifest = _load_manifest(root, issues)
    if manifest is None:
        return issues

    _validate_manifest_shape(manifest, issues)
    manifest_paths = list(_collect_manifest_paths(manifest))
    _validate_manifest_paths(root, manifest_paths, issues)
    _check_js_syntax(root, manifest_paths, issues)
    _scan_mv3_compatibility(root, manifest, issues)

    return issues


def has_errors(issues: Iterable[Issue]) -> bool:
    return any(issue["level"] == "error" for issue in issues)


def _issue(level: str, category: str, message: str) -> Issue:
    return {"level": level, "category": category, "message": message}


def _load_manifest(root: Path, issues: list[Issue]) -> dict[str, Any] | None:
    manifest_path = root / "manifest.json"
    if not manifest_path.exists():
        issues.append(_issue("error", "manifest", "manifest.json is missing"))
        return None

    try:
        parsed = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        issues.append(_issue("error", "manifest", f"manifest.json is invalid JSON: {exc.msg} at line {exc.lineno}"))
        return None

    if not isinstance(parsed, dict):
        issues.append(_issue("error", "manifest", "manifest.json must contain a JSON object"))
        return None

    return parsed


def _validate_manifest_shape(manifest: dict[str, Any], issues: list[Issue]) -> None:
    required_fields = ("manifest_version", "name", "version")
    for field in required_fields:
        if field not in manifest:
            issues.append(_issue("error", "manifest", f"manifest.json is missing required field '{field}'"))

    if manifest.get("manifest_version") != 3:
        issues.append(_issue("error", "manifest", "manifest_version must be 3 for Chrome MV3 extensions"))

    for key in sorted(manifest):
        if key not in VALID_MV3_KEYS:
            issues.append(_issue("warning", "manifest", f"Unknown MV3 manifest key '{key}'"))

    permissions = manifest.get("permissions", [])
    if not isinstance(permissions, list):
        issues.append(_issue("error", "manifest", "permissions must be a list when present"))
    else:
        for permission in permissions:
            if not isinstance(permission, str):
                issues.append(_issue("error", "manifest", "permissions entries must be strings"))
                continue
            if _looks_like_host_permission(permission):
                issues.append(
                    _issue(
                        "warning",
                        "manifest",
                        f"Host permission '{permission}' should be declared in host_permissions for MV3",
                    )
                )
            elif permission == "webRequestBlocking":
                issues.append(
                    _issue(
                        "warning",
                        "manifest",
                        "webRequestBlocking is not generally available in MV3; prefer declarativeNetRequest",
                    )
                )
            elif permission not in VALID_MV3_PERMISSIONS:
                issues.append(_issue("warning", "manifest", f"Unknown MV3 permission '{permission}'"))

    _validate_string_list(manifest, "host_permissions", issues)
    _validate_string_list(manifest, "optional_permissions", issues)
    _validate_string_list(manifest, "optional_host_permissions", issues)

    background = manifest.get("background")
    if isinstance(background, dict):
        if "scripts" in background:
            issues.append(_issue("error", "manifest", "background.scripts is MV2-only; use background.service_worker"))
        if background.get("persistent") is True:
            issues.append(_issue("error", "manifest", "background.persistent is not supported in MV3"))
        if "service_worker" in background and not isinstance(background["service_worker"], str):
            issues.append(_issue("error", "manifest", "background.service_worker must be a string path"))
    elif background is not None:
        issues.append(_issue("error", "manifest", "background must be an object when present"))


def _validate_string_list(manifest: dict[str, Any], key: str, issues: list[Issue]) -> None:
    value = manifest.get(key)
    if value is None:
        return
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        issues.append(_issue("error", "manifest", f"{key} must be a list of strings when present"))


def _looks_like_host_permission(value: str) -> bool:
    return value == "<all_urls>" or "://" in value or value.startswith("*.")


def _collect_manifest_paths(manifest: dict[str, Any]) -> Iterable[ManifestPath]:
    background = manifest.get("background")
    if isinstance(background, dict):
        if isinstance(background.get("service_worker"), str):
            yield ManifestPath(background["service_worker"], "background.service_worker")
        if isinstance(background.get("scripts"), list):
            for script in background["scripts"]:
                if isinstance(script, str):
                    yield ManifestPath(script, "background.scripts")

    for entry in _iter_objects(manifest.get("content_scripts")):
        for key in ("js", "css"):
            for path in _iter_strings(entry.get(key)):
                yield ManifestPath(path, f"content_scripts.{key}")

    for path in _iter_strings((manifest.get("icons") or {}).values() if isinstance(manifest.get("icons"), dict) else []):
        yield ManifestPath(path, "icons")

    action = manifest.get("action")
    if isinstance(action, dict) and isinstance(action.get("default_popup"), str):
        yield ManifestPath(action["default_popup"], "action.default_popup")

    browser_action = manifest.get("browser_action")
    if isinstance(browser_action, dict) and isinstance(browser_action.get("default_popup"), str):
        yield ManifestPath(browser_action["default_popup"], "browser_action.default_popup")

    for key in ("options_page", "devtools_page"):
        if isinstance(manifest.get(key), str):
            yield ManifestPath(manifest[key], key)

    options_ui = manifest.get("options_ui")
    if isinstance(options_ui, dict) and isinstance(options_ui.get("page"), str):
        yield ManifestPath(options_ui["page"], "options_ui.page")

    side_panel = manifest.get("side_panel")
    if isinstance(side_panel, dict) and isinstance(side_panel.get("default_path"), str):
        yield ManifestPath(side_panel["default_path"], "side_panel.default_path")

    chrome_url_overrides = manifest.get("chrome_url_overrides")
    if isinstance(chrome_url_overrides, dict):
        for path in _iter_strings(chrome_url_overrides.values()):
            yield ManifestPath(path, "chrome_url_overrides")

    sandbox = manifest.get("sandbox")
    if isinstance(sandbox, dict):
        for path in _iter_strings(sandbox.get("pages")):
            yield ManifestPath(path, "sandbox.pages")

    for entry in _iter_objects(manifest.get("web_accessible_resources")):
        for path in _iter_strings(entry.get("resources")):
            yield ManifestPath(path, "web_accessible_resources.resources", allow_glob=True)


def _iter_objects(value: Any) -> Iterable[dict[str, Any]]:
    if not isinstance(value, list):
        return
    for item in value:
        if isinstance(item, dict):
            yield item


def _iter_strings(value: Any) -> Iterable[str]:
    if not isinstance(value, Iterable) or isinstance(value, (str, bytes, dict)):
        return
    for item in value:
        if isinstance(item, str):
            yield item


def _validate_manifest_paths(root: Path, paths: Iterable[ManifestPath], issues: list[Issue]) -> None:
    for manifest_path in paths:
        if manifest_path.allow_glob and _has_glob(manifest_path.raw_path):
            _validate_glob_path(root, manifest_path, issues)
            continue

        resolved = _resolve_manifest_path(root, manifest_path.raw_path, issues)
        if resolved is None:
            continue
        if manifest_path.required and not resolved.is_file():
            issues.append(
                _issue(
                    "error",
                    "file_reference",
                    f"{manifest_path.category} references missing file '{manifest_path.raw_path}'",
                )
            )


def _validate_glob_path(root: Path, manifest_path: ManifestPath, issues: list[Issue]) -> None:
    if _resolve_manifest_path(root, manifest_path.raw_path.replace("*", "_glob_"), []) is None:
        issues.append(
            _issue(
                "error",
                "file_reference",
                f"{manifest_path.category} references unsafe path pattern '{manifest_path.raw_path}'",
            )
        )
        return

    matches = [path for path in root.glob(manifest_path.raw_path) if path.is_file()]
    if not matches:
        issues.append(
            _issue(
                "error",
                "file_reference",
                f"{manifest_path.category} pattern '{manifest_path.raw_path}' did not match any files",
            )
        )


def _resolve_manifest_path(root: Path, raw_path: str, issues: list[Issue]) -> Path | None:
    if not raw_path or raw_path.startswith(("http://", "https://", "data:", "chrome://")):
        issues.append(_issue("error", "file_reference", f"Manifest path '{raw_path}' must be a relative file path"))
        return None

    candidate = (root / raw_path).resolve()
    if not candidate.is_relative_to(root):
        issues.append(_issue("error", "file_reference", f"Manifest path '{raw_path}' escapes the extension root"))
        return None

    return candidate


def _has_glob(value: str) -> bool:
    return any(char in value for char in "*?[")


def _check_js_syntax(root: Path, manifest_paths: Iterable[ManifestPath], issues: list[Issue]) -> None:
    js_paths = {
        resolved
        for manifest_path in manifest_paths
        if manifest_path.raw_path.endswith(".js")
        for resolved in [_resolve_manifest_path(root, manifest_path.raw_path, [])]
        if resolved is not None and resolved.is_file()
    }
    if not js_paths:
        return

    node = shutil.which("node")
    if node is None:
        issues.append(_issue("warning", "js_syntax", "node is not available; skipped JavaScript syntax checks"))
        return

    for path in sorted(js_paths):
        result = subprocess.run(
            [node, "--check", str(path)],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0:
            rel_path = path.relative_to(root).as_posix()
            output = (result.stderr or result.stdout).strip().splitlines()
            detail = output[-1] if output else "node --check failed"
            issues.append(_issue("error", "js_syntax", f"{rel_path} failed node --check: {detail}"))


def _scan_mv3_compatibility(root: Path, manifest: dict[str, Any], issues: list[Issue]) -> None:
    service_workers = _service_worker_paths(root, manifest)

    for path in _iter_js_files(root):
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            issues.append(_issue("warning", "mv3_compatibility", f"{path.relative_to(root).as_posix()} is not UTF-8; skipped scan"))
            continue

        rel_path = path.relative_to(root).as_posix()
        for pattern, message in MV3_REMOVED_API_PATTERNS:
            if pattern.search(text):
                issues.append(_issue("warning", "mv3_compatibility", f"{rel_path}: {message}"))

        if path in service_workers:
            for pattern, message in SERVICE_WORKER_UNAVAILABLE_PATTERNS:
                if pattern.search(text):
                    issues.append(_issue("warning", "mv3_compatibility", f"{rel_path}: {message}"))


def _service_worker_paths(root: Path, manifest: dict[str, Any]) -> set[Path]:
    background = manifest.get("background")
    if not isinstance(background, dict) or not isinstance(background.get("service_worker"), str):
        return set()

    resolved = _resolve_manifest_path(root, background["service_worker"], [])
    return {resolved} if resolved is not None and resolved.is_file() else set()


def _iter_js_files(root: Path) -> Iterable[Path]:
    for path in root.rglob("*.js"):
        if any(part in SKIPPED_SCAN_DIRS for part in path.relative_to(root).parts):
            continue
        if path.is_file():
            yield path
