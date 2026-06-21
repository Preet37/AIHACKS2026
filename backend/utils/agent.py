from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

from . import mods as mods_registry
from .config import Settings, load_settings
from .prompts import build_system_prompt
from .tools import (
    get_langchain_tools,
    invoke_tool,
    project_dir_for,
    reset_tool_context,
    sanitize_project_id,
    set_tool_context,
)


class ConjureAgent:
    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or load_settings()

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
            if self.settings.effective_demo_mode:
                async for event in self._stream_demo_response(
                    query=query,
                    conversation_id=conversation_id,
                    active_tabs=active_tabs or [],
                ):
                    yield event
                return

            provider = self.settings.active_provider
            provider_name = _provider_label(provider)

            yield _agent_status_event(
                provider=provider,
                phrase=f"{provider_name} is working...",
                status="running",
                active=True,
            )

            async for event in self._stream_langchain_response(
                query=query,
                project_id=project_id,
                active_tabs=active_tabs or [],
                rules=rules or [],
                history=history or [],
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

    async def _stream_demo_response(
        self,
        *,
        query: str,
        conversation_id: str,
        active_tabs: Sequence[Mapping[str, Any]],
    ) -> AsyncIterator[dict[str, Any]]:
        tab_note = f" Active tabs provided: {len(active_tabs)}." if active_tabs else ""
        content = (
            "Running in demo mode because no LLM API key is configured. "
            f"I received: {query.strip()}.{tab_note} "
            "I created a project note so the tool protocol is exercised end to end."
        )
        yield {"type": "content", "content": content}

        path = f"agent-notes-{sanitize_project_id(conversation_id)}.md"
        note = "\n".join(
            [
                "# Conjure Demo Turn",
                "",
                f"Conversation: {conversation_id}",
                f"User request: {query.strip()}",
                f"Active tabs: {len(active_tabs)}",
                "",
                "This file is produced by demo mode and can be replaced by LLM tool output when configured.",
            ]
        )
        args = {"path": path, "content": note}
        yield {"type": "tool_start", "name": "create_file", "args": args}
        result = await invoke_tool("create_file", args)
        yield {"type": "tool_end", "name": "create_file", "result": result}
        yield {"type": "thinking"}

    async def _stream_langchain_response(
        self,
        *,
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
                "LangChain dependencies are not installed. "
                "Run: pip install langchain-core langchain-openai langchain-anthropic"
            ) from exc

        tools = get_langchain_tools()
        if not tools:
            raise RuntimeError("LangChain tool support is unavailable. Install langchain-core.")

        provider = self.settings.active_provider
        model = _build_llm(self.settings, provider, tools)

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

                # Await directly so ContextVar mutations from tools like
                # start_mod propagate to subsequent tool calls in this turn.
                try:
                    result = await invoke_tool(name, args)
                except KeyError:
                    result = json.dumps({"error": f"Unknown tool: {name}"})
                except Exception as exc:
                    result = json.dumps({"error": f"Tool {name} failed: {exc}"})

                while not outbound.empty():
                    yield outbound.get_nowait()

                yield {"type": "tool_end", "name": name, "result": _stringify_result(result)}
                messages.append(ToolMessage(content=_stringify_result(result), tool_call_id=call_id))

            yield {"type": "thinking"}

        raise RuntimeError("Agent loop exceeded the maximum tool-iteration limit")


def _build_llm(settings: Settings, provider: str, tools: list[Any]) -> Any:
    """Instantiate and bind tools for the selected provider."""
    if provider == "groq":
        from langchain_openai import ChatOpenAI
        llm = ChatOpenAI(
            model=settings.groq_model,
            api_key=settings.groq_api_key,  # type: ignore[arg-type]
            base_url="https://api.groq.com/openai/v1",
            temperature=0.4,
            max_tokens=8192,
        )
        return llm.bind_tools(tools, parallel_tool_calls=False)

    if provider == "nemotron":
        from langchain_openai import ChatOpenAI
        llm = ChatOpenAI(
            model=settings.nvidia_model,
            api_key=settings.nvidia_api_key,  # type: ignore[arg-type]
            base_url=settings.nvidia_api_base_url,
            temperature=0.6,
            max_tokens=8192,
        )
        return llm.bind_tools(tools)

    # Default: Claude via langchain-anthropic
    from langchain.chat_models import init_chat_model
    return init_chat_model(settings.anthropic_model).bind_tools(tools)


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
    if provider == "groq":
        return "Groq"
    if provider == "claude":
        return "Claude"
    if provider == "nemotron":
        return "Nemotron"
    return "Conjure"
