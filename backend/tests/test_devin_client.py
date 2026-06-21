import asyncio
import json

import httpx

from backend.utils.devin import DevinClient, DevinSettings, progress_phrase


def run(coro):
    return asyncio.run(coro)


class Recorder:
    def __init__(self, responses):
        self.requests = []
        self.responses = list(responses)

    def __call__(self, request: httpx.Request) -> httpx.Response:
        body = request.content.decode("utf-8") if request.content else ""
        self.requests.append(
            {
                "method": request.method,
                "url": str(request.url),
                "authorization": request.headers.get("authorization"),
                "body": json.loads(body) if body else None,
            }
        )
        response = self.responses.pop(0)
        return httpx.Response(response.get("status", 200), json=response.get("json", {}))


def test_create_session_uses_org_endpoint_and_autonomous_payload():
    async def scenario():
        recorder = Recorder(
            [
                {
                    "json": {
                        "session_id": "devin-123",
                        "url": "https://app.devin.ai/sessions/devin-123",
                        "status": "running",
                        "status_detail": "working",
                        "pull_requests": [],
                    }
                }
            ]
        )
        client = DevinClient(
            DevinSettings(
                api_key="cog_test",
                org_id="org-123",
                repos=("Preet37/AIHACKS2026",),
                mode="normal",
            ),
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(recorder),
                base_url="https://api.devin.ai/v3",
            ),
        )

        result = await client.create_session(
            prompt="Build a browser extension",
            title="Build browser extension",
            tags=("conjure", "project-1"),
        )
        await client.aclose()

        assert result["session_id"] == "devin-123"
        assert recorder.requests == [
            {
                "method": "POST",
                "url": "https://api.devin.ai/v3/organizations/org-123/sessions",
                "authorization": "Bearer cog_test",
                "body": {
                    "prompt": "Build a browser extension",
                    "title": "Build browser extension",
                    "repos": ["Preet37/AIHACKS2026"],
                    "devin_mode": "normal",
                    "bypass_approval": True,
                    "structured_output_required": False,
                    "tags": ["conjure", "project-1"],
                },
            }
        ]

    run(scenario())


def test_send_message_and_get_session_use_existing_devin_id():
    async def scenario():
        recorder = Recorder(
            [
                {"json": {"session_id": "devin-123", "status": "running"}},
                {"json": {"session_id": "devin-123", "status": "exit", "status_detail": "finished"}},
            ]
        )
        client = DevinClient(
            DevinSettings(api_key="cog_test", org_id="org-123"),
            http_client=httpx.AsyncClient(
                transport=httpx.MockTransport(recorder),
                base_url="https://api.devin.ai/v3",
            ),
        )

        await client.send_message("devin-123", "Continue")
        await client.get_session("devin-123")
        await client.aclose()

        assert recorder.requests[0]["method"] == "POST"
        assert recorder.requests[0]["url"] == (
            "https://api.devin.ai/v3/organizations/org-123/sessions/devin-123/messages"
        )
        assert recorder.requests[0]["body"] == {"message": "Continue"}
        assert recorder.requests[1]["method"] == "GET"
        assert recorder.requests[1]["url"] == (
            "https://api.devin.ai/v3/organizations/org-123/sessions/devin-123"
        )

    run(scenario())


def test_progress_phrase_treats_approval_waiting_as_blocked_configuration():
    assert progress_phrase({"status": "running", "status_detail": "working"}) == "Devin is working..."
    assert progress_phrase({"status": "new"}) == "Devin is queued..."
    assert progress_phrase({"status": "exit", "status_detail": "finished"}) == "Devin finished."
    assert progress_phrase({"status": "running", "status_detail": "waiting_for_approval"}) == (
        "Devin is blocked by approval settings. Enable autonomous sessions or verify bypass_approval permissions."
    )
