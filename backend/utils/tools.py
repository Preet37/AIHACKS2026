from __future__ import annotations

import asyncio
import contextvars
import json
import os
import re
import shutil
import subprocess
import uuid
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .config import Settings, load_settings


ToolHandler = Callable[..., Awaitable[Any]]


@dataclass(frozen=True, slots=True)
class ToolSpec:
    name: str
    description: str
    handler: ToolHandler


@dataclass(frozen=True, slots=True)
class ToolContextTokens:
    outbound_queue: contextvars.Token[Any]
    pending_tab_requests: contextvars.Token[Any]
    project_dir: contextvars.Token[Any]
    settings: contextvars.Token[Any]


_outbound_queue_var: contextvars.ContextVar[asyncio.Queue[dict[str, Any]] | None] = (
    contextvars.ContextVar("conjure_outbound_queue", default=None)
)
_pending_tab_requests_var: contextvars.ContextVar[dict[str, asyncio.Future[Any]] | None] = (
    contextvars.ContextVar("conjure_pending_tab_requests", default=None)
)
_project_dir_var: contextvars.ContextVar[Path | None] = contextvars.ContextVar(
    "conjure_project_dir",
    default=None,
)
_settings_var: contextvars.ContextVar[Settings | None] = contextvars.ContextVar(
    "conjure_settings",
    default=None,
)


def set_tool_context(
    *,
    outbound_queue: asyncio.Queue[dict[str, Any]] | None,
    pending_tab_requests: dict[str, asyncio.Future[Any]] | None,
    project_dir: Path,
    settings: Settings,
) -> ToolContextTokens:
    project_dir.mkdir(parents=True, exist_ok=True)
    return ToolContextTokens(
        outbound_queue=_outbound_queue_var.set(outbound_queue),
        pending_tab_requests=_pending_tab_requests_var.set(pending_tab_requests),
        project_dir=_project_dir_var.set(project_dir.resolve()),
        settings=_settings_var.set(settings),
    )


def reset_tool_context(tokens: ToolContextTokens) -> None:
    _outbound_queue_var.reset(tokens.outbound_queue)
    _pending_tab_requests_var.reset(tokens.pending_tab_requests)
    _project_dir_var.reset(tokens.project_dir)
    _settings_var.reset(tokens.settings)


def sanitize_project_id(project_id: str) -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_.-]+", "_", project_id).strip("._")
    return cleaned[:80] or "default"


def project_dir_for(settings: Settings, project_id: str) -> Path:
    root = settings.resolved_project_root()
    project_dir = (root / sanitize_project_id(project_id)).resolve()
    if root != project_dir and root not in project_dir.parents:
        raise ValueError("Resolved project directory escaped project root")
    project_dir.mkdir(parents=True, exist_ok=True)
    return project_dir


def _settings() -> Settings:
    return _settings_var.get() or load_settings()


def _project_dir() -> Path:
    project_dir = _project_dir_var.get()
    if project_dir is None:
        settings = _settings()
        return project_dir_for(settings, "default")
    return project_dir


def _resolve_path(relative_path: str | None = None) -> Path:
    project_dir = _project_dir().resolve()
    if not relative_path or relative_path == ".":
        return project_dir

    requested = Path(relative_path)
    if requested.is_absolute():
        raise ValueError("Tool paths must be relative to the project workspace")

    resolved = (project_dir / requested).resolve()
    if resolved != project_dir and project_dir not in resolved.parents:
        raise ValueError("Tool path escapes the project workspace")
    return resolved


def _json(data: Any) -> str:
    return json.dumps(data, indent=2, sort_keys=True, default=str)


EDIT_MARKER = "// ... existing code ..."

EDIT_SYSTEM_PROMPT = (
    "You apply a partial code edit to a file. You receive the ORIGINAL file and an EDIT "
    "that uses the marker '// ... existing code ...' to stand in for unchanged regions. "
    "Merge the edit into the original and return ONLY the complete, final file content. "
    "No explanations and no Markdown code fences."
)


