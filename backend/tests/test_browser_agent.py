import asyncio
from types import SimpleNamespace

import pytest

from backend.utils import browser_agent
from backend.utils.browser_agent import (
    BrowserAgentError,
    BrowserAgentSettings,
    _browserbase_session_params,
    _drive_session,
    _first_reachable_item,
    _fast_shopping_search_url,
    _is_product_destination,
    _items_from_result,
    _navigation_response,
    _navigate_with_agent_fallback,
    _rank_dom_items,
    _response_result,
    _to_playwright_cookies,
    missing_requirement,
)


def run(coro):
    return asyncio.run(coro)


def _ready_settings(**overrides):
    base = dict(
        browserbase_api_key="bb_test",
        browserbase_project_id="proj_test",
        model="anthropic/claude-sonnet-4-6",
    )
    base.update(overrides)
    return BrowserAgentSettings(**base)


# --- cookie mapping (chrome -> playwright) -------------------------------------

def test_cookie_mapping_basic_fields_and_expiry():
    chrome = [
        {
            "name": "sid",
            "value": "abc",
            "domain": ".amazon.com",
            "path": "/",
            "secure": True,
            "httpOnly": True,
            "sameSite": "lax",
            "expirationDate": 1999999999.5,
        }
    ]
    out = _to_playwright_cookies(chrome)
    assert out == [
        {
            "name": "sid",
            "value": "abc",
            "domain": ".amazon.com",
            "path": "/",
            "httpOnly": True,
            "secure": True,
            "expires": 1999999999.5,
            "sameSite": "Lax",
        }
    ]


def test_cookie_mapping_session_cookie_omits_expiry():
    out = _to_playwright_cookies(
        [{"name": "s", "value": "1", "domain": "x.com", "session": True, "expirationDate": 123}]
    )
    assert "expires" not in out[0]


def test_cookie_mapping_samesite_none_forces_secure():
    out = _to_playwright_cookies(
        [{"name": "s", "value": "1", "domain": "x.com", "sameSite": "no_restriction", "secure": False}]
    )
    assert out[0]["sameSite"] == "None"
    assert out[0]["secure"] is True


def test_cookie_mapping_skips_malformed_entries():
    out = _to_playwright_cookies(
        [
            {"value": "novalue-name", "domain": "x.com"},  # no name
            {"name": "nodomain", "value": "v"},  # no domain
            "not-a-dict",
            {"name": "ok", "value": "v", "domain": "x.com"},
        ]
    )
    assert [c["name"] for c in out] == ["ok"]
    assert out[0]["path"] == "/"  # default path


# --- result parsing ------------------------------------------------------------

def test_items_from_result_handles_object_list_and_garbage():
    assert _items_from_result({"items": [{"title": "a"}, "skip", {"title": "b"}]}) == [
        {"title": "a"},
        {"title": "b"},
    ]
    assert _items_from_result([{"title": "a"}, 5]) == [{"title": "a"}]
    assert _items_from_result("nope") == []
    assert _items_from_result({"nope": 1}) == []


def test_response_result_unwraps_stagehand_shape():
    class Data:
        result = {"items": [{"title": "x", "url": "https://x/1"}]}

    class Resp:
        data = Data()

    assert _response_result(Resp()) == {"items": [{"title": "x", "url": "https://x/1"}]}
    assert _response_result({"data": {"result": {"items": []}}}) == {"items": []}


# --- missing_requirement -------------------------------------------------------

def test_missing_requirement_passes_when_ready(monkeypatch):
    monkeypatch.setattr(browser_agent.importlib.util, "find_spec", lambda name: object())
    assert missing_requirement(_ready_settings()) is None


def test_missing_requirement_flags_uninstalled_stagehand(monkeypatch):
    monkeypatch.setattr(
        browser_agent.importlib.util, "find_spec", lambda name: None if name == "stagehand" else object()
    )
    msg = missing_requirement(_ready_settings())
    assert msg and "stagehand" in msg


def test_missing_requirement_flags_missing_browserbase_key(monkeypatch):
    monkeypatch.setattr(browser_agent.importlib.util, "find_spec", lambda name: object())
    msg = missing_requirement(_ready_settings(browserbase_api_key=None))
    assert msg == "BROWSERBASE_API_KEY is not configured on the backend"


# --- find_items_remote guards --------------------------------------------------

def test_find_items_remote_requires_start_url():
    with pytest.raises(BrowserAgentError):
        run(browser_agent.find_items_remote(task="jackets", settings=_ready_settings(), start_url=""))


# --- Browserbase-managed session flow -----------------------------------------

