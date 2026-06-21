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
import re
import time
import uuid
from pathlib import Path
from typing import Any, Mapping


REGISTRY_FILENAME = "registry.json"


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


def list_mods(project_dir: Path) -> list[dict[str, Any]]:
    """Return all mod records, importing any legacy single-bundle project once."""
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
    merged: dict[str, Any] | None = None
    for index, mod in enumerate(mods):
        if mod.get("id") == record.get("id"):
            merged = {**mod, **record, "updated_at": _now()}
            mods[index] = merged
            break
    if merged is None:
        merged = {"created_at": _now(), "updated_at": _now(), **record}
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
    return {"mod_id": mod_id, **bundle}


def active_bundles(project_dir: Path) -> list[dict[str, Any]]:
    """Every active mod's bundle, for the extension to register/apply."""
    bundles: list[dict[str, Any]] = []
    for mod in list_mods(project_dir):
        if mod.get("status") != "active":
            continue
        bundle = mod_bundle(project_dir, str(mod.get("id")))
        if bundle is not None:
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
        "created_at": _now(),
        "updated_at": _now(),
        "last_verified": None,
        "imported": True,
    }
    _save_registry(project_dir, {"mods": [record]})
