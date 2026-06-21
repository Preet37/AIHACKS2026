import asyncio
import json

import pytest

from backend.utils import agentspan_finder
from backend.utils.agentspan_finder import (
    AgentSpanError,
    AgentSpanSettings,
    missing_requirement,
    provider_env_var,
)


def run(coro):
    return asyncio.run(coro)


def _stub_agent_output(monkeypatch, value):
    """Replace the blocking AgentSpan run with a canned output."""
    monkeypatch.setattr(agentspan_finder, "_run_agent", lambda prompt, settings: value)


def test_find_items_parses_json_string_output(monkeypatch):
    _stub_agent_output(
        monkeypatch,
        json.dumps(
            {
                "items": [
                    {
                        "title": "Wool Jacket",
                        "url": "https://shop.test/jacket",
                        "image": "https://shop.test/jacket.jpg",
                        "price": "$120",
                        "note": "matches jackets",
                    }
                ]
            }
        ),
    )
    findings = run(
        agentspan_finder.find_items(
            task="find jackets",
            settings=AgentSpanSettings(),
            page_url="https://shop.test/search",
            page_html="<html>jackets</html>",
        )
    )
    assert findings == [
        {
            "title": "Wool Jacket",
            "url": "https://shop.test/jacket",
            "image": "https://shop.test/jacket.jpg",
            "price": "$120",
            "note": "matches jackets",
        }
    ]


def test_find_items_accepts_structured_dict_output(monkeypatch):
    _stub_agent_output(
        monkeypatch,
        {"items": [{"title": "Rain Jacket", "url": "https://t/1"}]},
    )
    findings = run(
        agentspan_finder.find_items(
            task="jackets", settings=AgentSpanSettings(), page_text="text"
        )
    )
    assert findings == [
        {"title": "Rain Jacket", "url": "https://t/1", "image": "", "price": "", "note": ""}
    ]


def test_find_items_resolves_relative_urls_against_page_url(monkeypatch):
    _stub_agent_output(
        monkeypatch,
        json.dumps({"items": [{"title": "Rain Jacket", "url": "/dp/123", "image": "/img/123.jpg"}]}),
    )
    findings = run(
        agentspan_finder.find_items(
            task="jackets",
            settings=AgentSpanSettings(),
            page_url="https://www.amazon.com/s?k=jackets",
            page_html="<html></html>",
        )
    )
    assert findings[0]["url"] == "https://www.amazon.com/dp/123"
    assert findings[0]["image"] == "https://www.amazon.com/img/123.jpg"


def test_find_items_recovers_json_wrapped_in_prose_and_caps_results(monkeypatch):
    wrapped = "Here you go:\n```json\n{\"items\": [" + ",".join(
        f'{{"title": "Item {i}", "url": "https://t/{i}"}}' for i in range(10)
    ) + "]}\n```"
    _stub_agent_output(monkeypatch, wrapped)
    findings = run(
        agentspan_finder.find_items(
            task="x", settings=AgentSpanSettings(max_results=3), page_html="<html></html>"
        )
    )
    assert len(findings) == 3
    assert findings[0]["title"] == "Item 0"


def test_find_items_skips_entries_missing_title_or_url(monkeypatch):
    _stub_agent_output(
        monkeypatch,
        json.dumps(
            {
                "items": [
                    {"title": "No URL"},
                    {"url": "https://t/2"},
                    {"title": "Good", "url": "https://t/3"},
                ]
            }
        ),
    )
    findings = run(
        agentspan_finder.find_items(task="x", settings=AgentSpanSettings(), page_text="text")
    )
    assert findings == [
        {"title": "Good", "url": "https://t/3", "image": "", "price": "", "note": ""}
    ]


def test_find_items_requires_page_content():
    with pytest.raises(AgentSpanError):
        run(agentspan_finder.find_items(task="x", settings=AgentSpanSettings()))


def test_find_items_raises_when_output_is_not_json(monkeypatch):
    _stub_agent_output(monkeypatch, "I could not find anything useful.")
    with pytest.raises(AgentSpanError):
        run(
            agentspan_finder.find_items(
                task="x", settings=AgentSpanSettings(), page_html="<html></html>"
            )
        )


class _FakeResult:
    def __init__(self, output, is_success=True):
        self.output = output
        self.is_success = is_success


def test_result_output_unwraps_agentspan_result_dict():
    # AgentResult.output is {"result": <text>, "finishReason": ...}.
    fake = _FakeResult({"result": '{"items": []}', "finishReason": "STOP"})
    assert agentspan_finder._result_output(fake) == '{"items": []}'


def test_result_output_passes_through_plain_text():
    assert agentspan_finder._result_output(_FakeResult("hello")) == "hello"


def test_provider_env_var_maps_known_providers():
    assert provider_env_var("anthropic/claude-sonnet-4-6") == "ANTHROPIC_API_KEY"
    assert provider_env_var("openai/gpt-4o") == "OPENAI_API_KEY"
    assert provider_env_var("gemini/gemini-2.0-flash") == "GOOGLE_API_KEY"
    assert provider_env_var("mystery/model") is None


def test_missing_requirement_flags_uninstalled_agentspan(monkeypatch):
    monkeypatch.setattr(agentspan_finder.importlib.util, "find_spec", lambda name: None)
    message = missing_requirement(AgentSpanSettings())
    assert message and "agentspan" in message


def test_missing_requirement_flags_missing_provider_key(monkeypatch):
    monkeypatch.setattr(agentspan_finder.importlib.util, "find_spec", lambda name: object())
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    message = missing_requirement(AgentSpanSettings(model="anthropic/claude-sonnet-4-6"))
    assert message == "ANTHROPIC_API_KEY is not set for model 'anthropic/claude-sonnet-4-6'"


def test_missing_requirement_passes_when_ready(monkeypatch):
    monkeypatch.setattr(agentspan_finder.importlib.util, "find_spec", lambda name: object())
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    assert missing_requirement(AgentSpanSettings(model="anthropic/claude-sonnet-4-6")) is None
