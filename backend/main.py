from __future__ import annotations

import asyncio
import contextlib
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from .utils import browser_agent
from .utils import mods as mods_registry
from .utils.agent import ConjureAgent
from .utils.browser_agent import BrowserAgentError, BrowserAgentSettings
from .utils.config import load_settings
from .utils.memory import extract_and_save_rules
from .utils.store import create_store
from .utils.tools import project_dir_for


app = FastAPI(title="conjure backend")

# The Chrome extension (side panel + service worker) fetches the generated
# bundle over HTTP from a different origin, so allow cross-origin reads.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "conjure-backend"}


class AgentTaskRequest(BaseModel):
    """A 'find items' task run by an off-device Browserbase cloud browser (Stagehand).

    The extension sends the current tab URL plus the user's cookies, so the cloud
    browser browses as the logged-in user, off-device — it is not the user's browser."""

    task: str
    url: str = ""
    cookies: list[dict[str, Any]] = []


@app.post("/projects/{project_id}/agent-task")
async def run_agent_task(project_id: str, payload: AgentTaskRequest) -> dict[str, Any]:
    """Run an off-device browse (Browserbase + Stagehand) and return findings."""
    task = payload.task.strip()
    if not task:
        raise HTTPException(status_code=400, detail="task is required")
    if not payload.url.strip():
        raise HTTPException(status_code=400, detail="url is required")

    settings = load_settings()
    browse_settings = BrowserAgentSettings(
        browserbase_api_key=settings.browserbase_api_key,
        browserbase_project_id=settings.browserbase_project_id,
        model=settings.browse_model,
        max_results=settings.browse_max_results,
        max_steps=settings.browse_max_steps,
        region=settings.browserbase_session_region,
        use_proxies=settings.browse_use_proxies,
        verified=settings.browse_verified,
        advanced_stealth=settings.browse_advanced_stealth,
    )
    blocker = browser_agent.missing_requirement(browse_settings)
    if blocker:
        raise HTTPException(status_code=503, detail=blocker)

    try:
        result = await browser_agent.find_items_remote(
            task=task,
            settings=browse_settings,
            start_url=payload.url,
            cookies=payload.cookies,
        )
    except BrowserAgentError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    return {
        "project_id": project_id,
        "task": task,
        "url": payload.url,
        "findings": result.get("findings", []),
        "session_id": result.get("session_id", ""),
        "replay_url": result.get("replay_url", ""),
    }


@app.get("/projects/{project_id}/mods")
async def list_project_mods(project_id: str) -> dict[str, Any]:
    """List every mod (browser customization) built for this project."""
    project_dir = project_dir_for(load_settings(), project_id)
    return {"project_id": project_id, "mods": mods_registry.list_mods(project_dir)}


@app.get("/projects/{project_id}/mods/bundle")
async def get_project_mod_bundles(project_id: str) -> dict[str, Any]:
    """Return every active mod's content-script bundle for the extension to apply."""
    project_dir = project_dir_for(load_settings(), project_id)
    bundles = mods_registry.active_bundles(project_dir)
    return {"project_id": project_id, "ready": bool(bundles), "bundles": bundles}


@app.delete("/projects/{project_id}/mods/{mod_id}")
async def delete_project_mod(project_id: str, mod_id: str) -> dict[str, Any]:
    """Remove a mod and its generated files."""
    project_dir = project_dir_for(load_settings(), project_id)
    deleted = mods_registry.delete_mod(project_dir, mod_id)
    if not deleted:
        raise HTTPException(status_code=404, detail=f"No mod with id {mod_id}")
    return {"project_id": project_id, "deleted": mod_id, "mods": mods_registry.list_mods(project_dir)}


