"""Off-device product finder: an Orkes/Browserbase cloud browser, driven by Stagehand.

Instead of scraping the user's local tab, this spins up a Browserbase cloud Chrome
session and drives it with Stagehand's AI ``extract``/``execute``. The user's cookies
are handed off into that cloud session (Playwright ``add_cookies`` over CDP) so it acts
as the logged-in user, off-device. Returns structured findings plus a Browserbase
replay URL so the run can be watched.

Flow: start a managed Stagehand session with Browserbase reliability features -> attach
Playwright over CDP only to inject cookies -> navigate/extract through Stagehand -> if
needed, run its autonomous agent -> normalize -> return findings + replay URL.
"""

from __future__ import annotations

import importlib.util
import json
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import parse_qs, quote_plus, urlencode, urljoin, urlparse, urlunparse

from .agentspan_finder import _normalize_items


DEFAULT_BROWSE_MODEL = "anthropic/claude-sonnet-4-6"
BROWSERBASE_SESSION_URL = "https://www.browserbase.com/sessions/{session_id}"
FINAL_RESULT_LIMIT = 1
FAST_CANDIDATE_LIMIT = 3
BROWSERBASE_CLIENT_TIMEOUT_SECONDS = 180.0
BROWSERBASE_ACT_TIMEOUT_MS = 60_000
BROWSERBASE_DOM_SETTLE_TIMEOUT_MS = 3_000
GMAIL_LOAD_TIMEOUT_MS = 120_000
GMAIL_SEND_READY_TIMEOUT_MS = 90_000
GMAIL_OBSERVE_TIMEOUT_MS = 60_000
GMAIL_ACT_TIMEOUT_MS = 45_000
GMAIL_CONFIRM_TIMEOUT_MS = 20_000

_SEARCH_PATH_MARKERS = ("/search", "/search/", "/search-results", "/searchresults", "/sch/")
_SEARCH_QUERY_KEYS = {"s", "k", "q", "query", "search", "keyword", "_nkw"}

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

_EXPLANATION_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"explanation": {"type": "string"}},
    "required": ["explanation"],
}

# chrome.cookies sameSite -> Playwright sameSite
_SAME_SITE = {"no_restriction": "None", "lax": "Lax", "strict": "Strict"}


