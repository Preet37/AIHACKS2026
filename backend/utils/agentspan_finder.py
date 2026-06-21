"""Orkes AgentSpan agent for 'find items on this page' tasks.

The extension scrapes the page the user is viewing and posts it to the backend.
This module runs an AgentSpan agent (https://agentspan.ai) over that page source
and returns the matching items as structured findings the side panel renders as
image + link cards.

AgentSpan is a durable agent runtime: the SDK runs the agent in this process while
execution state lives on the local AgentSpan server (default http://localhost:6767).
Start it once with ``agentspan server start``. The agent calls an LLM provider, so
the matching provider key must be set (e.g. ANTHROPIC_API_KEY for an
``anthropic/...`` model).
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import urljoin


DEFAULT_AGENTSPAN_SERVER_URL = "http://localhost:6767/api"
DEFAULT_AGENTSPAN_MODEL = "anthropic/claude-sonnet-4-6"

# Agents are token-billed by the underlying provider, so cap how much page source
# we forward. HTML carries the product links and image src attributes we need, so
# it is preferred over plain text when both are available.
MAX_PAGE_CHARS = 30000

# Which env var must hold the provider key, keyed by the model's "provider/" prefix.
_PROVIDER_ENV_VARS = {
    "anthropic": "ANTHROPIC_API_KEY",
    "openai": "OPENAI_API_KEY",
    "gemini": "GOOGLE_API_KEY",
    "google": "GOOGLE_API_KEY",
    "groq": "GROQ_API_KEY",
}

_INSTRUCTIONS = (
    "You are an AgentSpan shopping and research agent. You are given the source of a "
    "single web page the user is currently viewing and a task describing what to find. "
    "Find the items on the page that best match the task. "
    "Respond with STRICT JSON only (no Markdown, no commentary) shaped exactly as:\n"
    '{"items": [{"title": str, "url": str, "image": str, "price": str, "note": str}]}\n'
    "Rules:\n"
    "- url is the link to the item's page; image is a direct image URL; both must be "
    "absolute http(s) URLs. Resolve any relative paths against the provided page URL.\n"
    "- price is the listed price as shown (empty string if none). note is a short reason "
    "this item matches (<= 120 chars).\n"
    "- Return the best matches first, omit anything that does not match, and never invent "
    "items or URLs that are not present in the page source.\n"
    '- If nothing matches, return {"items": []}.'
)


@dataclass(frozen=True, slots=True)
class AgentSpanSettings:
    model: str = DEFAULT_AGENTSPAN_MODEL
    server_url: str = DEFAULT_AGENTSPAN_SERVER_URL
    max_results: int = 6
    agent_name: str = "conjure-finder"


class AgentSpanError(RuntimeError):
    """Raised when the AgentSpan run fails or returns an unusable response."""


def provider_env_var(model: str) -> str | None:
    """The env var that must hold the LLM key for ``model`` (None if unknown)."""
    provider = model.split("/", 1)[0].strip().lower() if model else ""
    return _PROVIDER_ENV_VARS.get(provider)


def missing_requirement(settings: AgentSpanSettings) -> str | None:
    """Return a human message if AgentSpan can't run, else None (pre-flight check)."""
    if importlib.util.find_spec("agentspan") is None:
        return "agentspan is not installed on the backend (pip install agentspan)"
    env_var = provider_env_var(settings.model)
    if env_var and not os.getenv(env_var):
        return f"{env_var} is not set for model '{settings.model}'"
    return None


async def find_items(
    *,
    task: str,
    settings: AgentSpanSettings,
    page_url: str = "",
    page_text: str = "",
    page_html: str = "",
) -> list[dict[str, str]]:
    """Run the AgentSpan agent to extract items matching ``task`` from the page."""
    source = _build_page_source(page_html=page_html, page_text=page_text)
    if not source:
        raise AgentSpanError("No page content was provided to search")

    prompt = (
        f"Task: {task.strip()}\n"
        f"Page URL: {page_url or 'unknown'}\n"
        f"Return at most {settings.max_results} items.\n\n"
        f"Page source:\n{source}"
    )

    # runtime.run() blocks, so keep it off the event loop.
    raw = await asyncio.to_thread(_run_agent, prompt, settings)
    items = _extract_items(raw)
    return _normalize_items(items, page_url=page_url, limit=settings.max_results)


