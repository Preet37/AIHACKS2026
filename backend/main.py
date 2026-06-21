from __future__ import annotations

import asyncio
import contextlib
import uuid
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .utils.agent import ConjureAgent
from .utils.config import load_settings
from .utils.memory import extract_and_save_rules
from .utils.store import create_store


app = FastAPI(title="conjure backend")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "conjure-backend"}


@app.websocket("/ws/{project_id}")
async def websocket_endpoint(websocket: WebSocket, project_id: str) -> None:
    await websocket.accept()
    settings = load_settings()
    agent = ConjureAgent(settings)
    store = await _open_store()
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
                store=store,
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
        if store is not None:
            with contextlib.suppress(Exception):
                await store.close()


async def _open_store() -> Any | None:
    """Best-effort store. Persistence is optional: if Redis is down and the
    in-memory fallback is disabled, chat still works without persistence."""
    try:
        return await create_store()
    except Exception:
        return None


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
    store: Any | None = None,
) -> None:
    query = message.get("query")
    if not isinstance(query, str) or not query.strip():
        await websocket.send_json({"type": "error", "message": "chat.query is required"})
        return

    active_tabs = message.get("active_tabs") or []
    if not isinstance(active_tabs, list):
        await websocket.send_json({"type": "error", "message": "chat.active_tabs must be a list"})
        return

    requested_conversation_id = message.get("conversation_id")
    conversation_id, history, rules = await _prepare_conversation(
        store, project_id, requested_conversation_id
    )
    await websocket.send_json({"type": "conversation_id", "conversation_id": conversation_id})

    content_parts: list[str] = []
    try:
        async for event in agent.stream_chat_response(
            query=query,
            project_id=project_id,
            conversation_id=conversation_id,
            active_tabs=active_tabs,
            pending_tab_requests=pending_tab_requests,
            rules=rules,
            history=history,
        ):
            if event.get("type") == "content":
                content_parts.append(str(event.get("content", "")))
            await websocket.send_json(event)
    except WebSocketDisconnect:
        raise
    except Exception as exc:
        await websocket.send_json({"type": "error", "message": str(exc)})
        return

    content = "".join(content_parts)
    await _persist_turn(store, conversation_id, query, content)

    new_rules = await _update_memory(store, project_id, history, rules, query, content)
    if new_rules:
        await websocket.send_json({"type": "rules_updated", "rules": new_rules})

    await websocket.send_json(
        {
            "type": "done",
            "conversation_id": conversation_id,
            "content": content,
        }
    )


async def _update_memory(
    store: Any | None,
    project_id: str,
    prior_history: list[dict[str, Any]],
    existing_rules: list[str],
    query: str,
    content: str,
) -> list[str]:
    """Extract and persist new agent-memory rules from the completed turn.

    Runs after the turn so a stated preference ("always ...", "remember ...")
    becomes a durable rule injected into future system prompts. Best-effort:
    never blocks or fails the chat response."""
    if store is None:
        return []
    full_history = [
        *prior_history,
        {"role": "user", "content": query},
        {"role": "assistant", "content": content},
    ]
    try:
        return await extract_and_save_rules(
            store, project_id, full_history, existing_rules=existing_rules
        )
    except Exception:
        return []


async def _prepare_conversation(
    store: Any | None,
    project_id: str,
    requested_conversation_id: Any,
) -> tuple[str, list[dict[str, Any]], list[str]]:
    """Resolve the conversation, returning (conversation_id, prior history, rules).

    History is loaded *before* the new user turn is persisted so the agent sees
    only past turns. Falls back to a fresh uuid with no history when there is no
    store available."""
    conversation_id = (
        str(requested_conversation_id) if requested_conversation_id else str(uuid.uuid4())
    )
    if store is None:
        return conversation_id, [], []

    try:
        if await store.get_project(project_id) is None:
            await store.create_project(name=project_id, project_id=project_id)

        existing = await store.get_conversation(conversation_id)
        if existing is None:
            await store.create_conversation(project_id, conversation_id=conversation_id)
            history: list[dict[str, Any]] = []
        else:
            history = await store.get_history(conversation_id)

        rule_records = await store.list_rules(project_id)
        rules = [str(record.get("content", "")) for record in rule_records if record.get("content")]
        return conversation_id, history, rules
    except Exception:
        return conversation_id, [], []


async def _persist_turn(
    store: Any | None,
    conversation_id: str,
    query: str,
    content: str,
) -> None:
    if store is None:
        return
    with contextlib.suppress(Exception):
        await store.create_message(conversation_id, "user", query)
        if content:
            await store.create_message(conversation_id, "assistant", content)
