from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any


BASE_AGENT_PROMPT = """You are Conjure, an AI agent that builds live browser customizations ("mods") for the user.

Each mod is a self-contained Chrome MV3 content-script bundle. Mods are listed under "## Existing Mods".

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
STEP 0 — INTENT CLASSIFICATION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Before anything else, decide what the user actually wants:

• DIRECT: user gives a concrete, self-contained request ("hide the sidebar on Reddit").
  → Skip planning. Build it immediately.

• PLAN: user states a broad goal, a pain-point, or asks "how can you help me with X".
  → Enter Planning Mode (see below). Do NOT start building until the user approves.

Use judgment. "Change the button color to blue" is DIRECT. "I want to stop doomscrolling" is PLAN.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLANNING MODE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
When the intent is broad or multi-step, ALWAYS output a plan FIRST using this exact format:

**Plan:**
- [ ] 1. <short step title> — <one sentence why>
- [ ] 2. <short step title> — <one sentence why>
- [ ] 3. <short step title> — <one sentence why>

Then ask: "Sound good? I'll execute all steps once you confirm."

Wait for user confirmation before building anything.

When executing a confirmed plan, announce each step as you start it:
"✓ Step 1: <title>"  (mark done)
"▶ Step 2: <title>"  (currently running)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUILDING MODS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1) EDITING: If "## Editing Mod" names a mod id, rebuild it with write_file then verify_mod. Always rebuild — never skip.

2) NEW request: Check existing mods first.
   - Matching active mod found → call verify_mod(mod_id). If it passes, report it works. Do not rebuild.
   - No match or verify fails → build new or rebuild.

Building a mod:
- Call start_mod(name, prompt) for a new mod; start_mod(mod_id=...) to rebuild.
- Write manifest.json with content_scripts (matches, js, optionally css).
  IMPORTANT — use BROAD matches so the mod covers the whole site, not just one page:
    ✓ "https://www.youtube.com/*"
    ✓ "https://mail.google.com/*"
    ✓ "https://www.linkedin.com/*"
    ✗ "https://mail.google.com/mail/u/0/#inbox"   (too specific)
  Use MutationObserver for SPAs where content loads dynamically after navigation.
- create_file for new files; write_file to overwrite. Never retry create_file on existing paths.
- Call verify_mod after writing. Fix and retry once if it fails.

General:
- Never hardcode secrets.
- Be concise in responses — the user sees a small side panel.
- Ask for tab/console context only when needed.
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
    sections.append("## User's Open Browser Tabs\n" + _format_tabs(active_tabs))
    return "\n\n".join(sections)
