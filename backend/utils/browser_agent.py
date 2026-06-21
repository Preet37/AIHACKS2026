"""Off-device product finder: an Orkes/Browserbase cloud browser, driven by Stagehand.

Instead of scraping the user's local tab, this spins up a Browserbase cloud Chrome
session and drives it with Stagehand's AI ``extract``/``execute``. The user's cookies
are handed off into that cloud session (Playwright ``add_cookies`` over CDP) so it acts
as the logged-in user, off-device. Returns structured findings plus a Browserbase
replay URL so the run can be watched.

Flow: start session -> attach Playwright over CDP -> inject cookies -> goto start URL
-> extract matching items -> if none, run the autonomous agent to search/scroll, then
extract again -> normalize -> return findings + session_id + replay_url.
"""

from __future__ import annotations

import importlib.util
from dataclasses import dataclass
from typing import Any

from .agentspan_finder import _normalize_items


DEFAULT_BROWSE_MODEL = "anthropic/claude-sonnet-4-6"
BROWSERBASE_SESSION_URL = "https://www.browserbase.com/sessions/{session_id}"

# JSON schema Stagehand validates the extraction against.
_ITEMS_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "url": {"type": "string", "description": "Absolute link to the item's page"},
                    "image": {"type": "string", "description": "Absolute direct image URL"},
                    "price": {"type": "string"},
                    "note": {"type": "string", "description": "Short reason it matches (<=120 chars)"},
                },
                "required": ["title", "url"],
            },
        }
    },
    "required": ["items"],
}

# chrome.cookies sameSite -> Playwright sameSite
_SAME_SITE = {"no_restriction": "None", "lax": "Lax", "strict": "Strict"}


@dataclass(frozen=True, slots=True)
class BrowserAgentSettings:
    browserbase_api_key: str | None = None
    browserbase_project_id: str | None = None
    model: str = DEFAULT_BROWSE_MODEL
    model_api_key: str | None = None
    max_results: int = 6
    max_steps: int = 6


class BrowserAgentError(RuntimeError):
    """Raised when the off-device browse fails or returns nothing usable."""


def missing_requirement(settings: BrowserAgentSettings) -> str | None:
    """Pre-flight: human message if the off-device browse can't run, else None."""
    if importlib.util.find_spec("stagehand") is None:
        return "stagehand is not installed on the backend (pip install stagehand)"
    if importlib.util.find_spec("playwright") is None:
        return "playwright is not installed on the backend (pip install playwright)"
    if not settings.browserbase_api_key:
        return "BROWSERBASE_API_KEY is not configured on the backend"
    if not settings.browserbase_project_id:
        return "BROWSERBASE_PROJECT_ID is not configured on the backend"
    if not settings.model_api_key:
        return f"The model API key (for '{settings.model}') is not configured on the backend"
    return None


