from fastapi.testclient import TestClient

from backend.main import app
import pytest

from backend.utils.agent import ConjureAgent
from backend.utils.config import Settings, load_settings


def test_health_endpoint_reports_ok():
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "conjure-backend"}


def test_effective_demo_mode_depends_on_selected_provider(tmp_path):
    assert not Settings(
        agent_provider="groq",
        groq_api_key="gsk_test",
        project_root=tmp_path,
    ).effective_demo_mode
    assert not Settings(
        agent_provider="claude",
        anthropic_api_key="sk-ant-test",
        project_root=tmp_path,
    ).effective_demo_mode
    assert not Settings(
        agent_provider="nemotron",
        nvidia_api_key="nvapi-test",
        project_root=tmp_path,
    ).effective_demo_mode
    assert Settings(
        agent_provider="groq",
        project_root=tmp_path,
    ).effective_demo_mode
    assert Settings(
        agent_provider="claude",
        project_root=tmp_path,
    ).effective_demo_mode
    assert Settings(
        agent_provider="nemotron",
        project_root=tmp_path,
    ).effective_demo_mode


def test_load_settings_reads_agent_provider_toggle(monkeypatch):
    monkeypatch.setenv("CONJURE_AGENT_PROVIDER", "nemotron")
    monkeypatch.setenv("NVIDIA_API_KEY", "nvapi-test")
    monkeypatch.setenv("NVIDIA_MODEL", "nvidia/nemotron-test")
    monkeypatch.setenv("NVIDIA_API_BASE_URL", "http://localhost:8000/v1")
    monkeypatch.setenv("CONJURE_DEMO_MODE", "false")

    settings = load_settings()

    assert settings.agent_provider == "nemotron"
    assert settings.nvidia_api_key == "nvapi-test"
    assert settings.nvidia_model == "nvidia/nemotron-test"
    assert settings.nvidia_api_base_url == "http://localhost:8000/v1"
    assert not settings.effective_demo_mode


def test_load_settings_defaults_to_groq(monkeypatch):
    monkeypatch.setenv("GROQ_API_KEY", "gsk_test")
    monkeypatch.setenv("GROQ_MODEL", "llama-3.3-70b-versatile")
    monkeypatch.delenv("CONJURE_AGENT_PROVIDER", raising=False)

    settings = load_settings()

    assert settings.agent_provider == "groq"
    assert settings.groq_api_key == "gsk_test"
    assert settings.groq_model == "llama-3.3-70b-versatile"


def test_demo_agent_streams_protocol_events_without_api_key(tmp_path):
    agent = ConjureAgent(
        Settings(
            demo_mode=True,
            project_root=tmp_path,
        )
    )

    events = list(
        agent.stream_chat_response_sync(
            query="Build a Chrome extension that hides YouTube Shorts.",
            project_id="project-123",
            conversation_id="conversation-123",
            active_tabs=[],
            pending_tab_requests={},
        )
    )

    assert events[0]["type"] == "content"
    assert "demo mode" in events[0]["content"]
    tool_start = next(e for e in events if e["type"] == "tool_start")
    assert tool_start["name"] == "create_file"
    assert events[-1] == {"type": "thinking"}


class FakeLocalToolLoopAgent(ConjureAgent):
    async def _stream_langchain_response(self, **kwargs):
        self.langchain_call = kwargs
        yield {"type": "tool_start", "name": "list_dir", "args": {"path": "."}}
        yield {"type": "tool_end", "name": "list_dir", "result": "{}"}
        yield {"type": "content", "content": "Local tool-loop change."}


