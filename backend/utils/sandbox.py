from __future__ import annotations

import hashlib
import os
import tempfile
import zipfile
from base64 import b64encode
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Protocol

from backend.utils.extension_validator import validate_extension
from backend.utils.tester import SIMULAR_ENV_KEYS, drive_with_simular, run_scripted_smoke


BROWSERBASE_ENV_KEYS = (
    "BROWSERBASE_API_KEY",
    "BROWSERBASE_PROJECT_ID",
)

SANDBOX_CACHE_TTL_SECONDS = 24 * 60 * 60
HASH_EXCLUDED_DIRS = {".git", "__pycache__", "node_modules"}
HASH_EXCLUDED_SUFFIXES = {".pyc", ".pyo"}


class SandboxCache(Protocol):
    async def get(self, build_hash: str) -> dict[str, Any] | None:
        ...

    async def set(self, build_hash: str, result: dict[str, Any], ttl_seconds: int) -> None:
        ...


@dataclass
class SandboxResult:
    passed: bool
    source: str
    build_hash: str
    target_url: str
    findings: list[str] = field(default_factory=list)
    crashes: list[str] = field(default_factory=list)
    suspicious_behavior: list[str] = field(default_factory=list)
    logs: list[str] = field(default_factory=list)
    screenshot: str | None = None
    replay_url: str | None = None
    cache_hit: bool = False
    env_required: dict[str, list[str]] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)

    def to_cache_dict(self) -> dict[str, Any]:
        data = self.to_dict()
        data.pop("cache_hit", None)
        return data

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "SandboxResult":
        return cls(
            passed=bool(data.get("passed")),
            source=str(data.get("source", "cache")),
            build_hash=str(data.get("build_hash", "")),
            target_url=str(data.get("target_url", "")),
            findings=list(data.get("findings") or []),
            crashes=list(data.get("crashes") or []),
            suspicious_behavior=list(data.get("suspicious_behavior") or []),
            logs=list(data.get("logs") or []),
            screenshot=data.get("screenshot"),
            replay_url=data.get("replay_url"),
            cache_hit=bool(data.get("cache_hit", False)),
            env_required=dict(data.get("env_required") or env_notes()),
        )


async def run_in_sandbox(
    project_dir: str | Path,
    target_url: str,
    feature_description: str | None = None,
    cache: SandboxCache | None = None,
    force_remote: bool | None = None,
) -> SandboxResult:
    root = Path(project_dir).resolve()
    build_hash = compute_extension_hash(root)

    cached = await _get_cached(cache, build_hash)
    if cached is not None:
        cached.cache_hit = True
        cached.env_required = env_notes()
        return cached

    should_run_remote = browserbase_configured() if force_remote is None else force_remote
    if should_run_remote and not browserbase_configured():
        result = SandboxResult(
            passed=False,
            source="browserbase_missing_env",
            build_hash=build_hash,
            target_url=target_url,
            findings=[
                "Browserbase remote sandbox was requested, but BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID are not both configured"
            ],
            env_required=env_notes(),
        )
    elif should_run_remote:
        result = await _run_browserbase_playwright_scaffold(root, target_url, feature_description, build_hash)
    else:
        result = await _run_local_fallback(root, target_url, feature_description, build_hash)

    await _set_cached(cache, build_hash, result)
    return result