def test_browserbase_session_params_enable_managed_reliability_features():
    params = _browserbase_session_params(
        _ready_settings(
            region="us-west-2",
            use_proxies=True,
            verified=True,
            advanced_stealth=True,
        ),
    )

    assert params["project_id"] == "proj_test"
    assert params["proxies"] is True
    assert params["region"] == "us-west-2"
    assert params["timeout"] == 900
    assert params["browser_settings"] == {
        "block_ads": True,
        "solve_captchas": True,
        "log_session": True,
        "record_session": True,
        "verified": True,
        "advanced_stealth": True,
    }
    assert params["user_metadata"]["conjureFeature"] == "off-device-finder"
    assert "task" not in params["user_metadata"]


def test_navigation_uses_stagehand_agent_fallback():
    class Session:
        def __init__(self):
            self.calls = []

        async def navigate(self, **kwargs):
            self.calls.append(("navigate", kwargs))
            raise RuntimeError("ERR_HTTP2_PROTOCOL_ERROR")

        async def execute(self, **kwargs):
            self.calls.append(("execute", kwargs))

    session = Session()
    run(_navigate_with_agent_fallback(session, "https://books.toscrape.com/", _ready_settings()))

    assert [name for name, _ in session.calls] == ["navigate", "execute"]
    assert session.calls[0][1] == {"url": "https://books.toscrape.com/"}
    assert "Navigate directly" in session.calls[1][1]["execute_options"]["instruction"]


def test_navigation_reports_both_managed_failures():
    class Session:
        async def navigate(self, **kwargs):
            raise RuntimeError("navigation failed")

        async def execute(self, **kwargs):
            raise RuntimeError("agent failed")

    with pytest.raises(BrowserAgentError, match="managed Stagehand navigation and agent fallback"):
        run(_navigate_with_agent_fallback(Session(), "https://example.com", _ready_settings()))


def test_drive_session_uses_playwright_only_for_cookie_injection():
    events = []

    class Context:
        async def add_cookies(self, cookies):
            events.append(("cookies", cookies))

    class Browser:
        contexts = [Context()]

        async def close(self):
            events.append(("browser_close", None))

    class Chromium:
        async def connect_over_cdp(self, cdp_url):
            events.append(("connect", cdp_url))
            return Browser()

    class Playwright:
        chromium = Chromium()

    class PlaywrightContextManager:
        async def __aenter__(self):
            return Playwright()

        async def __aexit__(self, *args):
            return None

    class Session:
        async def navigate(self, **kwargs):
            events.append(("navigate", kwargs))
            return {
                "data": {
                    "result": {
                        "response": {"status": 200, "url": kwargs["url"]},
                    }
                }
            }

        async def extract(self, **kwargs):
            assert "page" not in kwargs
            events.append(("extract", kwargs))
            return {"data": {"result": {"items": [{"title": "Book", "url": "https://x/item/1"}]}}}

    items = run(
        _drive_session(
            session=Session(),
            cdp_url="wss://browserbase.test",
            start_url="https://books.toscrape.com/",
            task="books under £20",
            settings=_ready_settings(),
            playwright_cookies=[{"name": "currency", "value": "GBP", "domain": ".toscrape.com"}],
            async_playwright=lambda: PlaywrightContextManager(),
        )
    )

    assert items == [{"title": "Book", "url": "https://x/item/1"}]
    assert events[0] == ("connect", "wss://browserbase.test")
    assert events[1][0] == "cookies"
    assert events[2] == ("navigate", {"url": "https://books.toscrape.com/"})
    assert ("navigate", {"url": "https://x/item/1"}) in events
    assert events[-1][0] == "browser_close"


def test_drive_session_skips_playwright_when_there_are_no_cookies():
    class Session:
        async def navigate(self, **kwargs):
            return {
                "data": {
                    "result": {
                        "response": {"status": 200, "url": kwargs["url"]},
                    }
                }
            }

        async def extract(self, **kwargs):
            return {"data": {"result": {"items": [{"title": "Book", "url": "https://x/item/1"}]}}}

    def unexpected_playwright():
        raise AssertionError("Playwright should not open for a public, cookieless browse")

    items = run(
        _drive_session(
            session=Session(),
            cdp_url=None,
            start_url="https://books.toscrape.com/",
            task="books under £20",
            settings=_ready_settings(),
            playwright_cookies=[],
            async_playwright=unexpected_playwright,
        )
    )

    assert items == [{"title": "Book", "url": "https://x/item/1"}]


def test_navigation_response_reads_browserbase_status_and_final_url():
    response = {
        "data": {
            "result": {
                "response": {
                    "status": 200,
                    "url": "https://shop.test/final",
                }
            }
        }
    }
    assert _navigation_response(response) == (200, "https://shop.test/final")
    assert _navigation_response({"data": {"result": None}}) == (None, None)


