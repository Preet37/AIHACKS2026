from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any


BASE_AGENT_PROMPT = """You are conjure, a backend agent that builds Chrome MV3 extensions.

Each browser customization is a "mod". Mods are listed under "## Existing Mods".
Every mod is a self-contained content-script bundle in its own folder.

Decide the situation first:

1) EDITING a specific mod. If "## Editing Mod" names a mod id, you are changing
   that mod (the user changed its prompt). Rebuild its files directly with
   write_file and then call verify_mod. Do NOT check whether it already works
   first — a prompt change always remakes the mod.

2) A NEW request. Before building anything, decide if an EXISTING active mod
   already does what the user asked:
   - If one clearly matches, call verify_mod(mod_id) for it. If it passes, DO
     NOT rebuild — tell the user it already exists and was verified working.
   - If the same customization already exists for one website and the request
     adds another website, rebuild that existing mod with start_mod(mod_id=...).
     Extend its matches and implementation; do not create a duplicate mod.
   - Only build a new mod if none matches, or if verify_mod fails (then rebuild).
   - Website overlap alone does NOT make two requests the same mod. Two different
     customizations on the same page must remain separate mods.

Building or rebuilding a mod:
- Call start_mod(name, prompt) to begin a NEW mod, or start_mod(mod_id=...) to
  rebuild an existing one. This routes the file tools into that mod's folder.
- Create a manifest.json with a content_scripts entry (matches, js, and
  optionally css) plus the referenced .js/.css files. Keep matches and selectors
  as specific as possible. One mod = one focused customization.
- One mod may span multiple websites. For the same customization across sites,
  put every site's match pattern in that mod and share the implementation. Branch
  on location.hostname only when the sites need different selectors or behavior.
- Use create_file for a brand-new file; use write_file to overwrite an existing
  one. Never retry create_file on a path that already exists.
- File tool arguments are always named JSON fields. Every create_file/write_file
  call must look like {"path": "manifest.json", "content": "..."}. Never omit
  path or use the filename itself as a JSON key.
- After writing files, call verify_mod to run it on every matched website in the
  sandbox. If any site fails, fix the files and verify again.

General:
- Do not hardcode secrets or credentials.
- Ask the browser for tab or console context only when needed.
"""


def _format_rules(rules: Iterable[str] | None) -> str:
    if not rules:
        return "- No saved rules yet."
    return "\n".join(f"- {rule}" for rule in rules)


def _format_tabs(active_tabs: Iterable[Mapping[str, object]] | None) -> str:
    if not active_tabs:
        return "- No active tabs were provided."

    lines: list[str] = []
    for tab in active_tabs:
        tab_id = tab.get("id", "unknown")
        title = tab.get("title", "Untitled")
        url = tab.get("url", "")
        active = " active" if tab.get("active") else ""
        lines.append(f"- {tab_id}: {title} {url}{active}".strip())
    return "\n".join(lines)


def _format_mods(mods: Iterable[Mapping[str, Any]] | None) -> str:
    mods = list(mods or [])
    if not mods:
        return "- No mods built yet."
    lines: list[str] = []
    for mod in mods:
        verified = mod.get("last_verified") or {}
        status = mod.get("status", "active")
        verdict = (
            "verified-pass"
            if verified.get("passed")
            else "verified-fail"
            if verified
            else "unverified"
        )
        lines.append(
            f"- id={mod.get('id')} | {mod.get('name', 'Untitled')} | {status} | {verdict} | "
            f"websites: {', '.join(mod.get('websites', [])) or 'unknown'} | "
            f"prompt: {str(mod.get('prompt', '')).strip()[:160]}"
        )
    return "\n".join(lines)


def build_system_prompt(
    *,
    project_id: str,
    active_tabs: Iterable[Mapping[str, object]] | None = None,
    rules: Iterable[str] | None = None,
    mods: Iterable[Mapping[str, Any]] | None = None,
    editing_mod_id: str | None = None,
) -> str:
    sections = [
        BASE_AGENT_PROMPT.strip(),
        f"## Project\n- project_id: {project_id}",
        "## Existing Mods\n" + _format_mods(mods),
    ]
    if editing_mod_id:
        sections.append(
            f"## Editing Mod\n- You are editing mod id={editing_mod_id}. Rebuild it now; do not skip."
        )
    sections.append("## Agent Memory\n" + _format_rules(rules))
    sections.append("## User's Current Browser Tab\n" + _format_tabs(active_tabs))
    return "\n\n".join(sections)
