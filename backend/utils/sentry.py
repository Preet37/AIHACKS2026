from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Any, Iterator


SENTRY_CAPTURE_ENV_KEYS = (
    "SENTRY_DSN",
    "SENTRY_ENVIRONMENT",
    "SENTRY_RELEASE",
    "SENTRY_TRACES_SAMPLE_RATE",
)

SENTRY_ISSUE_ENV_KEYS = (
    "SENTRY_AUTH_TOKEN",
    "SENTRY_ORG",
    "SENTRY_PROJECT",
)


def init_sentry(
    service: str,
    project_id: str | None = None,
    conversation_id: str | None = None,
) -> bool:
    dsn = os.getenv("SENTRY_DSN")
    if not dsn:
        return False

    try:
        import sentry_sdk
    except ImportError:
        return False

    sentry_sdk.init(
        dsn=dsn,
        environment=os.getenv("SENTRY_ENVIRONMENT", "development"),
        release=os.getenv("SENTRY_RELEASE"),
        traces_sample_rate=_float_env("SENTRY_TRACES_SAMPLE_RATE", 0.0),
    )
    sentry_sdk.set_tag("service", service)
    if project_id:
        sentry_sdk.set_tag("project_id", project_id)
    if conversation_id:
        sentry_sdk.set_tag("conversation_id", conversation_id)
    return True


@contextmanager
def sentry_scope(**tags: str | None) -> Iterator[None]:
    try:
        import sentry_sdk
    except ImportError:
        yield
        return

    with sentry_sdk.push_scope() as scope:
        for key, value in tags.items():
            if value is not None:
                scope.set_tag(key, value)
        yield


def capture_exception(exc: BaseException, **tags: str | None) -> str | None:
    try:
        import sentry_sdk
    except ImportError:
        return None

    with sentry_scope(**tags):
        return sentry_sdk.capture_exception(exc)


def capture_message(message: str, level: str = "info", **tags: str | None) -> str | None:
    try:
        import sentry_sdk
    except ImportError:
        return None

    with sentry_scope(**tags):
        return sentry_sdk.capture_message(message, level=level)


async def get_sentry_issues(project_id: str, limit: int = 20) -> dict[str, Any]:
    missing = [key for key in SENTRY_ISSUE_ENV_KEYS if not os.getenv(key)]
    if missing:
        return {
            "project_id": project_id,
            "issues": [],
            "configured": False,
            "missing_env": missing,
            "notes": "Sentry issue lookup requires SENTRY_AUTH_TOKEN, SENTRY_ORG, and SENTRY_PROJECT",
        }

    return {
        "project_id": project_id,
        "issues": [],
        "configured": True,
        "limit": limit,
        "notes": "Sentry issue lookup API client is scaffolded; wire this to Sentry's REST API before enabling self-heal tools",
    }


def env_notes() -> dict[str, list[str]]:
    return {
        "capture": list(SENTRY_CAPTURE_ENV_KEYS),
        "issue_lookup": list(SENTRY_ISSUE_ENV_KEYS),
    }


def _float_env(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return float(value)
    except ValueError:
        return default
