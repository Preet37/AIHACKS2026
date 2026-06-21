from __future__ import annotations

import asyncio
import contextvars
import json
import os
import re
import shutil
import subprocess
import time
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
# When a mod is being built/edited, file tools resolve paths inside the mod's
# own directory instead of the project root.
_active_mod_dir_var: contextvars.ContextVar[Path | None] = contextvars.ContextVar(
    "conjure_active_mod_dir",
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
    active_mod_dir: Path | None = None,
) -> ToolContextTokens:
    project_dir.mkdir(parents=True, exist_ok=True)
    if active_mod_dir is not None:
        active_mod_dir.mkdir(parents=True, exist_ok=True)
    tokens = ToolContextTokens(
        outbound_queue=_outbound_queue_var.set(outbound_queue),
        pending_tab_requests=_pending_tab_requests_var.set(pending_tab_requests),
        project_dir=_project_dir_var.set(project_dir.resolve()),
        settings=_settings_var.set(settings),
    )
    _active_mod_dir_var.set(active_mod_dir.resolve() if active_mod_dir else None)
    return tokens


def reset_tool_context(tokens: ToolContextTokens) -> None:
    _outbound_queue_var.reset(tokens.outbound_queue)
    _pending_tab_requests_var.reset(tokens.pending_tab_requests)
    _project_dir_var.reset(tokens.project_dir)
    _settings_var.reset(tokens.settings)
    _active_mod_dir_var.set(None)


def set_active_mod_dir(path: Path | None) -> None:
    _active_mod_dir_var.set(path.resolve() if path else None)


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


def read_extension_bundle(project_dir: Path) -> dict[str, Any] | None:
    """Read a single MV3 content-script bundle from a directory (legacy helper).

    New code should prefer the per-mod registry in ``mods.py``; this remains for
    reading a one-off bundle directly out of a directory."""
    from . import mods

    return mods.read_bundle(project_dir)


def _settings() -> Settings:
    return _settings_var.get() or load_settings()


def _project_dir() -> Path:
    project_dir = _project_dir_var.get()
    if project_dir is None:
        settings = _settings()
        return project_dir_for(settings, "default")
    return project_dir


def _workspace_dir() -> Path:
    """The directory file tools operate in: the active mod's dir when one is
    selected, otherwise the project root."""
    active = _active_mod_dir_var.get()
    return active if active is not None else _project_dir()


def _resolve_path(relative_path: str | None = None) -> Path:
    workspace_dir = _workspace_dir().resolve()
    if not relative_path or relative_path == ".":
        return workspace_dir

    requested = Path(relative_path)
    if requested.is_absolute():
        raise ValueError("Tool paths must be relative to the project workspace")

    resolved = (workspace_dir / requested).resolve()
    if resolved != workspace_dir and workspace_dir not in resolved.parents:
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
                        "path": str(file_path.relative_to(_workspace_dir())),
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
            rg_target = str(target.relative_to(_workspace_dir())) or "."
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
            cwd=str(_workspace_dir()),
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


def _missing_file_path_error(tool_name: str) -> str:
    return _json(
        {
            "error": (
                f"{tool_name} requires a path. Retry with "
                f'{{"path": "relative/file/name", "content": "..."}}.'
            )
        }
    )


async def create_file(path: str = "", content: str = "") -> str:
    """Create a new file in the project workspace. Fails if the file already exists."""
    if not path.strip():
        return _missing_file_path_error("create_file")
    target = _resolve_path(path)
    if target.exists():
        return _json({"error": f"File already exists: {path}"})
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return _json({"created": path, "bytes": len(content.encode("utf-8"))})


async def write_file(path: str = "", content: str = "") -> str:
    """Create or overwrite a file in the project workspace.

    Unlike create_file, this succeeds whether or not the file already exists, so
    the agent can iterate on a previously generated file."""
    if not path.strip():
        return _missing_file_path_error("write_file")
    target = _resolve_path(path)
    existed = target.exists()
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(content, encoding="utf-8")
    return _json(
        {
            "written": path,
            "overwrote": existed,
            "bytes": len(content.encode("utf-8")),
        }
    )