async def list_dir(path: str = ".") -> str:
    """List files and directories under the project workspace."""
    target = _resolve_path(path)
    if not target.exists():
        return _json({"error": f"Path not found: {path}"})
    if not target.is_dir():
        return _json({"error": f"Path is not a directory: {path}"})

    entries = []
    for child in sorted(target.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower())):
        entries.append(
            {
                "name": child.name,
                "type": "dir" if child.is_dir() else "file",
                "size": child.stat().st_size if child.is_file() else None,
            }
        )
    return _json({"path": path, "entries": entries})


async def read_file(path: str, start_line: int = 1, max_lines: int | None = None) -> str:
    """Read a text file with 1-based line numbers."""
    settings = _settings()
    target = _resolve_path(path)
    if not target.exists():
        return _json({"error": f"File not found: {path}"})
    if not target.is_file():
        return _json({"error": f"Path is not a file: {path}"})

    line_cap = min(max_lines or settings.max_read_lines, settings.max_read_lines)
    first_line = max(start_line, 1)
    lines = target.read_text(encoding="utf-8", errors="replace").splitlines()
    selected = lines[first_line - 1 : first_line - 1 + line_cap]
    numbered = [f"{idx}: {line}" for idx, line in enumerate(selected, start=first_line)]
    return "\n".join(numbered)


def _python_grep(pattern: str, target: Path, max_matches: int) -> list[dict[str, Any]]:
    matches: list[dict[str, Any]] = []
    try:
        compiled = re.compile(pattern)
    except re.error:
        compiled = re.compile(re.escape(pattern))

    files = [target] if target.is_file() else [path for path in target.rglob("*") if path.is_file()]
    for file_path in files:
        try:
            lines = file_path.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for line_number, line in enumerate(lines, start=1):
            if compiled.search(line):
                matches.append(
                    {
                        "path": str(file_path.relative_to(_project_dir())),
                        "line": line_number,
                        "text": line[:500],
                    }
                )
                if len(matches) >= max_matches:
                    return matches
    return matches


async def grep_search(pattern: str, path: str = ".") -> str:
    """Search project files for a pattern and return capped line matches."""
    settings = _settings()
    target = _resolve_path(path)
    if not target.exists():
        return _json({"error": f"Path not found: {path}"})

    rg = shutil.which("rg")
    if rg:
        try:
            rg_target = str(target.relative_to(_project_dir())) or "."
        except ValueError:
            rg_target = str(target)
        command = [
            rg,
            "--line-number",
            "--no-heading",
            "--color",
            "never",
            "--",
            pattern,
            rg_target,
        ]
        proc = await asyncio.to_thread(
            subprocess.run,
            command,
            cwd=str(_project_dir()),
            capture_output=True,
            text=True,
            timeout=settings.terminal_timeout_seconds,
        )
        matches = []
        for line in proc.stdout.splitlines()[: settings.grep_max_matches]:
            parts = line.split(":", 2)
            if len(parts) != 3:
                continue
            file_name, line_number, text = parts
            try:
                parsed_line = int(line_number)
            except ValueError:
                continue
            matches.append({"path": file_name, "line": parsed_line, "text": text[:500]})
        return _json({"matches": matches, "truncated": len(proc.stdout.splitlines()) > settings.grep_max_matches})

    matches = _python_grep(pattern, target, settings.grep_max_matches)
    return _json({"matches": matches, "truncated": len(matches) >= settings.grep_max_matches})


async def create_file(path: str, content: str) -> str:
    """Create a new file in the project workspace. Fails if the file already exists."""
    target = _resolve_path(path)
    if target.exists():
        return _json({"error": f"File already exists: {path}"})
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return _json({"created": path, "bytes": len(content.encode("utf-8"))})