def test_agent_uses_groq_tool_loop_when_provider_is_groq(tmp_path):
    agent = FakeLocalToolLoopAgent(
        Settings(
            agent_provider="groq",
            groq_api_key="gsk_test",
            project_root=tmp_path,
        ),
    )

    events = list(
        agent.stream_chat_response_sync(
            query="Build a Chrome extension.",
            project_id="project-123",
            conversation_id="conversation-123",
            active_tabs=[],
            pending_tab_requests={},
        )
    )

    assert [event["type"] for event in events] == [
        "agent_status",
        "tool_start",
        "tool_end",
        "content",
        "agent_status",
        "thinking",
    ]
    assert events[0]["provider"] == "groq"
    assert events[0]["phrase"] == "Groq is working..."
    assert events[4]["provider"] == "groq"
    assert events[4]["phrase"] == "Groq finished."


def test_agent_uses_claude_tool_loop_when_provider_is_claude(tmp_path):
    agent = FakeLocalToolLoopAgent(
        Settings(
            agent_provider="claude",
            anthropic_api_key="sk-ant-test",
            project_root=tmp_path,
        ),
    )

    events = list(
        agent.stream_chat_response_sync(
            query="Build a Chrome extension.",
            project_id="project-123",
            conversation_id="conversation-123",
            active_tabs=[],
            pending_tab_requests={},
        )
    )

    assert [event["type"] for event in events] == [
        "agent_status",
        "tool_start",
        "tool_end",
        "content",
        "agent_status",
        "thinking",
    ]
    assert events[0]["provider"] == "claude"
    assert events[0]["phrase"] == "Claude is working..."
    assert events[4]["provider"] == "claude"
    assert events[4]["phrase"] == "Claude finished."


def test_agent_uses_nemotron_tool_loop_when_provider_is_nemotron(tmp_path):
    agent = FakeLocalToolLoopAgent(
        Settings(
            agent_provider="nemotron",
            nvidia_api_key="nvapi-test",
            project_root=tmp_path,
        ),
    )

    events = list(
        agent.stream_chat_response_sync(
            query="Build a Chrome extension.",
            project_id="project-123",
            conversation_id="conversation-123",
            active_tabs=[],
            pending_tab_requests={},
        )
    )

    assert [event["type"] for event in events] == [
        "agent_status",
        "tool_start",
        "tool_end",
        "content",
        "agent_status",
        "thinking",
    ]
    assert events[0]["provider"] == "nemotron"
    assert events[0]["phrase"] == "Nemotron is working..."
    assert events[4]["provider"] == "nemotron"
    assert events[4]["phrase"] == "Nemotron finished."


def test_websocket_chat_emits_conversation_content_and_done():
    client = TestClient(app)

    with client.websocket_connect("/ws/project-123") as websocket:
        websocket.send_json(
            {
                "type": "chat",
                "query": "Create a minimal manifest for a tab customizer.",
                "active_tabs": [{"id": 1, "title": "Example", "url": "https://example.com"}],
            }
        )

        conversation = websocket.receive_json()
        events = []
        while True:
            event = websocket.receive_json()
            events.append(event)
            if event["type"] == "done":
                break

    assert conversation["type"] == "conversation_id"
    assert conversation["conversation_id"]
    content_events = [e for e in events if e["type"] == "content"]
    assert any("demo mode" in e["content"] for e in content_events)
    done = events[-1]
    assert done["type"] == "done"
    assert done["conversation_id"] == conversation["conversation_id"]


def test_websocket_reuses_supplied_conversation_id():
    client = TestClient(app)

    with client.websocket_connect("/ws/project-123") as websocket:
        websocket.send_json(
            {
                "type": "chat",
                "conversation_id": "conversation-existing",
                "query": "Continue the build.",
                "active_tabs": [],
            }
        )

        conversation = websocket.receive_json()
        while True:
            event = websocket.receive_json()
            if event["type"] == "done":
                break

    assert conversation == {
        "type": "conversation_id",
        "conversation_id": "conversation-existing",
    }
    assert event["conversation_id"] == "conversation-existing"


def test_websocket_rejects_malformed_chat_payload():
    client = TestClient(app)

    with client.websocket_connect("/ws/project-123") as websocket:
        websocket.send_json({"type": "chat", "active_tabs": []})

        error = websocket.receive_json()

    assert error["type"] == "error"
    assert "query" in error["message"]
