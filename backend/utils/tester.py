from __future__ import annotations

import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import urlparse


SIMULAR_ENV_KEYS = ("SIMULAR_API_KEY",)


@dataclass
class TesterVerdict:
    passed: bool
    source: str
    findings: list[str] = field(default_factory=list)
    crashes: list[str] = field(default_factory=list)
    suspicious_behavior: list[str] = field(default_factory=list)
    logs: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


async def run_scripted_smoke(
    project_dir: str | Path,
    target_url: str,
    validation_issues: Iterable[dict[str, str]] = (),
    feature_description: str | None = None,
) -> TesterVerdict:
    """Deterministic smoke gate used before Browserbase/Simular are configured."""
    del project_dir, feature_description

    findings: list[str] = []
    errors = [issue for issue in validation_issues if issue.get("level") == "error"]
    warnings = [issue for issue in validation_issues if issue.get("level") == "warning"]

    for issue in errors:
        findings.append(f"Static validation error: {issue.get('message', 'unknown error')}")
    for issue in warnings:
        findings.append(f"Static validation warning: {issue.get('message', 'unknown warning')}")

    parsed = urlparse(target_url)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        findings.append(f"Target URL '{target_url}' is not an absolute http(s) URL")

    if errors:
        return TesterVerdict(passed=False, source="scripted_smoke", findings=findings)

    findings.append("Scripted smoke passed: manifest parsed, referenced files exist, and JS syntax was checked when node was available")
    return TesterVerdict(passed=True, source="scripted_smoke", findings=findings)


async def drive_with_simular(
    page: Any,
    feature_description: str,
    target_url: str | None = None,
) -> TesterVerdict:
    """Future Simular/Sai integration boundary.

    The hosted Simular/Sai API contract is intentionally isolated here so the
    sandbox layer does not change when that client is added.
    """
    del page, target_url

    if not simular_configured():
        return TesterVerdict(
            passed=True,
            source="simular_unconfigured",
            findings=[
                "Simular agentic pass skipped: configure SIMULAR_API_KEY when a hosted Simular API is available",
                f"Feature prompt reserved for Simular: {feature_description}",
            ],
        )

    return TesterVerdict(
        passed=False,
        source="simular_scaffold",
        findings=["Simular credentials are present, but the hosted tester client is not wired in this scaffold"],
    )


def simular_configured() -> bool:
    return any(os.getenv(key) for key in SIMULAR_ENV_KEYS)


def env_notes() -> dict[str, list[str]]:
    return {
        "simular": list(SIMULAR_ENV_KEYS),
        "notes": [
            "SIMULAR_API_KEY is reserved for the hosted Simular/Sai tester once API access is available",
        ],
    }