async def edit_file(path: str, code_edit: str, instructions: str = "") -> str:
    """Apply a minimal edit to an existing file.

    Use the marker '// ... existing code ...' to represent unchanged regions; a
    secondary model merges the edit into the full file. When no model is
    available, `code_edit` must be the complete new file content (no markers).
    """
    target = _resolve_path(path)
    if not target.exists():
        return _json({"error": f"File does not exist; use create_file instead: {path}"})

    original = target.read_text(encoding="utf-8")
    try:
        merged = await _apply_file_edit(original, code_edit, instructions)
    except Exception as exc:  # pragma: no cover - defensive
        return _json({"error": f"edit_file failed: {exc}"})

    if merged is None:
        return _json(
            {
                "error": (
                    "Could not merge the marker-based edit. Provide the full file content "
                    "in code_edit, or configure ANTHROPIC_API_KEY for marker-based merges."
                )
            }
        )

    target.write_text(merged, encoding="utf-8")
    return _json({"edited": path, "bytes": len(merged.encode("utf-8"))})


async def _apply_file_edit(original: str, code_edit: str, instructions: str) -> str | None:
    has_marker = EDIT_MARKER in code_edit
    settings = _settings()
    use_llm = bool(os.getenv("ANTHROPIC_API_KEY")) and not settings.effective_demo_mode

    if use_llm:
        merged = await _merge_with_anthropic(original, code_edit, instructions)
        if merged is not None:
            return merged

    # Deterministic fallback: a markerless edit is a full-file replacement.
    if not has_marker:
        return code_edit
    return None


async def _merge_with_anthropic(original: str, code_edit: str, instructions: str) -> str | None:
    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        return None

    model = (
        os.getenv("ANTHROPIC_SECONDARY_MODEL")
        or os.getenv("ANTHROPIC_MEMORY_MODEL")
        or "claude-3-5-haiku-latest"
    )
    client = AsyncAnthropic(api_key=os.environ["ANTHROPIC_API_KEY"])
    payload = json.dumps(
        {"instructions": instructions, "original_file": original, "edit": code_edit},
        ensure_ascii=True,
    )
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=4096,
            temperature=0,
            system=EDIT_SYSTEM_PROMPT,
            messages=[{"role": "user", "content": payload}],
        )
    except Exception:
        return None

    text = _anthropic_text(response)
    return _strip_code_fences(text) if text else None


def _anthropic_text(response: Any) -> str:
    parts: list[str] = []
    for block in getattr(response, "content", []) or []:
        text = getattr(block, "text", None)
        if text:
            parts.append(text)
    return "\n".join(parts)


def _strip_code_fences(text: str) -> str:
    stripped = text.strip()
    if not stripped.startswith("```"):
        return text
    lines = stripped.splitlines()
    if len(lines) >= 2 and lines[0].startswith("```"):
        lines = lines[1:]
        if lines and lines[-1].strip() == "```":
            lines = lines[:-1]
        return "\n".join(lines)
    return text


async def run_terminal_command(command: str) -> str:
    """Run a terminal command inside the project workspace."""
    settings = _settings()
    project_dir = _project_dir()
    proc = await asyncio.to_thread(
        subprocess.run,
        command,
        cwd=str(project_dir),
        shell=True,
        capture_output=True,
        text=True,
        timeout=settings.terminal_timeout_seconds,
    )
    return _json(
        {
            "exit_code": proc.returncode,
            "stdout": proc.stdout[-4000:],
            "stderr": proc.stderr[-4000:],
        }
    )


async def get_tab_content(tab_id: int, content_type: str = "text") -> str:
    """Request page content from the browser extension during an agent turn."""
    outbound_queue = _outbound_queue_var.get()
    pending = _pending_tab_requests_var.get()
    if outbound_queue is None or pending is None:
        return _json({"error": "Browser bridge is unavailable for this request"})

    request_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    future: asyncio.Future[Any] = loop.create_future()
    pending[request_id] = future
    await outbound_queue.put(
        {
            "type": "request_tab_content",
            "request_id": request_id,
            "tab_id": tab_id,
            "content_type": content_type,
        }
    )
    try:
        result = await asyncio.wait_for(future, timeout=_settings().browser_request_timeout_seconds)
        return str(result)
    finally:
        pending.pop(request_id, None)


