import asyncio

import pytest

from backend.utils import browser_agent
from backend.utils.browser_agent import (
    BrowserAgentError,
    BrowserAgentSettings,
    _items_from_result,
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
        model_api_key="sk-ant-test",
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


def test_missing_requirement_flags_missing_model_key(monkeypatch):
    monkeypatch.setattr(browser_agent.importlib.util, "find_spec", lambda name: object())
    msg = missing_requirement(_ready_settings(model_api_key=None))
    assert msg and "model API key" in msg


# --- find_items_remote guards --------------------------------------------------

def test_find_items_remote_requires_start_url():
    with pytest.raises(BrowserAgentError):
        run(browser_agent.find_items_remote(task="jackets", settings=_ready_settings(), start_url=""))