def test_first_reachable_item_skips_404_and_returns_exactly_one_verified_link():
    class Session:
        def __init__(self):
            self.urls = []

        async def navigate(self, **kwargs):
            url = kwargs["url"]
            self.urls.append(url)
            status = 404 if url.endswith("/missing") else 200
            return {
                "data": {
                    "result": {
                        "response": {"status": status, "url": url},
                    }
                }
            }

    session = Session()
    result = run(
        _first_reachable_item(
            session,
            [
                {"title": "Broken", "url": "/missing"},
                {"title": "Works", "url": "/working"},
                {"title": "Also works", "url": "/unused"},
            ],
            "https://shop.test/search",
        )
    )

    assert result == {"title": "Works", "url": "https://shop.test/working"}
    assert session.urls == ["https://shop.test/missing", "https://shop.test/working"]


def test_first_reachable_item_rejects_failed_and_unverifiable_destinations():
    class Session:
        async def navigate(self, **kwargs):
            if kwargs["url"].endswith("/error"):
                raise RuntimeError("navigation failed")
            return {"data": {"result": {"response": {"status": 500, "url": kwargs["url"]}}}}

    result = run(
        _first_reachable_item(
            Session(),
            [
                {"title": "Bad scheme", "url": "javascript:alert(1)"},
                {"title": "Error", "url": "/error"},
                {"title": "Server error", "url": "/500"},
            ],
            "https://shop.test/",
        )
    )

    assert result is None


def test_product_destination_rejects_search_pages_and_requires_amazon_detail_route():
    source = "https://www.amazon.com/s?k=jacket"
    assert not _is_product_destination("https://www.amazon.com/?s=jacket", source)
    assert not _is_product_destination("https://www.amazon.com/s?k=jacket", source)
    assert not _is_product_destination("https://www.amazon.com/b?node=123", source)
    assert _is_product_destination(
        "https://www.amazon.com/Columbia-Watertight-Jacket/dp/B00HNQUR4O",
        source,
    )
    assert _is_product_destination(
        "https://www.amazon.com/sspa/click?url=%2Fdp%2FB00HNQUR4O",
        source,
        allow_redirect=True,
    )


def test_drive_session_clicks_named_result_instead_of_returning_search_url():
    events = []

    class Session:
        extracted_detail = False

        async def navigate(self, **kwargs):
            events.append(("navigate", kwargs["url"]))
            return {
                "data": {
                    "result": {
                        "response": {"status": 200, "url": kwargs["url"]},
                    }
                }
            }

        async def extract(self, **kwargs):
            events.append(("extract", kwargs["instruction"]))
            if self.extracted_detail:
                item_url = "https://www.amazon.com/Columbia-Watertight/dp/B00HNQUR4O"
            else:
                item_url = "https://www.amazon.com/?s=jacket"
            return {
                "data": {
                    "result": {
                        "items": [
                            {
                                "title": "Columbia Watertight II Jacket",
                                "url": item_url,
                                "price": "$67.49",
                            }
                        ]
                    }
                }
            }

        async def act(self, **kwargs):
            events.append(("act", kwargs["input"]))
            self.extracted_detail = True

        async def execute(self, **kwargs):
            raise AssertionError("The slower autonomous agent should not run")

    items = run(
        _drive_session(
            session=Session(),
            cdp_url=None,
            start_url="https://www.amazon.com/?s=jacket",
            task="find a jacket under $100",
            settings=_ready_settings(),
            playwright_cookies=[],
            async_playwright=lambda: None,
        )
    )

    assert items[0]["url"] == "https://www.amazon.com/dp/B00HNQUR4O"
    assert [event[0] for event in events] == ["navigate", "extract", "act", "extract", "navigate"]
    assert "Columbia Watertight II Jacket" in events[2][1]


