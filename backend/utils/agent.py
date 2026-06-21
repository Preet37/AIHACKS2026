from __future__ import annotations

import asyncio
import json
from collections.abc import AsyncIterator, Mapping, Sequence
from typing import Any

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
    ) -> AsyncIterator[dict[str, Any]]:
        project_dir = project_dir_for(self.settings, project_id)
        outbound: asyncio.Queue[dict[str, Any]] = asyncio.Queue()
        tokens = set_tool_context(
            outbound_queue=outbound,
            pending_tab_requests=pending_tab_requests,
            project_dir=project_dir,
            settings=self.settings,
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

            async for event in self._stream_langchain_response(
                query=query,
                project_id=project_id,
                active_tabs=active_tabs or [],
                rules=rules or [],
                outbound=outbound,
            ):
                yield event
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
            "Running in demo mode because no Anthropic API key is configured. "
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
                "This file is produced by demo mode and can be replaced by Claude tool output when configured.",
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
        outbound: asyncio.Queue[dict[str, Any]],
    ) -> AsyncIterator[dict[str, Any]]:
        try:
            from langchain.chat_models import init_chat_model
            from langchain_core.messages import HumanMessage, SystemMessage, ToolMessage
        except ImportError as exc:
            raise RuntimeError(
                "LangChain dependencies are not installed. Set CONJURE_DEMO_MODE=true or install langchain and langchain-anthropic."
            ) from exc

        tools = get_langchain_tools()
        if not tools:
            raise RuntimeError("LangChain tool support is unavailable. Install langchain-core.")

        model = init_chat_model(self.settings.anthropic_model).bind_tools(tools)
        messages: list[Any] = [
            SystemMessage(
                content=build_system_prompt(
                    project_id=project_id,
                    active_tabs=active_tabs,
                    rules=rules,
                )
            ),
            HumanMessage(content=query),
        ]

        for _ in range(8):
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

                result = await task
                yield {"type": "tool_end", "name": name, "result": _stringify_result(result)}
                messages.append(ToolMessage(content=_stringify_result(result), tool_call_id=call_id))

            yield {"type": "thinking"}

        raise RuntimeError("Agent loop exceeded the maximum tool-iteration limit")


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
