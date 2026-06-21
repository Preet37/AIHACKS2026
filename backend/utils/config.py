from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

try:
    from dotenv import load_dotenv
except ImportError:  # pragma: no cover
    load_dotenv = None


if load_dotenv is not None:
    load_dotenv()


AgentProvider = Literal["claude", "groq", "nemotron"]


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


def _env_provider(name: str, default: str) -> AgentProvider:
    raw = os.getenv(name, default).strip().lower()
    if raw in ("claude", "groq", "nemotron"):
        return raw  # type: ignore[return-value]
    return "claude"


@dataclass(slots=True)
class Settings:
    agent_provider: AgentProvider = "claude"
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-sonnet-4-6"
    groq_api_key: str | None = None
    groq_model: str = "qwen/qwen3-32b"
    nvidia_api_key: str | None = None
    nvidia_model: str = "meta/llama-3.3-70b-instruct"
    nvidia_api_base_url: str | None = None
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

    @property
    def active_provider(self) -> AgentProvider:
        return self.agent_provider

    def resolved_project_root(self) -> Path:
        return self.project_root.expanduser().resolve()


def load_settings() -> Settings:
    return Settings(
        agent_provider=_env_provider("CONJURE_AGENT_PROVIDER", "claude"),
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY"),
        anthropic_model=os.getenv("CONJURE_ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        groq_api_key=os.getenv("GROQ_API_KEY"),
        groq_model=os.getenv("GROQ_MODEL", "qwen/qwen3-32b"),
        nvidia_api_key=os.getenv("NVIDIA_API_KEY"),
        nvidia_model=os.getenv("NVIDIA_MODEL", "meta/llama-3.3-70b-instruct"),
        nvidia_api_base_url=os.getenv("NVIDIA_API_BASE_URL"),
        demo_mode=_env_bool("CONJURE_DEMO_MODE", False),
        project_root=Path(os.getenv("CONJURE_PROJECT_ROOT", "demo_code")),
        terminal_timeout_seconds=_env_int("CONJURE_TERMINAL_TIMEOUT_SECONDS", 30),
        browser_request_timeout_seconds=_env_int("CONJURE_BROWSER_REQUEST_TIMEOUT_SECONDS", 30),
        max_read_lines=_env_int("CONJURE_MAX_READ_LINES", 250),
        grep_max_matches=_env_int("CONJURE_GREP_MAX_MATCHES", 50),
        max_agent_iterations=_env_int("CONJURE_MAX_AGENT_ITERATIONS", 25),
    )