async def find_items_remote(
    *,
    task: str,
    settings: BrowserAgentSettings,
    start_url: str,
    cookies: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """Browse ``start_url`` in a cloud browser and return matching items.

    Returns ``{"findings": [...], "session_id": str, "replay_url": str}``.
    """
    if not start_url:
        raise BrowserAgentError("A start URL is required for the off-device browse")

    try:
        from stagehand import AsyncStagehand
        from playwright.async_api import async_playwright
    except ImportError as exc:  # pragma: no cover - guarded by missing_requirement
        raise BrowserAgentError(f"Off-device browse dependencies are missing: {exc}") from exc

    playwright_cookies = _to_playwright_cookies(cookies or [])

    try:
        async with AsyncStagehand(
            browserbase_api_key=settings.browserbase_api_key,
            browserbase_project_id=settings.browserbase_project_id,
            model_api_key=settings.model_api_key,
        ) as client:
            session = await client.sessions.start(
                model_name=settings.model,
                browser={"type": "browserbase"},
            )
            session_id = _session_field(session, "session_id")
            cdp_url = _session_field(session, "cdp_url")
            replay_url = (
                BROWSERBASE_SESSION_URL.format(session_id=session_id) if session_id else ""
            )

            try:
                items = await _drive_session(
                    session=session,
                    cdp_url=cdp_url,
                    start_url=start_url,
                    task=task,
                    settings=settings,
                    playwright_cookies=playwright_cookies,
                    async_playwright=async_playwright,
                )
            finally:
                await _safe_end(session)
    except BrowserAgentError:
        raise
    except Exception as exc:  # network / Stagehand / Browserbase failure
        raise BrowserAgentError(f"Off-device browse failed: {exc}") from exc

    findings = _normalize_items(items, page_url=start_url, limit=settings.max_results)
    return {"findings": findings, "session_id": session_id or "", "replay_url": replay_url}


async def _drive_session(
    *,
    session: Any,
    cdp_url: str | None,
    start_url: str,
    task: str,
    settings: BrowserAgentSettings,
    playwright_cookies: list[dict[str, Any]],
    async_playwright: Any,
) -> list[dict[str, Any]]:
    if not cdp_url:
        raise BrowserAgentError("Browserbase did not return a CDP url for the session")

    async with async_playwright() as playwright:
        browser = await playwright.chromium.connect_over_cdp(cdp_url)
        try:
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            if playwright_cookies:
                try:
                    await context.add_cookies(playwright_cookies)
                except Exception:
                    # A malformed cookie shouldn't abort the whole run.
                    pass
            page = context.pages[0] if context.pages else await context.new_page()
            await page.goto(start_url, wait_until="domcontentloaded")

            items = await _extract_items(session, page, task, settings.max_results)
            if not items:
                await _run_search_agent(session, page, task, settings)
                items = await _extract_items(session, page, task, settings.max_results)
            return items
        finally:
            await browser.close()


async def _extract_items(
    session: Any, page: Any, task: str, max_results: int
) -> list[dict[str, Any]]:
    instruction = (
        f"Find the products on this page that best match: {task}. "
        f"Return up to {max_results} items, best matches first. "
        "Only include items actually present on the page. "
        "Use absolute http(s) URLs for both the item link and the image."
    )
    response = await session.extract(instruction=instruction, schema=_ITEMS_SCHEMA, page=page)
    return _items_from_result(_response_result(response))


async def _run_search_agent(
    session: Any, page: Any, task: str, settings: BrowserAgentSettings
) -> None:
    """Autonomous fallback: let the agent search/scroll to surface results."""
    instruction = (
        f"On this website, find products matching: {task}. "
        "If results are not visible, use the site's search box and scroll to load them. "
        "Stay on this site; do not navigate to a different website."
    )
    try:
        await session.execute(
            execute_options={"instruction": instruction, "max_steps": settings.max_steps},
            agent_config={"model": {"model_name": settings.model, "api_key": settings.model_api_key}},
            page=page,
        )
    except Exception:
        # Best-effort navigation; we still try to extract whatever is on the page.
        return


def _items_from_result(result: Any) -> list[dict[str, Any]]:
    if isinstance(result, dict):
        items = result.get("items")
        if isinstance(items, list):
            return [item for item in items if isinstance(item, dict)]
        return []
    if isinstance(result, list):
        return [item for item in result if isinstance(item, dict)]
    return []


def _response_result(response: Any) -> Any:
    """Stagehand responses are ``{data: {result: ...}, success: bool}``."""
    data = getattr(response, "data", None)
    if data is not None:
        result = getattr(data, "result", None)
        if result is not None:
            return result
        if isinstance(data, dict):
            return data.get("result")
    if isinstance(response, dict):
        return (response.get("data") or {}).get("result")
    return None


def _session_field(session: Any, name: str) -> str | None:
    data = getattr(session, "data", None)
    value = getattr(data, name, None)
    if value is None and isinstance(data, dict):
        value = data.get(name)
    return str(value) if value else None


async def _safe_end(session: Any) -> None:
    try:
        await session.end()
    except Exception:
        pass


def _to_playwright_cookies(chrome_cookies: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Map chrome.cookies.getAll() entries to Playwright add_cookies() entries."""
    mapped: list[dict[str, Any]] = []
    for cookie in chrome_cookies:
        if not isinstance(cookie, dict):
            continue
        name = cookie.get("name")
        value = cookie.get("value")
        domain = cookie.get("domain")
        if not name or value is None or not domain:
            continue

        entry: dict[str, Any] = {
            "name": str(name),
            "value": str(value),
            "domain": str(domain),
            "path": str(cookie.get("path") or "/"),
            "httpOnly": bool(cookie.get("httpOnly", False)),
            "secure": bool(cookie.get("secure", False)),
        }

        expires = cookie.get("expirationDate")
        if isinstance(expires, (int, float)) and not cookie.get("session"):
            entry["expires"] = float(expires)

        same_site = _SAME_SITE.get(str(cookie.get("sameSite", "")).lower())
        if same_site:
            entry["sameSite"] = same_site
            if same_site == "None":
                entry["secure"] = True  # browsers require Secure for SameSite=None

        mapped.append(entry)
    return mapped