async def get_console_logs(tab_id: int, level: str | None = None, since: str | None = None) -> str:
    """Request console logs from the browser extension during an agent turn."""
    outbound_queue = _outbound_queue_var.get()
    pending = _pending_tab_requests_var.get()
    if outbound_queue is None or pending is None:
        return _json({"error": "Browser bridge is unavailable for this request"})

    request_id = str(uuid.uuid4())
    loop = asyncio.get_running_loop()
    future: asyncio.Future[Any] = loop.create_future()
    pending[request_id] = future
    await outbound_queue.put(
        {
            "type": "request_console_logs",
            "request_id": request_id,
            "tab_id": tab_id,
            "level": level,
            "since": since,
        }
    )
    try:
        result = await asyncio.wait_for(future, timeout=_settings().browser_request_timeout_seconds)
        return str(result)
    finally:
        pending.pop(request_id, None)


async def validate_extension() -> str:
    """Run static MV3 validation when the validator module is available."""
    try:
        from .extension_validator import validate_extension as validate
    except ImportError:
        return _json(
            {
                "status": "stub",
                "message": "extension_validator.py is not implemented in M1 ownership.",
            }
        )

    result = validate(_project_dir())
    if inspectable := getattr(result, "model_dump", None):
        return _json(inspectable())
    return _json(result)


async def run_in_sandbox(
    target_url: str = "https://example.com",
    feature_description: str | None = None,
) -> str:
    """Run the generated extension in the sandbox when the sandbox module is available."""
    try:
        from .sandbox import run_in_sandbox as sandbox_run
    except ImportError:
        return _json(
            {
                "status": "stub",
                "passed": False,
                "target_url": target_url,
                "message": "sandbox.py is not implemented in M1 ownership.",
            }
        )

    result = await sandbox_run(
        _project_dir(),
        target_url=target_url,
        feature_description=feature_description,
    )
    if inspectable := getattr(result, "model_dump", None):
        return _json(inspectable())
    if to_dict := getattr(result, "to_dict", None):
        return _json(to_dict())
    return _json(result)


TOOL_SPECS: tuple[ToolSpec, ...] = (
    ToolSpec("list_dir", "List files and directories under the generated extension workspace.", list_dir),
    ToolSpec("read_file", "Read a text file with line numbers, capped for context size.", read_file),
    ToolSpec("grep_search", "Search generated project files for a regex or literal pattern.", grep_search),
    ToolSpec("create_file", "Create a new file, failing if the target already exists.", create_file),
    ToolSpec("edit_file", "Edit an existing file; use '// ... existing code ...' markers for unchanged regions.", edit_file),
    ToolSpec("run_terminal_command", "Run a shell command inside the project workspace.", run_terminal_command),
    ToolSpec("get_tab_content", "Ask the browser extension for live tab content.", get_tab_content),
    ToolSpec("get_console_logs", "Ask the browser extension for captured console logs.", get_console_logs),
    ToolSpec("validate_extension", "Run static Chrome extension validation when available.", validate_extension),
    ToolSpec("run_in_sandbox", "Run dynamic sandbox validation when available.", run_in_sandbox),
)

TOOL_BY_NAME: Mapping[str, ToolSpec] = {tool.name: tool for tool in TOOL_SPECS}


async def invoke_tool(name: str, args: Mapping[str, Any] | None = None) -> Any:
    spec = TOOL_BY_NAME.get(name)
    if spec is None:
        raise KeyError(f"Unknown tool: {name}")
    return await spec.handler(**dict(args or {}))


def get_langchain_tools() -> list[Any]:
    try:
        from langchain_core.tools import StructuredTool
    except ImportError:
        return []

    return [
        StructuredTool.from_function(
            coroutine=spec.handler,
            name=spec.name,
            description=spec.description,
        )
        for spec in TOOL_SPECS
    ]
