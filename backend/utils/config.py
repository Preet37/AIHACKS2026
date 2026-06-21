from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

AgentProvider = Literal["devin", "claude", "nemotron"]

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
    agent_provider: AgentProvider = "devin"
    devin_api_key: str | None = None
    devin_org_id: str | None = None
    devin_api_base_url: str = "https://api.devin.ai/v3"
    devin_mode: str = "normal"
    devin_repos: tuple[str, ...] = ("Preet37/AIHACKS2026",)
    devin_branch: str = "feat/Devin"
    devin_poll_interval_seconds: float = 5
    devin_max_poll_attempts: int = 720
    anthropic_api_key: str | None = None
    anthropic_model: str = "claude-sonnet-4-6"
    nvidia_api_key: str | None = None
    nvidia_model: str = "nvidia/nemotron-3-super-120b-a12b"
    nvidia_api_base_url: str | None = None
    demo_mode: bool = False
    project_root: Path = Path("demo_code")
    terminal_timeout_seconds: int = 30
    browser_request_timeout_seconds: int = 30
    max_read_lines: int = 250
    grep_max_matches: int = 50

    @property
    def effective_demo_mode(self) -> bool:
        if self.demo_mode:
            return True
        if self.agent_provider == "claude":
            return not self.anthropic_api_key
        if self.agent_provider == "nemotron":
            return not self.nvidia_api_key
        return not (self.devin_api_key and self.devin_org_id)

    def resolved_project_root(self) -> Path:
        return self.project_root.expanduser().resolve()


def load_settings() -> Settings:
    return Settings(
        agent_provider=_env_provider("CONJURE_AGENT_PROVIDER", "devin"),
        devin_api_key=os.getenv("DEVIN_API_KEY"),
        devin_org_id=os.getenv("DEVIN_ORG_ID"),
        devin_api_base_url=os.getenv("DEVIN_API_BASE_URL", "https://api.devin.ai/v3"),
        devin_mode=os.getenv("DEVIN_MODE", "normal"),
        devin_repos=_env_csv("DEVIN_REPOS", ("Preet37/AIHACKS2026",)),
        devin_branch=os.getenv("DEVIN_BRANCH", "feat/Devin"),
        devin_poll_interval_seconds=_env_float("DEVIN_POLL_INTERVAL_SECONDS", 5),
        devin_max_poll_attempts=_env_int("DEVIN_MAX_POLL_ATTEMPTS", 720),
        anthropic_api_key=os.getenv("ANTHROPIC_API_KEY"),
        anthropic_model=os.getenv("CONJURE_ANTHROPIC_MODEL", "claude-sonnet-4-6"),
        nvidia_api_key=os.getenv("NVIDIA_API_KEY"),
        nvidia_model=os.getenv("NVIDIA_MODEL", "nvidia/nemotron-3-super-120b-a12b"),
        nvidia_api_base_url=os.getenv("NVIDIA_API_BASE_URL"),
        demo_mode=_env_bool("CONJURE_DEMO_MODE", False),
        project_root=Path(os.getenv("CONJURE_PROJECT_ROOT", "demo_code")),
        terminal_timeout_seconds=_env_int("CONJURE_TERMINAL_TIMEOUT_SECONDS", 30),
        browser_request_timeout_seconds=_env_int("CONJURE_BROWSER_REQUEST_TIMEOUT_SECONDS", 30),
        max_read_lines=_env_int("CONJURE_MAX_READ_LINES", 250),
        grep_max_matches=_env_int("CONJURE_GREP_MAX_MATCHES", 50),
    )


def _env_float(name: str, default: float) -> float:
    raw = os.getenv(name)
    if raw is None:
        return default
    try:
        return float(raw)
    except ValueError:
        return default


def _env_csv(name: str, default: tuple[str, ...]) -> tuple[str, ...]:
    raw = os.getenv(name)
    if raw is None:
        return default
    values = tuple(value.strip() for value in raw.split(",") if value.strip())
    return values or default


def _env_provider(name: str, default: AgentProvider) -> AgentProvider:
    raw = os.getenv(name, default).strip().lower()
    if raw == "claude":
        return "claude"
    if raw == "nemotron":
        return "nemotron"
    return "devin"