@dataclass(frozen=True, slots=True)
class BrowserAgentSettings:
    browserbase_api_key: str | None = None
    browserbase_project_id: str | None = None
    model: str = DEFAULT_BROWSE_MODEL
    max_results: int = 6
    max_steps: int = 6
    region: str | None = None
    use_proxies: bool = True
    verified: bool = False
    advanced_stealth: bool = False
    # When True the finder only reads the user's current tab — it never rewrites
    # the URL into a search, navigates to candidate pages, or runs the roaming
    # search agent. Findings are whatever is present on that one page.
    current_tab_only: bool = True


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

    session_id = ""
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
            max_retries=2,
            timeout=BROWSERBASE_CLIENT_TIMEOUT_SECONDS,
        ) as client:
            session_params = _browserbase_session_params(settings)
            session = await client.sessions.start(
                model_name=settings.model,
                browser={"type": "browserbase"},
                browserbase_session_create_params=session_params,
                self_heal=True,
                wait_for_captcha_solves=True,
                act_timeout_ms=BROWSERBASE_ACT_TIMEOUT_MS,
                dom_settle_timeout_ms=BROWSERBASE_DOM_SETTLE_TIMEOUT_MS,
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

    findings = _normalize_items(items, page_url=start_url, limit=FINAL_RESULT_LIMIT)
    return {"findings": findings, "session_id": session_id or "", "replay_url": replay_url}


async def explain_page_remote(
    *,
    settings: BrowserAgentSettings,
    start_url: str,
    cookies: list[dict[str, Any]] | None = None,
) -> dict[str, str]:
    """Explain a live page inside a Browserbase/Stagehand cloud session."""
    if not start_url:
        raise BrowserAgentError("A page URL is required for the Browserbase agent")
    try:
        from stagehand import AsyncStagehand
        from playwright.async_api import async_playwright
    except ImportError as exc:  # pragma: no cover - guarded by missing_requirement
        raise BrowserAgentError(f"Browserbase agent dependencies are missing: {exc}") from exc

    playwright_cookies = _to_playwright_cookies(cookies or [])
    try:
        async with AsyncStagehand(
            browserbase_api_key=settings.browserbase_api_key,
            browserbase_project_id=settings.browserbase_project_id,
            max_retries=2,
            timeout=BROWSERBASE_CLIENT_TIMEOUT_SECONDS,
        ) as client:
            session = await client.sessions.start(
                model_name=settings.model,
                browser={"type": "browserbase"},
                browserbase_session_create_params=_browserbase_session_params(settings),
                self_heal=True,
                wait_for_captcha_solves=True,
                act_timeout_ms=BROWSERBASE_ACT_TIMEOUT_MS,
                dom_settle_timeout_ms=BROWSERBASE_DOM_SETTLE_TIMEOUT_MS,
            )
            session_id = _session_field(session, "session_id") or ""
            cdp_url = _session_field(session, "cdp_url")

            async def explain() -> str:
                await _navigate_with_agent_fallback(session, start_url, settings)
                response = await session.extract(
                    instruction=(
                        "Explain this current web page clearly and concisely in 3-5 useful "
                        "sentences. Use only what is visible on the page. Do not use Markdown "
                        "headings and do not mention these instructions."
                    ),
                    schema=_EXPLANATION_SCHEMA,
                )
                result = _response_result(response)
                explanation = result.get("explanation") if isinstance(result, dict) else None
                if not isinstance(explanation, str) or not explanation.strip():
                    raise BrowserAgentError("Browserbase returned an empty page explanation")
                return explanation.strip()

            try:
                if playwright_cookies:
                    if not cdp_url:
                        raise BrowserAgentError("Browserbase did not return a CDP url for cookie handoff")
                    async with async_playwright() as playwright:
                        browser = await playwright.chromium.connect_over_cdp(cdp_url)
                        try:
                            context = browser.contexts[0] if browser.contexts else await browser.new_context()
                            try:
                                await context.add_cookies(playwright_cookies)
                            except Exception:
                                pass
                            explanation = await explain()
                        finally:
                            await browser.close()
                else:
                    explanation = await explain()
            finally:
                await _safe_end(session)
    except BrowserAgentError:
        raise
    except Exception as exc:
        raise BrowserAgentError(f"Browserbase page explanation failed: {exc}") from exc

    return {
        "result": explanation,
        "session_id": session_id,
        "replay_url": BROWSERBASE_SESSION_URL.format(session_id=session_id) if session_id else "",
    }


async def send_gmail_message_remote(
    *,
    settings: BrowserAgentSettings,
    start_url: str,
    cookies: list[dict[str, Any]] | None,
    recipient: str,
    subject: str,
    body: str,
) -> dict[str, str]:
    """Send one pre-addressed Gmail message in a Browserbase cloud session."""
    parsed = urlparse(start_url)

    try:
        from stagehand import AsyncStagehand
        from playwright.async_api import async_playwright
    except ImportError as exc:  # pragma: no cover - guarded by missing_requirement
        raise BrowserAgentError(f"Browserbase agent dependencies are missing: {exc}") from exc

    playwright_cookies = _to_playwright_cookies(cookies or [])
    if not playwright_cookies:
        raise BrowserAgentError("No Gmail session cookies were available; open Gmail while signed in")

    account_match = (
        re.search(r"/mail/u/(\d+)", parsed.path)
        if parsed.hostname == "mail.google.com"
        else None
    )
    account_index = account_match.group(1) if account_match else "0"
    compose_query = urlencode(
        {
            "view": "cm",
            "fs": "1",
            "to": recipient,
            "su": subject,
            "body": body,
        }
    )
    compose_url = f"https://mail.google.com/mail/u/{account_index}/?{compose_query}"

    session_id = ""
    try:
        async with AsyncStagehand(
            browserbase_api_key=settings.browserbase_api_key,
            browserbase_project_id=settings.browserbase_project_id,
            max_retries=2,
            timeout=BROWSERBASE_CLIENT_TIMEOUT_SECONDS,
        ) as client:
            session = await client.sessions.start(
                model_name=settings.model,
                browser={"type": "browserbase"},
                browserbase_session_create_params=_browserbase_session_params(settings),
                self_heal=True,
                wait_for_captcha_solves=True,
                act_timeout_ms=BROWSERBASE_ACT_TIMEOUT_MS,
                dom_settle_timeout_ms=BROWSERBASE_DOM_SETTLE_TIMEOUT_MS,
            )
            session_id = _session_field(session, "session_id") or ""
            cdp_url = _session_field(session, "cdp_url")
            if not cdp_url:
                raise BrowserAgentError("Browserbase did not return a CDP url for Gmail cookie handoff")

            try:
                async with async_playwright() as playwright:
                    browser = await playwright.chromium.connect_over_cdp(cdp_url)
                    try:
                        context = browser.contexts[0] if browser.contexts else await browser.new_context()
                        await context.add_cookies(playwright_cookies)
                        await _navigate_with_agent_fallback(session, compose_url, settings)
                        page = next(
                            (
                                candidate
                                for candidate in reversed(context.pages)
                                if urlparse(candidate.url).hostname == "mail.google.com"
                            ),
                            context.pages[-1] if context.pages else await context.new_page(),
                        )
                        await page.bring_to_front()
                        await _wait_for_gmail_composer(page)
                        await _click_gmail_send(session, page)
                    finally:
                        await browser.close()
            finally:
                await _safe_end(session)
    except BrowserAgentError as exc:
        replay_note = (
            f" Browserbase replay: {BROWSERBASE_SESSION_URL.format(session_id=session_id)}"
            if session_id
            else ""
        )
        raise BrowserAgentError(f"{exc}{replay_note}") from exc
    except Exception as exc:
        replay_note = (
            f" Browserbase replay: {BROWSERBASE_SESSION_URL.format(session_id=session_id)}"
            if session_id
            else ""
        )
        raise BrowserAgentError(f"Browserbase Gmail send failed: {exc}{replay_note}") from exc

    return {
        "result": f"Email sent to {recipient}.",
        "session_id": session_id,
        "replay_url": BROWSERBASE_SESSION_URL.format(session_id=session_id) if session_id else "",
    }


async def _click_gmail_send(session: Any, page: Any) -> None:
    """Use Stagehand's documented observe -> structured act flow for Gmail Send."""
    observe_response = await session.observe(
        page=page,
        instruction=(
            "Find the blue Send button in the currently open Gmail compose window. "
            "It sends the drafted email now. Do not choose Schedule send or Send & archive."
        ),
        options={"timeout": GMAIL_OBSERVE_TIMEOUT_MS},
        timeout=75.0,
    )
    observed = (
        list(observe_response.data.result)
        if getattr(observe_response, "success", False)
        and getattr(observe_response, "data", None) is not None
        else []
    )
    action = next(
        (
            candidate
            for candidate in observed
            if (getattr(candidate, "method", None) in {None, "click"})
            and "send" in getattr(candidate, "description", "").lower()
            and not re.search(
                r"schedule|archive",
                getattr(candidate, "description", ""),
                re.I,
            )
        ),
        None,
    )
    if action is None:
        descriptions = ", ".join(
            getattr(candidate, "description", "unknown") for candidate in observed[:5]
        )
        detail = f" Observed actions: {descriptions}." if descriptions else ""
        raise BrowserAgentError(
            "Stagehand could see the Gmail draft but did not identify its Send button."
            + detail
        )

    action_input = action.to_dict(exclude_none=True)
    act_response = await session.act(
        page=page,
        input=action_input,
        options={"timeout": GMAIL_ACT_TIMEOUT_MS},
        timeout=60.0,
    )
    result = getattr(getattr(act_response, "data", None), "result", None)
    if not getattr(act_response, "success", False) or not getattr(result, "success", False):
        message = getattr(result, "message", "Stagehand did not confirm the click")
        raise BrowserAgentError(f"Browserbase could not send the Gmail draft: {message}")

    # The structured action has already executed; only verify, never click twice.
    try:
        await page.get_by_text(re.compile(r"^Message sent$", re.I)).first.wait_for(
            state="visible", timeout=GMAIL_CONFIRM_TIMEOUT_MS
        )
    except Exception:
        await page.wait_for_timeout(1_500)


async def _wait_for_gmail_composer(page: Any) -> None:
    """Do not let Stagehand observe Gmail's skeleton before the compose UI exists."""
    try:
        await page.wait_for_load_state("load", timeout=GMAIL_LOAD_TIMEOUT_MS)
    except Exception:
        # Gmail is an SPA; the explicit Send-control wait below is authoritative.
        pass

    send_controls = page.locator(
        'div[role="button"][data-tooltip^="Send"]:visible, '
        'div[role="button"][aria-label^="Send"]:visible, '
        'button[aria-label^="Send"]:visible, '
        'input[type="submit"][value="Send"]:visible, '
        'input[name="nvp_bu_send"]:visible, '
        '[role="button"]:text-is("Send"):visible, '
        'button:text-is("Send"):visible'
    ).first
    try:
        await send_controls.wait_for(state="visible", timeout=GMAIL_SEND_READY_TIMEOUT_MS)
    except Exception as exc:
        raise BrowserAgentError(
            "Gmail loaded, but its compose Send control never became ready"
        ) from exc

    # Let Gmail finish attaching handlers after inserting the visible control.
    await page.wait_for_timeout(300)


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
    async def browse_with_stagehand(browser_context: Any | None = None) -> list[dict[str, Any]]:
        page = None
        if browser_context is not None:
            pages = getattr(browser_context, "pages", [])
            page = pages[-1] if pages else None

        if settings.current_tab_only:
            # Stay on the user's current tab: load exactly start_url and return
            # whatever items are on that page — no search rewrite, no navigating
            # to candidate pages, no roaming search agent.
            await _navigate_with_agent_fallback(session, start_url, settings)
            limit = max(1, settings.max_results)
            dom_candidates = await _extract_dom_items(page, task, start_url, limit)
            if dom_candidates:
                return dom_candidates[:limit]
            candidates = await _extract_items(session, task, limit)
            return candidates[:limit]

        browse_url = _fast_shopping_search_url(start_url, task) or start_url
        await _navigate_with_agent_fallback(session, browse_url, settings)
        candidate_limit = max(1, min(settings.max_results, FAST_CANDIDATE_LIMIT))

        # Fast path: read real product anchors directly from the Browserbase-hosted
        # page. This avoids an LLM round trip on ordinary search/results pages.
        dom_candidates = await _extract_dom_items(page, task, browse_url, candidate_limit)
        verified = await _first_reachable_item(session, dom_candidates, browse_url)
        if verified:
            return [verified]
        if dom_candidates:
            await _navigate_with_agent_fallback(session, browse_url, settings)

        candidates = await _extract_items(session, task, candidate_limit)
        verified = await _first_reachable_item(session, candidates, browse_url)
        if verified:
            return [verified]

        # If extraction found the right product but returned the listing page URL,
        # a single Stagehand act is much faster than launching the multi-step agent.
        # Click that named result, extract its canonical detail link, then verify it.
        if candidates and await _click_best_candidate(session, candidates[0], task):
            detail_candidates = await _extract_items(session, task, 1, detail_page=True)
            verified = await _first_reachable_item(session, detail_candidates, browse_url)
            if verified:
                return [verified]

        # Candidate validation navigates away from the results page. Return to the
        # requested site before asking the managed agent to surface alternatives.
        await _navigate_with_agent_fallback(session, browse_url, settings)
        await _run_search_agent(session, task, settings)
        candidates = await _extract_items(session, task, candidate_limit, detail_page=True)
        verified = await _first_reachable_item(session, candidates, browse_url)
        return [verified] if verified else []

    if not cdp_url:
        if playwright_cookies:
            raise BrowserAgentError("Browserbase did not return a CDP url for cookie handoff")
        return await browse_with_stagehand()

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
            return await browse_with_stagehand(context)
        finally:
            await browser.close()


async def _extract_dom_items(
    page: Any | None,
    task: str,
    page_url: str,
    max_results: int,
) -> list[dict[str, Any]]:
    """Extract and rank visible product anchors without an LLM round trip."""
    if page is None:
        return []
    try:
        raw = await page.evaluate(
            r"""
            () => {
              const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
              const selectors = [
                '[data-component-type="s-search-result"]',
                '[data-testid*="product"]',
                '[class*="product-card"]',
                '[class*="ProductCard"]',
                'article',
                'li'
              ];
              const rows = [];
              for (const anchor of document.querySelectorAll('a[href]')) {
                let url;
                try { url = new URL(anchor.getAttribute('href'), location.href).href; }
                catch { continue; }
                if (!url.startsWith('http://') && !url.startsWith('https://')) continue;
                const image = anchor.querySelector('img') || anchor.closest('div')?.querySelector('img');
                const title = clean(anchor.innerText) || clean(image?.alt) || clean(anchor.getAttribute('aria-label'));
                if (!title || title.length < 3) continue;
                let card = null;
                for (const selector of selectors) {
                  card = anchor.closest(selector);
                  if (card) break;
                }
                card ||= anchor.parentElement;
                const text = clean(card?.innerText).slice(0, 600);
                const price = text.match(/(?:\$|£|€)\s?\d+(?:[,.]\d{2})?/)?.[0] || '';
                rows.push({
                  title: title.slice(0, 240),
                  url,
                  image: image?.currentSrc || image?.src || '',
                  price,
                  note: text.slice(0, 180)
                });
              }
              return rows.slice(0, 250);
            }
            """
        )
    except Exception:
        return []
    if not isinstance(raw, list):
        return []
    return _rank_dom_items(raw, task, page_url, max_results)


def _rank_dom_items(
    raw_items: list[Any],
    task: str,
    page_url: str,
    max_results: int,
) -> list[dict[str, Any]]:
    task_tokens = {
        token
        for token in re.findall(r"[a-z0-9]+", task.lower())
        if len(token) > 2
        and token not in {"find", "search", "look", "under", "with", "this", "that", "page"}
        and not token.isdigit()
    }
    max_price_match = re.search(r"(?:under|below|less than|max(?:imum)?)\s*\$?\s*(\d+(?:\.\d+)?)", task, re.I)
    max_price = float(max_price_match.group(1)) if max_price_match else None
    seen: set[str] = set()
    ranked: list[tuple[int, int, dict[str, Any]]] = []
    for index, raw in enumerate(raw_items):
        if not isinstance(raw, dict):
            continue
        url = raw.get("url")
        title = raw.get("title")
        if not isinstance(url, str) or not isinstance(title, str):
            continue
        absolute_url = urljoin(page_url, url)
        if absolute_url in seen or not _is_product_destination(
            absolute_url, page_url, allow_redirect=True
        ):
            continue
        seen.add(absolute_url)
        haystack = f"{title} {raw.get('note', '')}".lower()
        score = sum(3 if token in title.lower() else 1 for token in task_tokens if token in haystack)
        if task_tokens and score == 0:
            continue
        price = str(raw.get("price") or "")
        price_match = re.search(r"\d+(?:[,.]\d{2})?", price.replace(",", ""))
        if max_price is not None and price_match and float(price_match.group()) > max_price:
            continue
        item = {
            "title": title.strip(),
            "url": absolute_url,
            "image": str(raw.get("image") or ""),
            "price": price,
            "note": str(raw.get("note") or "")[:120],
        }
        ranked.append((score, -index, item))
    ranked.sort(key=lambda entry: (entry[0], entry[1]), reverse=True)
    return [item for _, _, item in ranked[:max_results]]


def _fast_shopping_search_url(start_url: str, task: str) -> str | None:
    """Turn a supported shop homepage into its results URL without an agent run."""
    parsed = urlparse(start_url)
    host = parsed.netloc.lower().split(":", 1)[0]
    if (parsed.path.rstrip("/") or "/") != "/" or parsed.query:
        return None
    query = re.sub(
        r"^(?:please\s+)?(?:find|search(?:\s+for)?|look\s+for|shop\s+for)\s+",
        "",
        task.strip(),
        flags=re.I,
    )
    query = re.sub(r"^(?:me\s+)?(?:one\s+)?(?:verified\s+)?(?:a|an|the)?\s*", "", query, flags=re.I)
    query = re.sub(
        r"\b(?:under|below|less\s+than|max(?:imum)?(?:\s+of)?)\s*\$?\s*\d+(?:\.\d+)?\b",
        "",
        query,
        flags=re.I,
    )
    query = re.sub(r"\b(?:on|from)\s+(?:this|the\s+current)\s+(?:page|site)\b", "", query, flags=re.I)
    query = " ".join(query.split()).strip(" .,-") or task.strip()
    encoded = quote_plus(query)
    origin = f"{parsed.scheme or 'https'}://{parsed.netloc}"
    if "amazon." in host:
        return f"{origin}/s?k={encoded}"
    if host.endswith("ebay.com") or ".ebay." in host:
        return f"{origin}/sch/i.html?_nkw={encoded}"
    if "walmart." in host:
        return f"{origin}/search?q={encoded}"
    if host.endswith("etsy.com") or ".etsy." in host:
        return f"{origin}/search?q={encoded}"
    return None


async def _navigate_with_agent_fallback(
    session: Any,
    start_url: str,
    settings: BrowserAgentSettings,
) -> None:
    """Use Stagehand's managed navigation, then its agent as the documented failsafe."""
    try:
        await session.navigate(url=start_url)
        return
    except Exception as navigation_error:
        try:
            await session.execute(
                execute_options={
                    "instruction": (
                        f"Navigate directly to {start_url}. Wait for the page to load and do "
                        "not leave this website."
                    ),
                    "max_steps": max(2, min(settings.max_steps, 4)),
                },
                agent_config={"model": settings.model},
            )
            return
        except Exception as agent_error:
            raise BrowserAgentError(
                "Browserbase could not navigate to the requested page after managed "
                f"Stagehand navigation and agent fallback: {navigation_error}; {agent_error}"
            ) from agent_error


async def _extract_items(
    session: Any,
    task: str,
    max_results: int,
    *,
    detail_page: bool = False,
) -> list[dict[str, Any]]:
    location_rule = (
        "The browser should now be on a product-detail page. Use that page's canonical "
        "absolute product URL."
        if detail_page
        else "Read the href from the anchor around each exact product title/card."
    )
    instruction = (
        f"Find the products on this page that best match: {task}. "
        f"Return up to {max_results} items, best matches first. "
        "Only include items actually present on the page. "
        f"{location_rule} "
        "The item URL MUST open that individual product's detail page. Never return the "
        "current search, category, home, or results URL. On Amazon, return a /dp/ or "
        "/gp/product/ URL (a sponsored redirect is acceptable only if it resolves there). "
        "Use absolute http(s) URLs for both the item link and the image."
    )
    response = await session.extract(instruction=instruction, schema=_ITEMS_SCHEMA)
    return _items_from_result(_response_result(response))


async def _click_best_candidate(
    session: Any,
    candidate: dict[str, Any],
    task: str,
) -> bool:
    """Open one named result with Stagehand's single-action fast path."""
    title = candidate.get("title")
    if not isinstance(title, str) or not title.strip() or not hasattr(session, "act"):
        return False
    instruction = (
        f"Click the product title/link {json.dumps(title.strip())} that best matches "
        f"{json.dumps(task.strip())}. Open its individual product-detail page, not a "
        "search, category, sponsored-results, or comparison page."
    )
    try:
        await session.act(input=instruction)
        return True
    except Exception:
        return False


async def _first_reachable_item(
    session: Any,
    candidates: list[dict[str, Any]],
    page_url: str,
) -> dict[str, Any] | None:
    """Return the first candidate whose destination succeeds in Browserbase."""
    for candidate in candidates:
        raw_url = candidate.get("url")
        if not isinstance(raw_url, str) or not raw_url.strip():
            continue
        url = urljoin(page_url, raw_url.strip())
        if urlparse(url).scheme not in {"http", "https"}:
            continue
        if not _is_product_destination(url, page_url, allow_redirect=True):
            continue

        try:
            response = await session.navigate(url=url)
        except Exception:
            # A destination we cannot load cannot be presented as verified.
            continue

        status, final_url = _navigation_response(response)
        if status is None or not 200 <= status < 400:
            continue
        destination = final_url or url
        if not _is_product_destination(destination, page_url):
            continue

        verified = dict(candidate)
        verified["url"] = _canonical_product_url(destination)
        return verified
    return None


def _is_product_destination(
    url: str,
    page_url: str,
    *,
    allow_redirect: bool = False,
) -> bool:
    """Reject home/search/listing URLs and require known shops' detail routes."""
    parsed = urlparse(url)
    source = urlparse(page_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return False

    canonical = urlunparse(parsed._replace(fragment=""))
    source_canonical = urlunparse(source._replace(fragment=""))
    if canonical == source_canonical:
        return False

    path = parsed.path.rstrip("/").lower() or "/"
    query_keys = {key.lower() for key in parse_qs(parsed.query)}
    if path == "/s" or any(marker in path for marker in _SEARCH_PATH_MARKERS):
        return False
    if path == "/" and query_keys & _SEARCH_QUERY_KEYS:
        return False

    host = parsed.netloc.lower().split(":", 1)[0]
    if "amazon." in host:
        if allow_redirect and path.startswith("/sspa/click"):
            return True
        return "/dp/" in path or "/gp/product/" in path
    if host.endswith("ebay.com") or ".ebay." in host:
        return "/itm/" in path
    if "walmart." in host:
        return "/ip/" in path
    if host.endswith("etsy.com") or ".etsy." in host:
        return "/listing/" in path
    return path != "/"


def _canonical_product_url(url: str) -> str:
    """Remove tracking noise when a stable product-detail route is known."""
    parsed = urlparse(url)
    host = parsed.netloc.lower().split(":", 1)[0]
    if "amazon." in host:
        match = re.search(r"/(?:dp|gp/product)/([A-Z0-9]{10})(?:[/?]|$)", parsed.path, re.I)
        if match:
            return urlunparse((parsed.scheme, parsed.netloc, f"/dp/{match.group(1)}", "", "", ""))
    return urlunparse(parsed._replace(fragment=""))


def _navigation_response(response: Any) -> tuple[int | None, str | None]:
    """Read the final HTTP status/URL from Stagehand's managed navigation result."""
    result = _response_result(response)
    navigation = result.get("response") if isinstance(result, dict) else None
    if not isinstance(navigation, dict):
        return None, None

    raw_status = navigation.get("status")
    status = raw_status if isinstance(raw_status, int) and not isinstance(raw_status, bool) else None
    raw_url = navigation.get("url")
    url = raw_url if isinstance(raw_url, str) and raw_url.startswith(("http://", "https://")) else None
    return status, url


async def _run_search_agent(session: Any, task: str, settings: BrowserAgentSettings) -> None:
    """Autonomous fallback: let the agent search/scroll to surface results."""
    instruction = (
        f"On this website, find products matching: {task}. "
        "If results are not visible, use the site's search box. Choose the best matching "
        "result, click its title, and STOP on that individual product-detail page. "
        "Do not stop on a search, category, comparison, or sponsored-results page. Stay "
        "on this site; do not navigate to a different website."
    )
    try:
        await session.execute(
            execute_options={
                "instruction": instruction,
                "max_steps": max(2, min(settings.max_steps, 4)),
            },
            agent_config={"model": settings.model},
        )
    except Exception:
        # Best-effort navigation; we still try to extract whatever is on the page.
        return


def _browserbase_session_params(
    settings: BrowserAgentSettings,
) -> dict[str, Any]:
    """Browserbase-native reliability and observability settings for every browse."""
    browser_settings: dict[str, Any] = {
        "block_ads": True,
        "solve_captchas": True,
        "log_session": True,
        "record_session": True,
    }
    if settings.verified:
        browser_settings["verified"] = True
    if settings.advanced_stealth:
        browser_settings["advanced_stealth"] = True

    params: dict[str, Any] = {
        "project_id": settings.browserbase_project_id,
        "proxies": settings.use_proxies,
        "timeout": 900,
        "browser_settings": browser_settings,
        "user_metadata": {
            "conjureFeature": "off-device-finder",
        },
    }
    if settings.region:
        params["region"] = settings.region
    return params


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