def compute_extension_hash(project_dir: str | Path) -> str:
    root = Path(project_dir).resolve()
    if not root.exists():
        raise FileNotFoundError(f"Extension directory does not exist: {root}")

    digest = hashlib.sha256()
    for path in _hashable_files(root):
        relative = path.relative_to(root).as_posix()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        digest.update(path.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def zip_extension(project_dir: str | Path) -> Path:
    root = Path(project_dir).resolve()
    if not root.exists():
        raise FileNotFoundError(f"Extension directory does not exist: {root}")

    temp_dir = Path(tempfile.mkdtemp(prefix="conjure-extension-"))
    zip_path = temp_dir / f"{compute_extension_hash(root)}.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for path in _hashable_files(root):
            archive.write(path, path.relative_to(root).as_posix())
    return zip_path


def browserbase_configured() -> bool:
    return all(os.getenv(key) for key in BROWSERBASE_ENV_KEYS)


def env_notes() -> dict[str, list[str]]:
    return {
        "browserbase": list(BROWSERBASE_ENV_KEYS),
        "simular": list(SIMULAR_ENV_KEYS),
        "sentry": [
            "SENTRY_DSN",
            "SENTRY_ENVIRONMENT",
            "SENTRY_RELEASE",
            "SENTRY_TRACES_SAMPLE_RATE",
            "SENTRY_AUTH_TOKEN",
            "SENTRY_ORG",
            "SENTRY_PROJECT",
        ],
    }


async def _run_local_fallback(
    root: Path,
    target_url: str,
    feature_description: str | None,
    build_hash: str,
) -> SandboxResult:
    validation_issues = validate_extension(root)
    verdict = await run_scripted_smoke(root, target_url, validation_issues, feature_description)
    return SandboxResult(
        passed=verdict.passed,
        source="local_fallback",
        build_hash=build_hash,
        target_url=target_url,
        findings=verdict.findings,
        crashes=verdict.crashes,
        suspicious_behavior=verdict.suspicious_behavior,
        logs=verdict.logs,
        env_required=env_notes(),
    )


async def _run_browserbase_playwright_scaffold(
    root: Path,
    target_url: str,
    feature_description: str | None,
    build_hash: str,
) -> SandboxResult:
    validation_issues = validate_extension(root)
    validation_errors = [issue for issue in validation_issues if issue.get("level") == "error"]
    if validation_errors:
        verdict = await run_scripted_smoke(root, target_url, validation_issues, feature_description)
        return SandboxResult(
            passed=False,
            source="browserbase_preflight",
            build_hash=build_hash,
            target_url=target_url,
            findings=verdict.findings,
            env_required=env_notes(),
        )

    try:
        from browserbase import Browserbase
        from playwright.async_api import async_playwright
    except ImportError as exc:
        return SandboxResult(
            passed=False,
            source="browserbase_scaffold",
            build_hash=build_hash,
            target_url=target_url,
            findings=[
                f"Browserbase remote run skipped because dependency import failed: {exc}",
                "Install browserbase and playwright, then run playwright install chromium",
            ],
            env_required=env_notes(),
        )

    zip_path = zip_extension(root)
    logs: list[str] = []
    replay_url: str | None = None
    screenshot: str | None = None

    try:
        client = Browserbase(api_key=os.environ["BROWSERBASE_API_KEY"])
        extension = client.extensions.create(file=zip_path)
        session = client.sessions.create(
            project_id=os.environ["BROWSERBASE_PROJECT_ID"],
            extension_id=extension.id,
        )
        replay_url = getattr(session, "replay_url", None)

        async with async_playwright() as playwright:
            browser = await playwright.chromium.connect_over_cdp(session.connect_url)
            context = browser.contexts[0] if browser.contexts else await browser.new_context()
            page = context.pages[0] if context.pages else await context.new_page()
            page.on("console", lambda message: logs.append(f"{message.type}: {message.text}"))
            page.on("pageerror", lambda error: logs.append(f"PAGEERROR {error}"))
            await page.goto(target_url)
            screenshot_bytes = await page.screenshot(full_page=True)
            screenshot = "data:image/png;base64," + b64encode(screenshot_bytes).decode("ascii")
            simular = await drive_with_simular(page, feature_description or "Run extension smoke test", target_url)
            await browser.close()

        return SandboxResult(
            passed=simular.passed,
            source="browserbase_playwright",
            build_hash=build_hash,
            target_url=target_url,
            findings=simular.findings,
            crashes=simular.crashes,
            suspicious_behavior=simular.suspicious_behavior,
            logs=logs + simular.logs,
            screenshot=screenshot,
            replay_url=replay_url,
            env_required=env_notes(),
        )
    except Exception as exc:
        return SandboxResult(
            passed=False,
            source="browserbase_playwright",
            build_hash=build_hash,
            target_url=target_url,
            findings=[f"Browserbase sandbox run failed: {exc}"],
            logs=logs,
            replay_url=replay_url,
            screenshot=screenshot,
            env_required=env_notes(),
        )


def _hashable_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for path in root.rglob("*"):
        if not path.is_file():
            continue
        relative_parts = path.relative_to(root).parts
        if any(part in HASH_EXCLUDED_DIRS for part in relative_parts):
            continue
        if path.suffix in HASH_EXCLUDED_SUFFIXES:
            continue
        files.append(path)
    return sorted(files, key=lambda item: item.relative_to(root).as_posix())


async def _get_cached(cache: SandboxCache | None, build_hash: str) -> SandboxResult | None:
    if cache is None:
        return None
    data = await cache.get(build_hash)
    if not data:
        return None
    return SandboxResult.from_dict(data)


async def _set_cached(cache: SandboxCache | None, build_hash: str, result: SandboxResult) -> None:
    if cache is None:
        return
    await cache.set(build_hash, result.to_cache_dict(), SANDBOX_CACHE_TTL_SECONDS)
