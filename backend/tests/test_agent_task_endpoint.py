from fastapi.testclient import TestClient

from backend.main import app
from backend.utils.agentspan_finder import AgentSpanError, AgentSpanSettings
from backend.utils.config import Settings


def _use_settings(monkeypatch, **overrides):
    monkeypatch.setattr("backend.main.load_settings", lambda: Settings(**overrides))


def _allow_agentspan(monkeypatch):
    monkeypatch.setattr("backend.main.agentspan_finder.missing_requirement", lambda settings: None)


def test_agent_task_returns_findings(monkeypatch):
    findings = [
        {"title": "Wool Jacket", "url": "https://shop/1", "image": "", "price": "$10", "note": ""}
    ]
    captured = {}

    async def fake_find_items(**kwargs):
        captured.update(kwargs)
        return findings

    _use_settings(monkeypatch, agentspan_model="anthropic/claude-sonnet-4-6")
    _allow_agentspan(monkeypatch)
    monkeypatch.setattr("backend.main.agentspan_finder.find_items", fake_find_items)

    client = TestClient(app)
    response = client.post(
        "/projects/demo/agent-task",
        json={"task": "jackets", "url": "https://shop/s", "text": "t", "html": "<html></html>"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body == {
        "project_id": "demo",
        "task": "jackets",
        "url": "https://shop/s",
        "findings": findings,
    }
    assert captured["task"] == "jackets"
    assert captured["page_url"] == "https://shop/s"
    assert captured["page_text"] == "t"
    assert captured["page_html"] == "<html></html>"
    assert isinstance(captured["settings"], AgentSpanSettings)
    assert captured["settings"].model == "anthropic/claude-sonnet-4-6"


def test_agent_task_requires_task(monkeypatch):
    _use_settings(monkeypatch)
    _allow_agentspan(monkeypatch)
    client = TestClient(app)
    response = client.post("/projects/demo/agent-task", json={"task": "   "})
    assert response.status_code == 400


def test_agent_task_returns_503_when_requirement_missing(monkeypatch):
    _use_settings(monkeypatch)
    monkeypatch.setattr(
        "backend.main.agentspan_finder.missing_requirement",
        lambda settings: "agentspan is not installed on the backend (pip install agentspan)",
    )
    client = TestClient(app)
    response = client.post("/projects/demo/agent-task", json={"task": "jackets"})
    assert response.status_code == 503
    assert "agentspan" in response.json()["detail"]


def test_agent_task_maps_agentspan_error_to_502(monkeypatch):
    async def fail_find_items(**kwargs):
        raise AgentSpanError("AgentSpan run failed: connection refused")

    _use_settings(monkeypatch)
    _allow_agentspan(monkeypatch)
    monkeypatch.setattr("backend.main.agentspan_finder.find_items", fail_find_items)

    client = TestClient(app)
    response = client.post(
        "/projects/demo/agent-task", json={"task": "jackets", "html": "<html></html>"}
    )
    assert response.status_code == 502
    assert "AgentSpan run failed" in response.json()["detail"]
