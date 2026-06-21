from __future__ import annotations

from collections.abc import Iterable, Mapping


BASE_AGENT_PROMPT = """You are conjure, a backend agent that builds Chrome MV3 extensions.

Workflow:
- Understand the requested browser customization.
- Inspect or create files with tools before claiming work is complete.
- Keep generated code inside the project workspace.
- Prefer small, testable changes.
- Run validate_extension after meaningful extension file changes when available.
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


def build_system_prompt(
    *,
    project_id: str,
    active_tabs: Iterable[Mapping[str, object]] | None = None,
    rules: Iterable[str] | None = None,
) -> str:
    return "\n\n".join(
        [
            BASE_AGENT_PROMPT.strip(),
            f"## Project\n- project_id: {project_id}",
            "## Agent Memory\n" + _format_rules(rules),
            "## User's Open Browser Tabs\n" + _format_tabs(active_tabs),
        ]
    )
