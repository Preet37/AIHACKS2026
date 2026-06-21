from __future__ import annotations

import asyncio
import contextlib
import uuid
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .utils.agent import ConjureAgent
from .utils.config import load_settings


app = FastAPI(title="conjure backend")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "conjure-backend"}


@app.websocket("/ws/{project_id}")
async def websocket_endpoint(websocket: WebSocket, project_id: str) -> None:
    await websocket.accept()
    settings = load_settings()
    agent = ConjureAgent(settings)
    chat_queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    pending_tab_requests: dict[str, asyncio.Future[Any]] = {}
    receiver = asyncio.create_task(
        _receive_websocket_messages(websocket, chat_queue, pending_tab_requests)
    )

    try:
        while True:
            message = await chat_queue.get()
            if message is None:
                break
            if message.get("type") == "__error__":
                await websocket.send_json({"type": "error", "message": message["message"]})
                continue
            if message.get("type") != "chat":
                await websocket.send_json(
                    {"type": "error", "message": f"Unsupported event type: {message.get('type')}"}
                )
                continue

            await _handle_chat_message(
                websocket=websocket,
                agent=agent,
                project_id=project_id,
                message=message,
                pending_tab_requests=pending_tab_requests,
            )
    except WebSocketDisconnect:
        pass
    finally:
        receiver.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await receiver
        for future in pending_tab_requests.values():
            if not future.done():
                future.cancel()


async def _receive_websocket_messages(
    websocket: WebSocket,
    chat_queue: asyncio.Queue[dict[str, Any] | None],
    pending_tab_requests: dict[str, asyncio.Future[Any]],
) -> None:
    try:
        while True:
            message = await websocket.receive_json()
            event_type = message.get("type")
            if event_type == "chat":
                await chat_queue.put(message)
            elif event_type in {"tab_content_response", "console_logs_response"}:
                _resolve_browser_request(message, pending_tab_requests)
            else:
                await chat_queue.put(
                    {"type": "__error__", "message": f"Unsupported event type: {event_type}"}
                )
    except WebSocketDisconnect:
        await chat_queue.put(None)


def _resolve_browser_request(
    message: dict[str, Any],
    pending_tab_requests: dict[str, asyncio.Future[Any]],
) -> None:
    request_id = message.get("request_id")
    future = pending_tab_requests.get(request_id)
    if future is None or future.done():
        return
    future.set_result(message.get("content", message.get("logs", "")))


async def _handle_chat_message(
    *,
    websocket: WebSocket,
    agent: ConjureAgent,
    project_id: str,
    message: dict[str, Any],
    pending_tab_requests: dict[str, asyncio.Future[Any]],
) -> None:
    query = message.get("query")
    if not isinstance(query, str) or not query.strip():
        await websocket.send_json({"type": "error", "message": "chat.query is required"})
        return

    active_tabs = message.get("active_tabs") or []
    if not isinstance(active_tabs, list):
        await websocket.send_json({"type": "error", "message": "chat.active_tabs must be a list"})
        return

    conversation_id = message.get("conversation_id") or str(uuid.uuid4())
    await websocket.send_json({"type": "conversation_id", "conversation_id": conversation_id})

    content_parts: list[str] = []
    try:
        async for event in agent.stream_chat_response(
            query=query,
            project_id=project_id,
            conversation_id=conversation_id,
            active_tabs=active_tabs,
            pending_tab_requests=pending_tab_requests,
        ):
            if event.get("type") == "content":
                content_parts.append(str(event.get("content", "")))
            await websocket.send_json(event)
    except WebSocketDisconnect:
        raise
    except Exception as exc:
        await websocket.send_json({"type": "error", "message": str(exc)})
        return

    await websocket.send_json(
        {
            "type": "done",
            "conversation_id": conversation_id,
            "content": "".join(content_parts),
        }
    )