async def edit_file(path: str = "", code_edit: str = "", instructions: str = "") -> str:
    """Apply a minimal edit to an existing file.

    Use the marker '// ... existing code ...' to represent unchanged regions; a
    secondary model merges the edit into the full file. When no model is
    available, `code_edit` must be the complete new file content (no markers).
    """
    if not path.strip():
        return _json(
            {
                "error": (
                    "edit_file requires a path. Retry with "
                    '{"path": "relative/file/name", "code_edit": "..."}.'
                )
            }
        )
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
    workspace_dir = _workspace_dir()
    proc = await asyncio.to_thread(
        subprocess.run,
        command,
        cwd=str(workspace_dir),
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


async def list_mods() -> str:
    """List every mod (browser customization) already built for this project.

    Call this before building anything: if an existing active mod already
    implements what the user asked for, verify it instead of rebuilding."""
    from . import mods

    records = mods.list_mods(_project_dir())
    summary = [
        {
            "id": record.get("id"),
            "name": record.get("name"),
            "prompt": record.get("prompt"),
            "status": record.get("status"),
            "matches": record.get("matches", []),
            "websites": record.get("websites", []),
            "last_verified": record.get("last_verified"),
        }
        for record in records
    ]
    return _json({"mods": summary})


async def start_mod(prompt: str, name: str = "", mod_id: str | None = None) -> str:
    """Begin building (or editing) a mod and route subsequent file tools into its
    own directory. Pass mod_id to rebuild an existing mod, or omit it for a new
    one. Returns the mod_id you are now working in."""
    from . import mods

    project_dir = _project_dir()
    # New local build turns are assigned a provisional mod before the model
    # starts. If the model still calls start_mod without echoing that id, keep
    # using the assigned workspace instead of creating a second/overwriting mod.
    active = _active_mod_dir_var.get()
    if mod_id is None and active is not None:
        candidate_id = active.name
        if active.parent == mods.mods_root(project_dir).resolve() and mods.get_mod(project_dir, candidate_id):
            mod_id = candidate_id

    if mod_id:
        existing = mods.get_mod(project_dir, mod_id)
        if existing is None:
            return _json({"error": f"No mod with id {mod_id}"})
        record = mods.upsert_mod(
            project_dir,
            {"id": mod_id, "prompt": prompt or existing.get("prompt", ""), "name": name or existing.get("name", "")},
        )
    else:
        record = mods.create_mod(project_dir, prompt=prompt, name=name)

    set_active_mod_dir(mods.mod_dir(project_dir, str(record["id"])))
    return _json({"mod_id": record["id"], "name": record["name"], "editing": bool(mod_id)})


async def verify_mod(mod_id: str | None = None, target_url: str | None = None) -> str:
    """Verify a mod by running its extension in the Browserbase sandbox.

    Defaults to the mod currently being built. Without an explicit target_url,
    every distinct website in the manifest matches is verified. Streams sandbox
    progress to the UI and records one aggregate pass/fail verdict on the mod."""
    from . import mods
    from .sandbox import run_in_sandbox as sandbox_run

    project_dir = _project_dir()
    if mod_id is None:
        active = _active_mod_dir_var.get()
        if active is None:
            return _json({"error": "No mod selected; pass mod_id or call start_mod first."})
        mod_id = active.name

    record = mods.get_mod(project_dir, mod_id)
    if record is None:
        return _json({"error": f"No mod with id {mod_id}"})

    directory = mods.mod_dir(project_dir, mod_id)
    bundle = mods.read_bundle(directory)
    if bundle is None:
        return _json({"error": "Mod has no usable manifest/content scripts to verify yet."})

    visible_ui_findings = _visible_ui_findings(bundle, str(record.get("prompt") or ""))
    if visible_ui_findings:
        return _json(
            {
                "mod_id": mod_id,
                "passed": False,
                "source": "content_script_ui_preflight",
                "findings": visible_ui_findings,
                "instruction": "Fix the content-script files, then call verify_mod again.",
            }
        )

    target_urls = (
        [target_url]
        if target_url
        else mods.target_urls_for_matches(bundle.get("matches", []))
    )
    outbound = _outbound_queue_var.get()
    results: list[dict[str, Any]] = []
    for resolved_url in target_urls:
        if outbound is not None:
            await outbound.put(
                {"type": "sandbox_start", "target_url": resolved_url, "mod_id": mod_id}
            )

        result = await sandbox_run(
            directory,
            target_url=resolved_url,
            feature_description=record.get("prompt"),
        )
        data = result.to_dict() if hasattr(result, "to_dict") else dict(result)
        result_summary = {
            "target_url": resolved_url,
            "passed": bool(data.get("passed")),
            "source": data.get("source"),
            "findings": data.get("findings", []),
            "replay_url": data.get("replay_url"),
        }
        results.append(result_summary)

        if outbound is not None:
            if data.get("screenshot"):
                await outbound.put(
                    {
                        "type": "sandbox_screenshot",
                        "data": data["screenshot"],
                        "target_url": resolved_url,
                        "mod_id": mod_id,
                    }
                )
            await outbound.put(
                {
                    "type": "sandbox_result",
                    **result_summary,
                    "mod_id": mod_id,
                }
            )

    passed = all(result["passed"] for result in results)
    findings = [
        f"{result['target_url']}: {finding}"
        for result in results
        for finding in result.get("findings", [])
    ]
    sources = {result.get("source") for result in results}
    source = results[0].get("source") if len(sources) == 1 else "multi_site"
    replay_url = next(
        (result.get("replay_url") for result in results if result.get("replay_url")),
        None,
    )

    mods.upsert_mod(
        project_dir,
        {
            "id": mod_id,
            "last_verified": {
                "passed": passed,
                "source": source,
                "target_url": target_urls[0],
                "target_urls": target_urls,
                "replay_url": replay_url,
                "findings": findings,
                "results": results,
                "at": time.time(),
            },
        },
    )

    return _json(
        {
            "mod_id": mod_id,
            "passed": passed,
            "source": source,
            "target_urls": target_urls,
            "findings": findings,
            "replay_url": replay_url,
            "results": results,
        }
    )


def _visible_ui_findings(bundle: Mapping[str, Any], prompt: str) -> list[str]:
    """Catch popup-only or invisible button mods before an expensive sandbox run."""
    if not re.search(r"\b(button|floating control|toolbar|widget)\b", prompt, re.I):
        return []
    js = str(bundle.get("js") or "")
    css = str(bundle.get("css") or "")
    combined = f"{js}\n{css}"
    findings: list[str] = []
    if not re.search(r"createElement\s*\(\s*['\"]button['\"]|<button\b", js, re.I):
        findings.append(
            "No real button is created by the installed content script. popup.html/action UI is not installed for mods."
        )
    if not re.search(r"appendChild|\.append\s*\(|\.prepend\s*\(|insertAdjacentHTML", js):
        findings.append("The content script does not mount its UI into the webpage DOM.")
    if not re.search(r"data-conjure-mod|dataset\.conjureMod", js):
        findings.append("The mounted UI needs a data-conjure-mod marker so visibility can be verified.")
    if not re.search(r"position\s*[:=]\s*['\"]?fixed", combined, re.I):
        findings.append("The page control is not fixed, so it may be outside the visible viewport.")
    if not re.search(r"z-?index|zIndex", combined, re.I):
        findings.append("The page control needs a high z-index so the host page cannot cover it.")
    if re.search(r"\bagent\b|\bexplain", prompt, re.I) and not re.search(
        r"data-conjure-agent-action|dataset\.conjureAgentAction", js
    ):
        findings.append(
            "Agent buttons must set data-conjure-agent-action=\"explain-page\" so Conjure calls the real configured agent; do not hardcode the answer."
        )
    if re.search(r"data-conjure-agent-action|dataset\.conjureAgentAction", js) and re.search(
        r"data-conjure-agent-output|dataset\.conjureAgentOutput", js
    ):
        findings.append(
            "Do not create an agent output panel. Conjure renders the real Browserbase response in its own trusted, visible panel."
        )
    if re.search(r"data-conjure-agent-action|dataset\.conjureAgentAction", js) and re.search(
        r"addEventListener\s*\(\s*['\"]click['\"]|\.onclick\s*=", js, re.I
    ):
        findings.append(
            "Agent controls must not install their own click handler or static completion popup. Conjure owns the trusted running/success/error feedback."
        )
    if re.search(r"\b(?:send|email|gmail)\b", prompt, re.I) and not re.search(
        r"send-hello-email", js
    ):
        findings.append(
            "The Gmail demo button must set data-conjure-agent-action=\"send-hello-email\" so the trusted Browserbase action performs the send."
        )
    return findings


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
    ToolSpec("write_file", "Create or overwrite a file; use this to edit a file that already exists.", write_file),
    ToolSpec("edit_file", "Edit an existing file; use '// ... existing code ...' markers for unchanged regions.", edit_file),
    ToolSpec("run_terminal_command", "Run a shell command inside the project workspace.", run_terminal_command),
    ToolSpec("get_tab_content", "Ask the browser extension for live tab content.", get_tab_content),
    ToolSpec("get_console_logs", "Ask the browser extension for captured console logs.", get_console_logs),
    ToolSpec("list_mods", "List the customizations (mods) already built for this project.", list_mods),
    ToolSpec("start_mod", "Start building or editing a mod; routes file tools into its own folder.", start_mod),
    ToolSpec("verify_mod", "Verify a mod by running it in the Browserbase sandbox.", verify_mod),
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
