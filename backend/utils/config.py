from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover - dependency is optional for import-only tests
    load_dotenv = None


if load_dotenv is not None:
    load_dotenv()


def _env_bool(name: str, default: bool = False) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return int(raw)
    except ValueError:
        return default


@dataclass(slots=True)
class Settings:
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-sonnet-4-6"
    demo_mode: bool = False
    project_root: Path = Path("demo_code")
    terminal_timeout_seconds: int = 30
    browser_request_timeout_seconds: int = 30
    max_read_lines: int = 250
    grep_max_matches: int = 50
    max_agent_iterations: int = 25

    @property
    def effective_demo_mode(self) -> bool:
        return self.demo_mode or not self.anthropic_api_key

    def resolved_project_root(self) -> Path:
        return self.project_root.expanduser().resolve()


def load_settings() -> Settings:
    return Settings(
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY"),
        anthropic_model=os.getenv("CONJURE_ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        demo_mode=_env_bool("CONJURE_DEMO_MODE", False),
        project_root=Path(os.getenv("CONJURE_PROJECT_ROOT", "demo_code")),
        terminal_timeout_seconds=_env_int("CONJURE_TERMINAL_TIMEOUT_SECONDS", 30),
        browser_request_timeout_seconds=_env_int("CONJURE_BROWSER_REQUEST_TIMEOUT_SECONDS", 30),
        max_read_lines=_env_int("CONJURE_MAX_READ_LINES", 250),
        grep_max_matches=_env_int("CONJURE_GREP_MAX_MATCHES", 50),
        max_agent_iterations=_env_int("CONJURE_MAX_AGENT_ITERATIONS", 25),
    )