def test_gmail_send_uses_observed_structured_stagehand_action():
    events = []

    class Action:
        method = "click"
        description = "Blue Send button"

        def to_dict(self, **kwargs):
            assert kwargs == {"exclude_none": True}
            return {
                "method": "click",
                "description": self.description,
                "selector": "xpath=//div[@role='button' and text()='Send']",
                "arguments": [],
            }

    class Session:
        async def observe(self, **kwargs):
            assert kwargs["page"].ready
            events.append(("observe", kwargs["page"], kwargs["options"]["timeout"]))
            return SimpleNamespace(
                success=True,
                data=SimpleNamespace(result=[Action()]),
            )

        async def act(self, **kwargs):
            events.append(("act", kwargs["page"], kwargs["input"]["method"]))
            return SimpleNamespace(
                success=True,
                data=SimpleNamespace(result=SimpleNamespace(success=True, message="clicked")),
            )

    class Toast:
        @property
        def first(self):
            return self

        async def wait_for(self, **kwargs):
            events.append(("confirmation", kwargs["timeout"]))

    class Page:
        ready = False

        async def wait_for_load_state(self, state, **kwargs):
            assert state == "load"
            self.ready = True
            events.append(("load", kwargs["timeout"]))

        def locator(self, selector):
            assert 'data-tooltip^="Send"' in selector
            return ReadyLocator()

        def get_by_text(self, pattern):
            return Toast()

        async def wait_for_timeout(self, timeout):
            events.append(("settle", timeout))

    class ReadyLocator:
        @property
        def first(self):
            return self

        async def wait_for(self, **kwargs):
            events.append(("send-ready", kwargs["timeout"]))

    page = Page()
    run(browser_agent._wait_for_gmail_composer(page))
    run(browser_agent._click_gmail_send(Session(), page))

    assert events == [
        ("load", browser_agent.GMAIL_LOAD_TIMEOUT_MS),
        ("send-ready", browser_agent.GMAIL_SEND_READY_TIMEOUT_MS),
        ("settle", 300),
        ("observe", page, browser_agent.GMAIL_OBSERVE_TIMEOUT_MS),
        ("act", page, "click"),
        ("confirmation", browser_agent.GMAIL_CONFIRM_TIMEOUT_MS),
    ]


def test_dom_fast_path_ranks_matching_detail_links_and_honors_price_limit():
    items = _rank_dom_items(
        [
            {
                "title": "Unrelated boots",
                "url": "https://www.amazon.com/dp/B000000001",
                "price": "$40.00",
                "note": "boots",
            },
            {
                "title": "Expensive Columbia jacket",
                "url": "https://www.amazon.com/dp/B000000002",
                "price": "$140.00",
                "note": "rain jacket",
            },
            {
                "title": "Columbia Watertight II Jacket",
                "url": "https://www.amazon.com/Columbia/dp/B000000003?ref=search",
                "price": "$67.49",
                "note": "rain jacket, 4.7 stars",
            },
            {
                "title": "Search jackets",
                "url": "https://www.amazon.com/?s=jacket",
                "price": "",
                "note": "search results",
            },
        ],
        "find a jacket under $100",
        "https://www.amazon.com/s?k=jacket",
        3,
    )

    assert [item["title"] for item in items] == ["Columbia Watertight II Jacket"]


def test_fast_shopping_search_url_skips_agent_on_supported_homepages():
    assert _fast_shopping_search_url(
        "https://www.amazon.com/",
        "Find one verified jacket under $100 on this page",
    ) == "https://www.amazon.com/s?k=jacket"
    assert _fast_shopping_search_url(
        "https://www.ebay.com",
        "search for mechanical keyboard",
    ) == "https://www.ebay.com/sch/i.html?_nkw=mechanical+keyboard"
    assert _fast_shopping_search_url(
        "https://www.amazon.com/dp/B00HNQUR4O",
        "find a jacket",
    ) is None


def test_drive_session_uses_browserbase_dom_before_stagehand_extract():
    events = []

    class Page:
        async def evaluate(self, script):
            events.append("dom")
            assert "document.querySelectorAll" in script
            return [
                {
                    "title": "Columbia Watertight II Jacket",
                    "url": "https://www.amazon.com/Columbia/dp/B00HNQUR4O",
                    "price": "$67.49",
                    "note": "rain jacket",
                }
            ]

    class Context:
        pages = [Page()]

        async def add_cookies(self, cookies):
            raise AssertionError("No cookies should be injected")

    class Browser:
        contexts = [Context()]

        async def close(self):
            events.append("close")

    class Chromium:
        async def connect_over_cdp(self, cdp_url):
            events.append("connect")
            return Browser()

    class Playwright:
        chromium = Chromium()

    class PlaywrightContextManager:
        async def __aenter__(self):
            return Playwright()

        async def __aexit__(self, *args):
            return None

    class Session:
        async def navigate(self, **kwargs):
            events.append("navigate")
            return {
                "data": {
                    "result": {"response": {"status": 200, "url": kwargs["url"]}}
                }
            }

        async def extract(self, **kwargs):
            raise AssertionError("Stagehand extract should be skipped on the DOM fast path")

    items = run(
        _drive_session(
            session=Session(),
            cdp_url="wss://browserbase.test",
            start_url="https://www.amazon.com/s?k=jacket",
            task="find a jacket under $100",
            settings=_ready_settings(),
            playwright_cookies=[],
            async_playwright=lambda: PlaywrightContextManager(),
        )
    )

    assert items[0]["url"] == "https://www.amazon.com/dp/B00HNQUR4O"
    assert events == ["connect", "navigate", "dom", "navigate", "close"]