def _run_agent(prompt: str, settings: AgentSpanSettings) -> Any:
    try:
        from agentspan.agents import Agent, AgentRuntime
    except ImportError as exc:  # pragma: no cover - exercised via missing_requirement
        raise AgentSpanError(
            "agentspan is not installed on the backend (pip install agentspan)"
        ) from exc

    agent = Agent(
        name=settings.agent_name,
        model=settings.model,
        instructions=_INSTRUCTIONS,
    )
    try:
        with AgentRuntime(server_url=settings.server_url) as runtime:
            result = runtime.run(agent, prompt)
    except Exception as exc:  # network / server / provider failure
        raise AgentSpanError(f"AgentSpan run failed: {exc}") from exc

    if getattr(result, "is_success", True) is False:
        detail = getattr(result, "error", None) or getattr(result, "status", "unknown")
        raise AgentSpanError(f"AgentSpan run did not succeed: {detail}")
    return _result_output(result)


def _result_output(result: Any) -> Any:
    """Pull the agent's final answer out of an AgentSpan AgentResult.

    ``AgentResult.output`` is a dict like ``{"result": <text>, "finishReason": ...}``
    — the model's answer is the ``result`` field. Fall back gracefully for other
    result shapes."""
    output = getattr(result, "output", None)
    if isinstance(output, dict):
        inner = output.get("result")
        return inner if inner is not None else output
    if output is not None:
        return output
    for attr in ("result", "text", "content"):
        value = getattr(result, attr, None)
        if value is not None:
            return value
    return result


def _build_page_source(*, page_html: str, page_text: str) -> str:
    source = (page_html or page_text or "").strip()
    if len(source) > MAX_PAGE_CHARS:
        source = source[:MAX_PAGE_CHARS] + "\n... [truncated]"
    return source


def _extract_items(raw: Any) -> list[dict[str, Any]]:
    if isinstance(raw, (dict, list)):
        data: Any = raw
    else:
        data = _loads_json_object(str(raw))
        if data is None:
            raise AgentSpanError("Could not parse JSON from the AgentSpan response")
    items = data.get("items") if isinstance(data, dict) else data
    if not isinstance(items, list):
        return []
    return [item for item in items if isinstance(item, dict)]


def _loads_json_object(text: str) -> Any | None:
    stripped = _strip_code_fences(text).strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass
    # Models sometimes wrap JSON in prose; recover the outermost object/array.
    match = re.search(r"(\{.*\}|\[.*\])", stripped, re.DOTALL)
    if not match:
        return None
    try:
        return json.loads(match.group(1))
    except json.JSONDecodeError:
        return None


def _strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return text
    lines = stripped.splitlines()
    if lines and lines[0].startswith("```"):
        lines = lines[1:]
    if lines and lines[-1].strip() == "```":
        lines = lines[:-1]
    return "\n".join(lines)


def _normalize_items(
    items: list[dict[str, Any]],
    *,
    page_url: str,
    limit: int,
) -> list[dict[str, str]]:
    findings: list[dict[str, str]] = []
    for item in items:
        title = _clean(item.get("title"))
        url = _absolute(_clean(item.get("url")), page_url)
        if not title or not url:
            continue
        findings.append(
            {
                "title": title,
                "url": url,
                "image": _absolute(_clean(item.get("image")), page_url),
                "price": _clean(item.get("price")),
                "note": _clean(item.get("note")),
            }
        )
        if len(findings) >= limit:
            break
    return findings


def _clean(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def _absolute(candidate: str, page_url: str) -> str:
    if not candidate:
        return ""
    if candidate.startswith(("http://", "https://", "data:")):
        return candidate
    if not page_url:
        return candidate
    try:
        return urljoin(page_url, candidate)
    except ValueError:
        return candidate
