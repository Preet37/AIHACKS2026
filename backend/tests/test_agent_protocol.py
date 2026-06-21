from fastapi.testclient import TestClient

from backend.main import app
from backend.utils.agent import ConjureAgent
from backend.utils.config import Settings


def test_health_endpoint_reports_ok():
    client = TestClient(app)

    response = client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok", "service": "conjure-backend"}


def test_demo_agent_streams_protocol_events_without_api_key(tmp_path):
    agent = ConjureAgent(
        Settings(
            anthropic_api_key=None,
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
    assert events[1]["type"] == "tool_start"
    assert events[1]["name"] == "create_file"
    assert events[2]["type"] == "tool_end"
    assert events[2]["name"] == "create_file"
    assert events[-1] == {"type": "thinking"}


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
        tool_start = websocket.receive_json()
        tool_end = websocket.receive_json()
        thinking = websocket.receive_json()
        done = websocket.receive_json()

    assert conversation["type"] == "conversation_id"
    assert conversation["conversation_id"]
    assert content["type"] == "content"
    assert "Create a minimal manifest" in content["content"]
    assert tool_start["type"] == "tool_start"
    assert tool_start["name"] == "create_file"
    assert tool_end["type"] == "tool_end"
    assert tool_end["name"] == "create_file"
    assert thinking == {"type": "thinking"}
    assert done["type"] == "done"
    assert done["conversation_id"] == conversation["conversation_id"]
    assert done["content"] == content["content"]


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
