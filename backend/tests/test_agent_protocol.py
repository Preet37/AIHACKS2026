import asyncio

from fastapi.testclient import TestClient

from backend.main import (
    _agent_with_client_provider,
    _finish_provisional_mod,
    _looks_like_mod_request,
    app,
)
import pytest

from backend.utils import mods as mods_registry
from backend.utils import agent as agent_module
from backend.utils.agent import ConjureAgent
from backend.utils.config import Settings, load_settings
from backend.utils.tools import (
    project_dir_for,
    reset_tool_context,
    set_tool_context,
    start_mod,
)


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


def test_client_provider_switch_uses_backend_env_credentials(tmp_path):
    agent = ConjureAgent(
        Settings(
            agent_provider="claude",
            anthropic_api_key="sk-ant-env",
            groq_api_key="gsk-env",
            project_root=tmp_path,
        )
    )

    anthropic = _agent_with_client_provider(agent, {"provider": "anthropic"})
    groq = _agent_with_client_provider(agent, {"provider": "groq"})

    assert anthropic.settings.agent_provider == "claude"
    assert anthropic.settings.anthropic_api_key == "sk-ant-env"
    assert groq.settings.agent_provider == "groq"
    assert groq.settings.groq_api_key == "gsk-env"


def test_client_provider_switch_rejects_missing_backend_key(tmp_path):
    agent = ConjureAgent(Settings(anthropic_api_key="sk-ant-env", project_root=tmp_path))

    with pytest.raises(ValueError, match="GROQ_API_KEY"):
        _agent_with_client_provider(agent, {"provider": "groq"})


def test_short_ui_change_is_recognized_as_mod_request():
    assert _looks_like_mod_request("make bg red")
    assert _looks_like_mod_request("hide the timer")
    assert not _looks_like_mod_request("what is on this page?")
    assert not _looks_like_mod_request("summarize this article")


def test_provisional_mod_is_scoped_to_active_tab(tmp_path):
    record = mods_registry.create_mod(tmp_path, prompt="make bg red", name="Red background")
    directory = mods_registry.mod_dir(tmp_path, record["id"])
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "manifest.json").write_text(
        '{"manifest_version":3,"name":"Red","version":"1.0.0",'
        '"content_scripts":[{"matches":["<all_urls>"],"js":["content.js"]}]}',
        encoding="utf-8",
    )
    (directory / "content.js").write_text(
        'document.documentElement.style.background = "red";', encoding="utf-8"
    )

    kept = _finish_provisional_mod(
        tmp_path,
        record["id"],
        keep=True,
        current_tab_url="https://arithmetic.zetamac.com/game?key=1",
    )

    assert kept
    saved = mods_registry.get_mod(tmp_path, record["id"])
    assert saved is not None
    assert saved["status"] == "active"
    assert saved["scope_mode"] == "current_tab"
    bundle = mods_registry.mod_bundle(tmp_path, record["id"])
    assert bundle is not None
    assert bundle["matches"] == ["https://arithmetic.zetamac.com/*"]


def test_groq_prose_only_build_is_retried_with_tools(monkeypatch, tmp_path):
    settings = Settings(agent_provider="groq", groq_api_key="gsk-test", project_root=tmp_path)
    project_dir = project_dir_for(settings, "project-123")
    record = mods_registry.create_mod(project_dir, prompt="make bg red", name="Red background")

    class FakeChunk:
        def __init__(self, content="", tool_calls=None):
            self.content = content
            self.text = content
            self.tool_calls = tool_calls or []

    class FakeGroqModel:
        calls = 0

        async def astream(self, _messages):
            self.calls += 1
            if self.calls == 1:
                yield FakeChunk("Done! Refresh to see the red background.")
            elif self.calls == 2:
                yield FakeChunk(
                    tool_calls=[
                        {
                            "id": "manifest",
                            "name": "write_file",
                            "args": {
                                "path": "manifest.json",
                                "content": '{"manifest_version":3,"name":"Red","version":"1.0.0",'
                                '"content_scripts":[{"matches":["<all_urls>"],"js":["content.js"]}]}',
                            },
                        },
                        {
                            "id": "script",
                            "name": "write_file",
                            "args": {
                                "path": "content.js",
                                "content": 'document.body.style.background = "red";',
                            },
                        },
                    ]
                )
            else:
                yield FakeChunk("The mod is now active.")

    model = FakeGroqModel()
    monkeypatch.setattr(agent_module, "_build_llm", lambda *_args, **_kwargs: model)
    monkeypatch.setattr(agent_module, "get_langchain_tools", lambda: [object()])

    agent = ConjureAgent(settings)
    events = list(
        agent.stream_chat_response_sync(
            query="make bg red",
            project_id="project-123",
            conversation_id="conversation-123",
            active_tabs=[],
            pending_tab_requests={},
            active_mod_id=record["id"],
        )
    )

    assert model.calls == 3
    assert any(event.get("type") == "tool_start" for event in events)
    assert not any("Refresh to see" in event.get("content", "") for event in events)
    assert any("now active" in event.get("content", "") for event in events)
    assert mods_registry.mod_bundle(project_dir, record["id"]) is not None


def test_start_mod_reuses_active_provisional(tmp_path):
    settings = Settings(project_root=tmp_path)
    project_dir = project_dir_for(settings, "project-123")
    provisional = mods_registry.create_mod(
        project_dir, prompt="make bg rainbow", name="Rainbow background"
    )
    active_dir = mods_registry.mod_dir(project_dir, provisional["id"])
    tokens = set_tool_context(
        outbound_queue=None,
        pending_tab_requests=None,
        project_dir=project_dir,
        settings=settings,
        active_mod_dir=active_dir,
    )
    try:
        result = asyncio.run(start_mod(prompt="animated rainbow", name="Rainbow Background"))
    finally:
        reset_tool_context(tokens)

    assert provisional["id"] in result
    records = mods_registry.list_mods(project_dir)
    assert len(records) == 1
    assert records[0]["id"] == provisional["id"]


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
