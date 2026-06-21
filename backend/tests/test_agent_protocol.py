from fastapi.testclient import TestClient

from backend.main import app
import pytest

from backend.utils.agent import ConjureAgent
from backend.utils.config import Settings, load_settings
from backend.utils.store import InMemoryStore


def test_health_endpoint_reports_ok():
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "conjure-backend"}


def test_effective_demo_mode_depends_on_selected_provider(tmp_path):
    assert not Settings(
        agent_provider="devin",
        devin_api_key="cog_test",
        devin_org_id="org-123",
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
        agent_provider="claude",
        devin_api_key="cog_test",
        devin_org_id="org-123",
        project_root=tmp_path,
    ).effective_demo_mode
    assert Settings(
        agent_provider="nemotron",
        devin_api_key="cog_test",
        devin_org_id="org-123",
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
    assert events[1]["type"] == "agent_status"
    assert events[1]["provider"] == "devin"
    assert events[1]["phrase"] == "Devin is working..."
    assert events[2]["type"] == "agent_status"
    assert events[2]["provider"] == "devin"
    assert events[2]["phrase"] == "Devin finished."
    assert events[3]["type"] == "content"
    assert "Devin finished." in events[3]["content"]
    assert events[-1] == {"type": "thinking"}


def test_nemotron_demo_agent_streams_provider_status_without_api_key(tmp_path):
    agent = ConjureAgent(
        Settings(
            agent_provider="nemotron",
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
    assert "Nemotron credentials" in events[0]["content"]
    assert events[1]["type"] == "agent_status"
    assert events[1]["provider"] == "nemotron"
    assert events[1]["phrase"] == "Nemotron is working..."
    assert events[2]["type"] == "agent_status"
    assert events[2]["provider"] == "nemotron"
    assert events[2]["phrase"] == "Nemotron finished."
    assert events[3]["type"] == "content"
    assert "Nemotron finished." in events[3]["content"]
    assert events[-1] == {"type": "thinking"}


class FakeDevinClient:
    def __init__(self, responses):
        self.responses = list(responses)
        self.created = []
        self.messages = []
        self.gets = []

    async def create_session(self, *, prompt, title, tags):
        self.created.append({"prompt": prompt, "title": title, "tags": tags})
        return self.responses.pop(0)

    async def send_message(self, devin_id, message):
        self.messages.append({"devin_id": devin_id, "message": message})
        return self.responses.pop(0)

    async def get_session(self, devin_id):
        self.gets.append(devin_id)
        return self.responses.pop(0)


class FakeLocalToolLoopAgent(ConjureAgent):
    async def _stream_langchain_response(self, **kwargs):
        self.langchain_call = kwargs
        yield {"type": "tool_start", "name": "list_dir", "args": {"path": "."}}
        yield {"type": "tool_end", "name": "list_dir", "result": "{}"}
        yield {"type": "content", "content": "Local tool-loop change."}


def test_agent_creates_devin_session_and_streams_status(tmp_path):
    store = InMemoryStore()
    client = FakeDevinClient(
        [
            {
                "session_id": "devin-123",
                "url": "https://app.devin.ai/sessions/devin-123",
                "status": "running",
                "status_detail": "working",
                "pull_requests": [],
            },
            {
                "session_id": "devin-123",
                "url": "https://app.devin.ai/sessions/devin-123",
                "status": "exit",
                "status_detail": "finished",
                "pull_requests": [{"pr_url": "https://github.com/Preet37/AIHACKS2026/pull/1"}],
            },
        ]
    )
    agent = ConjureAgent(
        Settings(
            devin_api_key="cog_test",
            devin_org_id="org-123",
            devin_poll_interval_seconds=0,
            project_root=tmp_path,
        ),
        devin_client=client,
        store=store,
    )

    events = list(
        agent.stream_chat_response_sync(
            query="Build a Chrome extension that hides YouTube Shorts.",
            project_id="project-123",
            conversation_id="conversation-123",
            active_tabs=[{"id": 1, "title": "Example", "url": "https://example.com", "active": True}],
            pending_tab_requests={},
        )
    )

    assert client.created
    assert "Repo: Preet37/AIHACKS2026" in client.created[0]["prompt"]
    assert "Branch: feat/Devin" in client.created[0]["prompt"]
    assert "Build a Chrome extension that hides YouTube Shorts." in client.created[0]["prompt"]
    assert client.created[0]["tags"] == ("conjure", "project-123")
    assert [event["type"] for event in events] == [
        "agent_status",
        "content",
        "agent_status",
        "content",
        "thinking",
    ]
    assert events[0]["provider"] == "devin"
    assert events[0]["phrase"] == "Devin is working..."
    assert events[2]["provider"] == "devin"
    assert events[2]["phrase"] == "Devin finished."
    assert "https://github.com/Preet37/AIHACKS2026/pull/1" in events[3]["content"]


def test_agent_uses_claude_tool_loop_when_provider_is_claude(tmp_path):
    client = FakeDevinClient([])
    agent = FakeLocalToolLoopAgent(
        Settings(
            agent_provider="claude",
            anthropic_api_key="sk-ant-test",
            devin_api_key="cog_test",
            devin_org_id="org-123",
            project_root=tmp_path,
        ),
        devin_client=client,
        store=InMemoryStore(),
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

    assert client.created == []
    assert agent.langchain_call["provider"] == "claude"
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
    client = FakeDevinClient([])
    agent = FakeLocalToolLoopAgent(
        Settings(
            agent_provider="nemotron",
            nvidia_api_key="nvapi-test",
            devin_api_key="cog_test",
            devin_org_id="org-123",
            project_root=tmp_path,
        ),
        devin_client=client,
        store=InMemoryStore(),
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

    assert client.created == []
    assert agent.langchain_call["provider"] == "nemotron"
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


def test_agent_reuses_devin_session_for_followup(tmp_path):
    async def scenario():
        store = InMemoryStore()
        await store.set_devin_session(
            "conversation-123",
            project_id="project-123",
            devin_session_id="devin-123",
            devin_url="https://app.devin.ai/sessions/devin-123",
            status="running",
            status_detail="working",
        )
        client = FakeDevinClient(
            [
                {
                    "session_id": "devin-123",
                    "url": "https://app.devin.ai/sessions/devin-123",
                    "status": "exit",
                    "status_detail": "finished",
                    "pull_requests": [],
                },
            ]
        )
        agent = ConjureAgent(
            Settings(
                devin_api_key="cog_test",
                devin_org_id="org-123",
                devin_poll_interval_seconds=0,
                project_root=tmp_path,
            ),
            devin_client=client,
            store=store,
        )

        events = [
            event
            async for event in agent.stream_chat_response(
                query="Keep going.",
                project_id="project-123",
                conversation_id="conversation-123",
                active_tabs=[],
                pending_tab_requests={},
            )
        ]

        assert client.created == []
        assert client.messages == [{"devin_id": "devin-123", "message": "Keep going."}]
        assert events[0]["phrase"] == "Devin finished."

    import asyncio

    asyncio.run(scenario())


def test_agent_raises_when_devin_waits_for_approval(tmp_path):
    agent = ConjureAgent(
        Settings(
            devin_api_key="cog_test",
            devin_org_id="org-123",
            devin_poll_interval_seconds=0,
            project_root=tmp_path,
        ),
        devin_client=FakeDevinClient(
            [
                {
                    "session_id": "devin-123",
                    "url": "https://app.devin.ai/sessions/devin-123",
                    "status": "running",
                    "status_detail": "waiting_for_approval",
                    "pull_requests": [],
                }
            ]
        ),
        store=InMemoryStore(),
    )

    with pytest.raises(RuntimeError, match="blocked by approval settings"):
        list(
            agent.stream_chat_response_sync(
                query="Build it.",
                project_id="project-123",
                conversation_id="conversation-123",
                active_tabs=[],
                pending_tab_requests={},
            )
        )


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
        content = websocket.receive_json()
        running_status = websocket.receive_json()
        finished_status = websocket.receive_json()
        final_content = websocket.receive_json()
        thinking = websocket.receive_json()
        done = websocket.receive_json()

    assert conversation["type"] == "conversation_id"
    assert conversation["conversation_id"]
    assert content["type"] == "content"
    assert "demo mode" in content["content"]
    assert running_status["type"] == "agent_status"
    assert running_status["provider"] == "devin"
    assert running_status["phrase"] == "Devin is working..."
    assert finished_status["type"] == "agent_status"
    assert finished_status["provider"] == "devin"
    assert finished_status["phrase"] == "Devin finished."
    assert final_content["type"] == "content"
    assert "Devin finished." in final_content["content"]
    assert thinking == {"type": "thinking"}
    assert done["type"] == "done"
    assert done["conversation_id"] == conversation["conversation_id"]
    assert content["content"] in done["content"]
    assert "Devin finished." in done["content"]


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