@app.websocket("/ws/{project_id}")
async def websocket_endpoint(websocket: WebSocket, project_id: str) -> None:
    await websocket.accept()
    settings = load_settings()
    store = await _open_store()
    agent = ConjureAgent(settings, store=store)
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

    try:
        request_agent = _agent_with_client_provider(agent, message)
    except ValueError as exc:
        await websocket.send_json({"type": "error", "message": str(exc)})
        return

    requested_conversation_id = message.get("conversation_id")
    conversation_id, history, rules = await _prepare_conversation(
        store, project_id, requested_conversation_id
    )
    await websocket.send_json({"type": "conversation_id", "conversation_id": conversation_id})

    # Editing is explicit. Otherwise every local build gets a fresh provisional
    # mod, even when another customization already targets the same website.
    active_mod_id = message.get("mod_id") or None
    project_dir = project_dir_for(request_agent.settings, project_id)
    provisional_mod_id: str | None = None
    if active_mod_id:
        if mods_registry.get_mod(project_dir, active_mod_id) is not None:
            mods_registry.upsert_mod(project_dir, {"id": active_mod_id, "prompt": query})
        else:
            active_mod_id = None
    if not active_mod_id and request_agent.settings.agent_provider in {"claude", "groq", "nemotron"}:
        provisional = mods_registry.create_mod(
            project_dir,
            prompt=query,
            name=_mod_name_from_query(query),
        )
        provisional_mod_id = str(provisional["id"])
        active_mod_id = provisional_mod_id
        mods_registry.upsert_mod(
            project_dir,
            {"id": provisional_mod_id, "status": "building"},
        )

    content_parts: list[str] = []
    try:
        async for event in request_agent.stream_chat_response(
            query=query,
            project_id=project_id,
            conversation_id=conversation_id,
            active_tabs=active_tabs,
            pending_tab_requests=pending_tab_requests,
            rules=rules,
            history=history,
            active_mod_id=active_mod_id,
        ):
            if event.get("type") == "content":
                content_parts.append(str(event.get("content", "")))
            await websocket.send_json(event)
    except WebSocketDisconnect:
        if provisional_mod_id:
            _finish_provisional_mod(project_dir, provisional_mod_id, keep=False)
        raise
    except Exception as exc:
        if provisional_mod_id:
            _finish_provisional_mod(project_dir, provisional_mod_id, keep=False)
        await websocket.send_json({"type": "error", "message": str(exc)})
        return

    if provisional_mod_id:
        _finish_provisional_mod(project_dir, provisional_mod_id, keep=True)

    content = "".join(content_parts)
    await _persist_turn(store, conversation_id, query, content)

    new_rules = await _update_memory(store, project_id, history, rules, query, content)
    if new_rules:
        await websocket.send_json({"type": "rules_updated", "rules": new_rules})

    await _emit_mods_state(websocket, project_id)

    await websocket.send_json(
        {
            "type": "done",
            "conversation_id": conversation_id,
            "content": content,
        }
    )


def _agent_with_client_provider(
    agent: ConjureAgent,
    message: dict[str, Any],
) -> ConjureAgent:
    """Create a per-turn agent using extension credentials without persisting them."""
    requested = message.get("provider")
    if requested is None:
        return agent
    if requested not in {"anthropic", "groq"}:
        raise ValueError("chat.provider must be 'anthropic' or 'groq'")

    raw_key = message.get("api_key")
    api_key = raw_key.strip() if isinstance(raw_key, str) else ""
    if not api_key:
        raise ValueError(f"An API key is required for {requested}")
    if len(api_key) > 512:
        raise ValueError("The provider API key is too long")

    if requested == "anthropic":
        settings = replace(
            agent.settings,
            agent_provider="claude",
            anthropic_api_key=api_key,
            demo_mode=False,
        )
    else:
        settings = replace(
            agent.settings,
            agent_provider="groq",
            groq_api_key=api_key,
            demo_mode=False,
        )
    return ConjureAgent(
        settings,
        devin_client=agent.devin_client,
        store=agent.store,
    )


def _mod_name_from_query(query: str) -> str:
    name = " ".join(query.strip().split())
    return (name[:57].rstrip() + "...") if len(name) > 60 else (name or "Untitled mod")


def _finish_provisional_mod(project_dir: Path, mod_id: str, *, keep: bool) -> None:
    """Promote a built provisional mod, or remove its empty/failed record."""
    if keep and mods_registry.mod_bundle(project_dir, mod_id) is not None:
        mods_registry.upsert_mod(project_dir, {"id": mod_id, "status": "active"})
        return
    mods_registry.delete_mod(project_dir, mod_id)


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


async def _emit_mods_state(websocket: WebSocket, project_id: str) -> None:
    """Push the current mod list and the active bundles so the panel can refresh
    its Mods list and (re)apply every active mod to the browser."""
    try:
        project_dir = project_dir_for(load_settings(), project_id)
        mods = mods_registry.list_mods(project_dir)
        bundles = mods_registry.active_bundles(project_dir)
    except Exception:
        return

    await websocket.send_json({"type": "mods_updated", "project_id": project_id, "mods": mods})
    if bundles:
        await websocket.send_json(
            {
                "type": "extension_ready",
                "project_id": project_id,
                "path": str(project_dir),
                "bundles": bundles,
            }
        )


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
