from __future__ import annotations

import inspect
import json
import os
import re
from typing import Any, Awaitable, Callable, Iterable, Mapping, Sequence


RuleExtractor = Callable[
    [Sequence[Mapping[str, Any]], Sequence[str]], Awaitable[Sequence[str]] | Sequence[str]
]


MEMORY_SYSTEM_PROMPT = (
    "Extract concise behavioral directives for future turns. "
    "Do not duplicate existing rules. Return only a JSON array of strings. "
    "Return [] when nothing durable should be remembered."
)


async def extract_rules(
    history: Sequence[Mapping[str, Any]],
    existing_rules: Sequence[str] | None = None,
    *,
    demo_mode: bool | None = None,
    extractor: RuleExtractor | None = None,
) -> list[str]:
    existing = list(existing_rules or [])

    if extractor is not None:
        candidates = await _maybe_await(extractor(history, existing))
        return _dedupe_rules(candidates, existing)

    if demo_mode is None:
        demo_mode = _env_bool("CONJURE_MEMORY_DEMO", False)

    if demo_mode:
        return _dedupe_rules(_extract_demo_candidates(history), existing)

    api_key = os.getenv("ANTHROPIC_API_KEY")
    if not api_key:
        return []

    return _dedupe_rules(await _extract_with_anthropic(history, existing, api_key), existing)


async def load_rules(store: Any, project_id: str) -> list[str]:
    records = await store.list_rules(project_id)
    return [record["content"] for record in records if record.get("content")]


async def save_rules(store: Any, project_id: str, rules: Iterable[str]) -> list[str]:
    saved: list[str] = []
    existing = set(_fingerprint(rule) for rule in await load_rules(store, project_id))
    for rule in rules:
        normalized = _normalize_rule(rule)
        if not normalized:
            continue
        key = _fingerprint(normalized)
        if key in existing:
            continue
        await store.create_rule(project_id, normalized)
        existing.add(key)
        saved.append(normalized)
    return saved


async def extract_and_save_rules(
    store: Any,
    project_id: str,
    history: Sequence[Mapping[str, Any]],
    existing_rules: Sequence[str] | None = None,
    *,
    demo_mode: bool | None = None,
    extractor: RuleExtractor | None = None,
) -> list[str]:
    existing = list(existing_rules) if existing_rules is not None else await load_rules(store, project_id)
    candidates = await extract_rules(
        history,
        existing_rules=existing,
        demo_mode=demo_mode,
        extractor=extractor,
    )
    return await save_rules(store, project_id, candidates)


async def _extract_with_anthropic(
    history: Sequence[Mapping[str, Any]],
    existing_rules: Sequence[str],
    api_key: str,
) -> list[str]:
    try:
        from anthropic import AsyncAnthropic
    except ImportError:
        return []

    model = os.getenv("ANTHROPIC_MEMORY_MODEL", "claude-3-5-haiku-latest")
    client = AsyncAnthropic(api_key=api_key)
    payload = {
        "existing_rules": list(existing_rules),
        "conversation": [
            {"role": item.get("role", ""), "content": item.get("content", "")}
            for item in history
        ],
    }
    try:
        response = await client.messages.create(
            model=model,
            max_tokens=512,
            temperature=0,
            system=MEMORY_SYSTEM_PROMPT,
            messages=[
                {
                    "role": "user",
                    "content": json.dumps(payload, ensure_ascii=True),
                }
            ],
        )
    except Exception:
        return []

    text = _anthropic_text(response)
    parsed = _parse_json_array(text)
    return [item for item in parsed if isinstance(item, str)]


def _anthropic_text(response: Any) -> str:
    parts: list[str] = []
    for block in getattr(response, "content", []) or []:
        text = getattr(block, "text", None)
        if text:
            parts.append(text)
    return "\n".join(parts)


def _parse_json_array(text: str) -> list[Any]:
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\[[\s\S]*\]", text)
        if not match:
            return []
        try:
            parsed = json.loads(match.group(0))
        except json.JSONDecodeError:
            return []
    return parsed if isinstance(parsed, list) else []


def _extract_demo_candidates(history: Sequence[Mapping[str, Any]]) -> list[str]:
    candidates: list[str] = []
    for item in history:
        if item.get("role") not in {"user", "human"}:
            continue
        content = str(item.get("content", ""))
        candidates.extend(_extract_pattern(content, r"remember that\s+([^.!?]+[.!?]?)"))
        candidates.extend(_extract_pattern(content, r"\b(always\s+[^.!?]+[.!?]?)"))
        candidates.extend(_extract_pattern(content, r"\b(never\s+[^.!?]+[.!?]?)"))
        candidates.extend(_extract_pattern(content, r"\b(?:i|we)\s+(prefer\s+[^.!?]+[.!?]?)"))
    return candidates


def _extract_pattern(content: str, pattern: str) -> list[str]:
    return [match.group(1) for match in re.finditer(pattern, content, flags=re.IGNORECASE)]


def _dedupe_rules(
    candidates: Iterable[str],
    existing_rules: Sequence[str],
) -> list[str]:
    seen = {_fingerprint(rule) for rule in existing_rules}
    rules: list[str] = []
    for candidate in candidates:
        normalized = _normalize_rule(candidate)
        if not normalized:
            continue
        key = _fingerprint(normalized)
        if key in seen:
            continue
        seen.add(key)
        rules.append(normalized)
    return rules


def _normalize_rule(rule: str) -> str:
    text = re.sub(r"\s+", " ", str(rule)).strip()
    text = re.sub(r"^(that\s+)?(?:i|we)\s+", "", text, flags=re.IGNORECASE)
    if not text:
        return ""
    text = text[0].upper() + text[1:]
    if text[-1] not in ".!?":
        text += "."
    return text


def _fingerprint(rule: str) -> str:
    return re.sub(r"\s+", " ", rule.strip().rstrip(".!?").lower())


async def _maybe_await(value: Awaitable[Sequence[str]] | Sequence[str]) -> Sequence[str]:
    if inspect.isawaitable(value):
        return await value
    return value


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}
