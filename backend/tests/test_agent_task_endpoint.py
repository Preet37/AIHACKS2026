from fastapi.testclient import TestClient

from backend.main import app
from backend.utils.browser_agent import BrowserAgentError, BrowserAgentSettings
from backend.utils.config import Settings


def _use_settings(monkeypatch, **overrides):
    base = dict(browserbase_api_key="bb_test", browserbase_project_id="proj", anthropic_api_key="sk-ant")
    base.update(overrides)
    monkeypatch.setattr("backend.main.load_settings", lambda: Settings(**base))


def _allow(monkeypatch):
    monkeypatch.setattr("backend.main.browser_agent.missing_requirement", lambda settings: None)


def test_agent_task_returns_findings_and_replay(monkeypatch):
    findings = [
        {"title": "Wool Jacket", "url": "https://shop/1", "image": "", "price": "$10", "note": ""}
    ]
    captured = {}

    async def fake_find(**kwargs):
        captured.update(kwargs)
        return {"findings": findings, "session_id": "bb_abc", "replay_url": "https://bb/sessions/bb_abc"}

    _use_settings(monkeypatch)
    _allow(monkeypatch)
    monkeypatch.setattr("backend.main.browser_agent.find_items_remote", fake_find)

    client = TestClient(app)
    response = client.post(
        "/projects/demo/agent-task",
        json={
            "task": "jackets",
            "url": "https://shop/s",
            "cookies": [{"name": "sid", "value": "x", "domain": "shop"}],
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "project_id": "demo",
        "task": "jackets",
        "url": "https://shop/s",
        "findings": findings,
        "session_id": "bb_abc",
        "replay_url": "https://bb/sessions/bb_abc",
    }
    assert captured["task"] == "jackets"
    assert captured["start_url"] == "https://shop/s"
    assert captured["cookies"] == [{"name": "sid", "value": "x", "domain": "shop"}]
    assert isinstance(captured["settings"], BrowserAgentSettings)
    assert captured["settings"].model_api_key == "sk-ant"


def test_agent_task_requires_task(monkeypatch):
    _use_settings(monkeypatch)
    _allow(monkeypatch)
    client = TestClient(app)
    response = client.post("/projects/demo/agent-task", json={"task": "   ", "url": "https://x"})
    assert response.status_code == 400


def test_agent_task_requires_url(monkeypatch):
    _use_settings(monkeypatch)
    _allow(monkeypatch)
    client = TestClient(app)
    response = client.post("/projects/demo/agent-task", json={"task": "jackets", "url": "  "})
    assert response.status_code == 400


def test_agent_task_returns_503_when_requirement_missing(monkeypatch):
    _use_settings(monkeypatch)
    monkeypatch.setattr(
        "backend.main.browser_agent.missing_requirement",
        lambda settings: "BROWSERBASE_API_KEY is not configured on the backend",
    )
    client = TestClient(app)
    response = client.post("/projects/demo/agent-task", json={"task": "jackets", "url": "https://x"})
    assert response.status_code == 503
    assert "BROWSERBASE_API_KEY" in response.json()["detail"]


def test_agent_task_maps_browser_error_to_502(monkeypatch):
    async def fail_find(**kwargs):
        raise BrowserAgentError("Off-device browse failed: boom")

    _use_settings(monkeypatch)
    _allow(monkeypatch)
    monkeypatch.setattr("backend.main.browser_agent.find_items_remote", fail_find)

    client = TestClient(app)
    response = client.post("/projects/demo/agent-task", json={"task": "jackets", "url": "https://x"})
    assert response.status_code == 502
    assert "Off-device browse failed" in response.json()["detail"]
