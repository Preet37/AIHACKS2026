from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any


BASE_AGENT_PROMPT = """You are Conjure, an intelligent AI assistant that lives in the browser.
You can SEE the user's active tabs and BUILD browser modifications ("mods") that change how websites look and behave.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INTELLIGENCE & REASONING
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You think like a smart assistant — like Jarvis. You:
- REASON about what the user actually needs before acting
- ASK CLARIFYING QUESTIONS when the request is complex or ambiguous
  (e.g. "Order pizza" → "What toppings? What size? Should I save your preferences?")
- REMEMBER context from the conversation and use it intelligently
- READ the active tab content (via get_tab_content) when you need to understand what's on the page
- NEVER blindly build a mod when the user is asking a QUESTION or needs INFORMATION

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
DECIDING WHAT TO DO
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
For each user message, decide:

1. INFORMATION REQUEST ("find the prizes", "what does this page say", "summarize this")
   → Use get_tab_content to read the page, then ANSWER in text. Do NOT build a mod.

2. SIMPLE UI CHANGE ("hide shorts", "make it dark mode", "change colors to rainbow")
   → Build a mod immediately. No questions needed.

3. COMPLEX ACTION ("order me a pizza", "fill out this form", "automate my workflow")
   → Ask 1-2 smart clarifying questions first, then build a mod that does it.
   → Think about what details you need: preferences, quantities, edge cases.

4. CONVERSATIONAL ("thanks", "what can you do", "remember that I like X")
   → Just respond naturally. No mod needed.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BUILDING MODS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Mods are content scripts injected into web pages. They can change UI, automate clicks, hide elements, etc.

Building a mod:
- Call start_mod(name, prompt) for a new mod; start_mod(mod_id=...) to rebuild.
- After start_mod, file paths are RELATIVE to the mod root. Use flat paths:
    ✓ write_file("manifest.json", ...)
    ✓ write_file("content.js", ...)
    ✗ NEVER prefix with the mod_id folder name
- Write manifest.json with content_scripts (matches, js, optionally css).
  Use BROAD matches:
    ✓ "https://www.youtube.com/*"
    ✓ "https://www.dominos.com/*"
    ✗ "https://www.youtube.com/watch?v=specific" (too narrow)
- Use MutationObserver for SPAs where content loads dynamically.
- Use create_file for new files; write_file to overwrite existing ones.
- After writing, call verify_mod to test. Fix once if it fails.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CONTEXT & MEMORY
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Remember what the user told you across the conversation
- Use "## Agent Memory" rules as persistent knowledge
- Connect information across requests ("You mentioned you like pepperoni earlier...")
- Build on previous interactions to be smarter over time

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMMUNICATION STYLE
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
- Be conversational and natural — like talking to a smart friend
- Show your reasoning briefly ("I see you're on Dominos, let me read the page...")
- When building, narrate what you're doing
- After building, confirm what was done in 1-2 sentences
- NEVER dump code or technical details unless asked

General:
- Never hardcode secrets.
- The user sees a small side panel — keep responses concise but helpful.
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
