from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from . import mods as mods_registry
from .config import Settings, load_settings
from .devin import (
    DevinClient,
    DevinSettings,
    is_approval_blocked,
    is_terminal_session,
    progress_phrase,
)
from .prompts import build_system_prompt
from .store import Store, create_store
from .tools import (
    get_langchain_tools,
    invoke_tool,
    project_dir_for,
    reset_tool_context,
    set_tool_context,
)


class ConjureAgent:
    def __init__(
        self,
        settings: Settings | None = None,
        *,
        devin_client: DevinClient | Any | None = None,
        store: Store | Any | None = None,
    ) -> None:
        self.settings = settings or load_settings()
        self.devin_client = devin_client
        self.store = store

    def stream_chat_response_sync(
        self,
        *,
        query: str,
        project_id: str,
        conversation_id: str,
        active_tabs: Sequence[Mapping[str, Any]] | None,
        pending_tab_requests: dict[str, asyncio.Future[Any]],
        history: Sequence[Mapping[str, Any]] | None = None,
    ) -> list[dict[str, Any]]:
        async def collect() -> list[dict[str, Any]]:
            return [
                event
                async for event in self.stream_chat_response(
                    query=query,
                    project_id=project_id,
                    conversation_id=conversation_id,
                    active_tabs=active_tabs,
                    pending_tab_requests=pending_tab_requests,
                    history=history,
                )
            ]

        return asyncio.run(collect())

    async def stream_chat_response(
        self,
        *,
        query: str,
        project_id: str,
        conversation_id: str,
        active_tabs: Sequence[Mapping[str, Any]] | None,
        pending_tab_requests: dict[str, asyncio.Future[Any]],
        rules: Sequence[str] | None = None,
        history: Sequence[Mapping[str, Any]] | None = None,
        active_mod_id: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        if self.settings.effective_demo_mode:
            async for event in self._stream_demo_response(
                query=query,
                conversation_id=conversation_id,
                active_tabs=active_tabs or [],
                provider=self.settings.agent_provider,
            ):
                yield event
            return

        if self.settings.agent_provider in {"claude", "groq", "nemotron"}:
            async for event in self._stream_local_tool_loop_response(
                provider=self.settings.agent_provider,
                query=query,
                project_id=project_id,
                active_tabs=active_tabs or [],
                pending_tab_requests=pending_tab_requests,
                rules=rules or [],
                history=history or [],
                active_mod_id=active_mod_id,
            ):
                yield event
            return

        async for event in self._stream_devin_response(
            query=query,
            project_id=project_id,
            conversation_id=conversation_id,
            active_tabs=active_tabs or [],
            rules=rules or [],
            history=history or [],
            active_mod_id=active_mod_id,
        ):
            yield event

    async def _stream_devin_response(
        self,
        *,
        query: str,
        project_id: str,
        conversation_id: str,
        active_tabs: Sequence[Mapping[str, Any]],
        rules: Sequence[str],
        history: Sequence[Mapping[str, Any]],
        active_mod_id: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        store = await self._store()
        client = self._devin_client()
        existing = await store.get_devin_session(conversation_id)

        if existing:
            session = await client.send_message(existing["devin_session_id"], query.strip())
        else:
            session = await client.create_session(
                prompt=self._build_devin_prompt(
                    query=query,
                    project_id=project_id,
                    active_tabs=active_tabs,
                    rules=rules,
                    history=history,
                    active_mod_id=active_mod_id,
                ),
                title=_title_from_query(query),
                tags=("conjure", project_id),
            )

        async for event in self._stream_session_until_terminal(
            session=session,
            client=client,
            store=store,
            project_id=project_id,
            conversation_id=conversation_id,
        ):
            yield event

    async def _stream_demo_response(
        self,
        *,
        query: str,
        conversation_id: str,
        active_tabs: Sequence[Mapping[str, Any]],
        provider: str,
    ) -> AsyncIterator[dict[str, Any]]:
        provider_name = _provider_label(provider)
        tab_note = f" Active tabs provided: {len(active_tabs)}." if active_tabs else ""
        content = (
            f"Running in demo mode because {provider_name} credentials are not configured. "
            f"I received: {query.strip()}.{tab_note} "
            f"This simulates the {provider_name} agent progress protocol."
        )
        yield {"type": "content", "content": content}

        yield _agent_status_event(
            provider=provider,
            phrase=f"{provider_name} is working...",
            status="running",
            active=True,
            session_id=f"demo-{conversation_id}",
        )
        yield _agent_status_event(
            provider=provider,
            phrase=f"{provider_name} finished.",
            status="exit",
            status_detail="finished",
            active=False,
            session_id=f"demo-{conversation_id}",
        )
        yield {"type": "content", "content": "\n" + f"{provider_name} finished."}
        yield {"type": "thinking"}

    async def _stream_local_tool_loop_response(
        self,
        *,
        provider: str,
        query: str,
        project_id: str,
        active_tabs: Sequence[Mapping[str, Any]],
        pending_tab_requests: dict[str, asyncio.Future[Any]],
        rules: Sequence[str],
        history: Sequence[Mapping[str, Any]],
        active_mod_id: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        project_dir = project_dir_for(self.settings, project_id)
        active_mod_dir = (
            mods_registry.mod_dir(project_dir, active_mod_id) if active_mod_id else None
        )
        outbound: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        tokens = set_tool_context(
            outbound_queue=outbound,
            pending_tab_requests=pending_tab_requests,
            project_dir=project_dir,
            settings=self.settings,
            active_mod_dir=active_mod_dir,
        )
        try:
            provider_name = _provider_label(provider)
            yield _agent_status_event(
                provider=provider,
                phrase=f"{provider_name} is working...",
                status="running",
                active=True,
            )
            async for event in self._stream_langchain_response(
                provider=provider,
                query=query,
                project_id=project_id,
                active_tabs=active_tabs,
                rules=rules,
                history=history,
                outbound=outbound,
                mods=mods_registry.list_mods(project_dir),
                editing_mod_id=active_mod_id,
            ):
                yield event
            yield _agent_status_event(
                provider=provider,
                phrase=f"{provider_name} finished.",
                status="exit",
                status_detail="finished",
                active=False,
            )
            yield {"type": "thinking"}
        finally:
            reset_tool_context(tokens)

    async def _stream_langchain_response(
        self,
        *,
        provider: str,
        query: str,
        project_id: str,
        active_tabs: Sequence[Mapping[str, Any]],
        rules: Sequence[str],
        history: Sequence[Mapping[str, Any]],
        outbound: asyncio.Queue[dict[str, Any]],
        mods: Sequence[Mapping[str, Any]] | None = None,
        editing_mod_id: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        try:
            from langchain_core.messages import (
                AIMessage,
                HumanMessage,
                SystemMessage,
                ToolMessage,
            )
        except ImportError as exc:
            raise RuntimeError(
                "LangChain dependencies are not installed. Set CONJURE_AGENT_PROVIDER=devin or install langchain provider packages."
            ) from exc

        tools = get_langchain_tools()
        if not tools:
            raise RuntimeError("LangChain tool support is unavailable. Install langchain-core.")

        model = self._build_langchain_model(provider, tools)
        messages: list[Any] = [
            SystemMessage(
                content=build_system_prompt(
                    project_id=project_id,
                    active_tabs=active_tabs,
                    rules=rules,
                    mods=mods,
                    editing_mod_id=editing_mod_id,
                )
            )
        ]
        for item in history:
            role = str(item.get("role", "")).lower()
            text = str(item.get("content", ""))
            if not text:
                continue
            if role == "assistant":
                messages.append(AIMessage(content=text))
            else:
                messages.append(HumanMessage(content=text))
        messages.append(HumanMessage(content=query))

        for _ in range(self.settings.max_agent_iterations):
            full = None
            async for chunk in model.astream(messages):
                full = chunk if full is None else full + chunk
                text = _chunk_text(chunk)
                if text:
                    yield {"type": "content", "content": text}

            if full is None:
                return

            messages.append(full)
            tool_calls = getattr(full, "tool_calls", None) or []
            if not tool_calls:
                return

            for call in tool_calls:
                name = _tool_call_name(call)
                args = _tool_call_args(call)
                call_id = _tool_call_id(call)
                yield {"type": "tool_start", "name": name, "args": args}

                task = asyncio.create_task(invoke_tool(name, args))
                while not task.done():
                    while not outbound.empty():
                        yield outbound.get_nowait()
                    await asyncio.sleep(0.05)

                while not outbound.empty():
                    yield outbound.get_nowait()

                try:
                    result = await task
                except Exception as exc:
                    # A malformed model-generated call should become corrective
                    # tool feedback, not terminate the entire agent workflow.
                    result = {
                        "error": (
                            f"{name} could not run: {exc}. Correct the arguments and "
                            "call the tool again. File tools require a relative 'path'."
                        )
                    }
                yield {"type": "tool_end", "name": name, "result": _stringify_result(result)}
                messages.append(ToolMessage(content=_stringify_result(result), tool_call_id=call_id))

            yield {"type": "thinking"}

        raise RuntimeError("Agent loop exceeded the maximum tool-iteration limit")

    def _build_langchain_model(self, provider: str, tools: Sequence[Any]) -> Any:
        if provider == "claude":
            try:
                from langchain_anthropic import ChatAnthropic
            except ImportError as exc:
                raise RuntimeError(
                    "Claude provider requires langchain and langchain-anthropic."
                ) from exc

            model = ChatAnthropic(
                model=self.settings.anthropic_model,
                api_key=self.settings.anthropic_api_key,
            )
            return model.bind_tools(tools) if tools else model

        if provider == "nemotron":
            try:
                from langchain_nvidia_ai_endpoints import ChatNVIDIA
            except ImportError as exc:
                raise RuntimeError(
                    "Nemotron provider requires langchain-nvidia-ai-endpoints."
                ) from exc

            kwargs: dict[str, Any] = {"model": self.settings.nvidia_model}
            if self.settings.nvidia_api_key:
                kwargs["nvidia_api_key"] = self.settings.nvidia_api_key
            if self.settings.nvidia_api_base_url:
                kwargs["base_url"] = self.settings.nvidia_api_base_url
            model = ChatNVIDIA(**kwargs)
            return model.bind_tools(tools) if tools else model

        if provider == "groq":
            try:
                from langchain_groq import ChatGroq
            except ImportError as exc:
                raise RuntimeError(
                    "Groq provider requires langchain-groq."
                ) from exc

            model = ChatGroq(
                model=self.settings.groq_model,
                api_key=self.settings.groq_api_key,
            )
            return model.bind_tools(tools) if tools else model

        raise RuntimeError(f"Unsupported local tool-loop provider: {provider}")

    async def _stream_session_until_terminal(
        self,
        *,
        session: dict[str, Any],
        client: Any,
        store: Any,
        project_id: str,
        conversation_id: str,
    ) -> AsyncIterator[dict[str, Any]]:
        last_phrase = ""
        current = session

        for attempt in range(self.settings.devin_max_poll_attempts + 1):
            await _persist_session(
                store=store,
                conversation_id=conversation_id,
                project_id=project_id,
                session=current,
            )
            _raise_if_blocked(current)

            phrase = progress_phrase(current)
            if phrase != last_phrase:
                yield _status_event(current)
                yield {"type": "content", "content": ("\n" if last_phrase else "") + _content_for_session(current)}
                last_phrase = phrase

            if is_terminal_session(current):
                yield {"type": "thinking"}
                return

            if attempt >= self.settings.devin_max_poll_attempts:
                raise RuntimeError("Timed out waiting for Devin to finish")

            await asyncio.sleep(self.settings.devin_poll_interval_seconds)
            current = await client.get_session(current["session_id"])

    async def _store(self) -> Any:
        if self.store is None:
            self.store = await create_store()
        return self.store

    def _devin_client(self) -> Any:
        if self.devin_client is None:
            self.devin_client = DevinClient(
                DevinSettings(
                    api_key=self.settings.devin_api_key,
                    org_id=self.settings.devin_org_id,
                    api_base_url=self.settings.devin_api_base_url,
                    repos=self.settings.devin_repos,
                    mode=self.settings.devin_mode,
                )
            )
        return self.devin_client

    def _build_devin_prompt(
        self,
        *,
        query: str,
        project_id: str,
        active_tabs: Sequence[Mapping[str, Any]],
        rules: Sequence[str],
        history: Sequence[Mapping[str, Any]],
        active_mod_id: str | None = None,
    ) -> str:
        project_dir = project_dir_for(self.settings, project_id)
        mods = mods_registry.list_mods(project_dir)
        return "\n\n".join(
            [
                "You are the fully autonomous cloud coding agent for Conjure.",
                "Complete the requested coding task in the connected GitHub repository without waiting for user approval.",
                "Open or update a pull request when code changes are ready.",
                f"Repo: {', '.join(self.settings.devin_repos)}",
                f"Branch: {self.settings.devin_branch}",
                f"Conjure project_id: {project_id}",
                "Saved project rules:\n" + _format_rules(rules),
                "Prior Conjure conversation:\n" + _format_history(history),
                "Existing browser mods:\n" + _format_mods(mods, active_mod_id),
                "Active browser tabs:\n" + _format_tabs(active_tabs),
                "User request:\n" + query.strip(),
            ]
        )


async def _persist_session(
    *,
    store: Any,
    conversation_id: str,
    project_id: str,
    session: dict[str, Any],
) -> None:
    await store.set_devin_session(
        conversation_id,
        project_id=project_id,
        devin_session_id=str(session.get("session_id", "")),
        devin_url=str(session.get("url") or ""),
        status=str(session.get("status") or ""),
        status_detail=str(session.get("status_detail") or ""),
        pull_requests=list(session.get("pull_requests") or []),
    )


def _status_event(session: dict[str, Any]) -> dict[str, Any]:
    return _agent_status_event(
        provider="devin",
        phrase=progress_phrase(session),
        status=session.get("status"),
        status_detail=session.get("status_detail"),
        session_id=session.get("session_id"),
        session_url=session.get("url"),
        pull_requests=list(session.get("pull_requests") or []),
        active=not is_terminal_session(session),
    )


def _agent_status_event(
    *,
    provider: str,
    phrase: str,
    active: bool,
    status: Any = None,
    status_detail: Any = None,
    session_id: Any = None,
    session_url: Any = None,
    pull_requests: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    return {
        "type": "agent_status",
        "provider": provider,
        "phrase": phrase,
        "status": status,
        "status_detail": status_detail,
        "session_id": session_id,
        "session_url": session_url,
        "pull_requests": list(pull_requests or []),
        "active": active,
    }


def _raise_if_blocked(session: dict[str, Any]) -> None:
    if is_approval_blocked(session):
        raise RuntimeError(progress_phrase(session))


def _content_for_session(session: dict[str, Any]) -> str:
    lines = [progress_phrase(session)]
    if is_terminal_session(session) and session.get("url"):
        lines.append(f"Session: {session['url']}")
    for pull_request in session.get("pull_requests") or []:
        url = pull_request.get("pr_url") or pull_request.get("url") or pull_request.get("html_url")
        if url:
            lines.append(f"Pull request: {url}")
    return "\n".join(lines)


def _format_tabs(active_tabs: Sequence[Mapping[str, Any]]) -> str:
    if not active_tabs:
        return "- No active tabs were provided."
    return "\n".join(
        f"- {tab.get('id', 'unknown')}: {tab.get('title', 'Untitled')} {tab.get('url', '')}"
        + (" active" if tab.get("active") else "")
        for tab in active_tabs
    )


def _format_rules(rules: Sequence[str]) -> str:
    if not rules:
        return "- No saved rules."
    return "\n".join(f"- {rule}" for rule in rules if rule) or "- No saved rules."


def _format_mods(mods: Sequence[Mapping[str, Any]], active_mod_id: str | None = None) -> str:
    if not mods:
        return "- No mods built yet."

    lines: list[str] = []
    for mod in mods:
        mod_id = str(mod.get("id", "")).strip()
        label = " editing" if active_mod_id and mod_id == active_mod_id else ""
        prompt = " ".join(str(mod.get("prompt", "")).split())
        if len(prompt) > 160:
            prompt = prompt[:157].rstrip() + "..."
        lines.append(
            f"- {mod_id or 'unknown'}: {mod.get('name', 'Untitled')} "
            f"status={mod.get('status', 'active')}{label}; prompt={prompt}"
        )
    return "\n".join(lines)


def _format_history(history: Sequence[Mapping[str, Any]]) -> str:
    if not history:
        return "- No prior messages."

    lines: list[str] = []
    for item in history[-12:]:
        role = str(item.get("role", "message")).strip() or "message"
        content = " ".join(str(item.get("content", "")).split())
        if not content:
            continue
        if len(content) > 800:
            content = content[:797].rstrip() + "..."
        lines.append(f"- {role}: {content}")
    return "\n".join(lines) or "- No prior messages."


def _chunk_text(chunk: Any) -> str:
    text = getattr(chunk, "text", None)
    if isinstance(text, str):
        return text

    content = getattr(chunk, "content", None)
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for block in content:
            if isinstance(block, str):
                parts.append(block)
            elif isinstance(block, dict) and isinstance(block.get("text"), str):
                parts.append(block["text"])
        return "".join(parts)
    return ""


def _tool_call_name(call: Any) -> str:
    if isinstance(call, dict):
        return str(call["name"])
    return str(call.name)


def _tool_call_args(call: Any) -> Mapping[str, Any]:
    if isinstance(call, dict):
        return call.get("args") or {}
    return getattr(call, "args", {}) or {}


def _tool_call_id(call: Any) -> str:
    if isinstance(call, dict):
        return str(call.get("id") or call.get("name") or "tool_call")
    return str(getattr(call, "id", None) or getattr(call, "name", "tool_call"))


def _stringify_result(result: Any) -> str:
    if isinstance(result, str):
        return result
    return json.dumps(result, sort_keys=True, default=str)


def _provider_label(provider: str) -> str:
    if provider == "claude":
        return "Claude"
    if provider == "nemotron":
        return "Nemotron"
    if provider == "groq":
        return "Groq"
    return "Devin"


def _title_from_query(query: str) -> str:
    title = " ".join(query.strip().split())
    if len(title) > 80:
        title = title[:77].rstrip() + "..."
    return title or "Conjure coding task"
