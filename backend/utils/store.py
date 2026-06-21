from __future__ import annotations

import json
import os
import time
import uuid
from dataclasses import dataclass
from inspect import isawaitable
from typing import Any, Callable, Mapping, Protocol


DEFAULT_REDIS_URL = "redis://localhost:6379/0"
DEFAULT_SANDBOX_RESULT_TTL_SECONDS = 24 * 60 * 60


class Store(Protocol):
    async def create_project(
        self,
        name: str,
        *,
        project_id: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        ...

    async def create_conversation(
        self,
        project_id: str,
        *,
        title: str = "",
        conversation_id: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        ...

    async def create_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        *,
        message_id: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        ...

    async def get_history(self, conversation_id: str) -> list[dict[str, Any]]:
        ...

    async def create_rule(
        self,
        project_id: str,
        content: str,
        *,
        rule_id: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        ...

    async def list_rules(self, project_id: str) -> list[dict[str, Any]]:
        ...


@dataclass(frozen=True)
class StoreConfig:
    redis_url: str = DEFAULT_REDIS_URL
    allow_memory_fallback: bool = True
    sandbox_result_ttl_seconds: int = DEFAULT_SANDBOX_RESULT_TTL_SECONDS

    @classmethod
    def from_env(cls) -> "StoreConfig":
        redis_url = (
            os.getenv("CONJURE_REDIS_URL")
            or os.getenv("REDIS_URL")
            or DEFAULT_REDIS_URL
        )
        return cls(
            redis_url=redis_url,
            allow_memory_fallback=_env_bool("CONJURE_REDIS_FALLBACK", True),
            sandbox_result_ttl_seconds=_env_int(
                "CONJURE_SANDBOX_RESULT_TTL_SECONDS",
                DEFAULT_SANDBOX_RESULT_TTL_SECONDS,
            ),
        )


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None:
        return default
    try:
        return int(value)
    except ValueError:
        return default


def _new_id() -> str:
    return uuid.uuid4().hex


def _as_text(value: Any) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    return str(value)


def _coerce_number(value: Any) -> int | float:
    if isinstance(value, (int, float)):
        return int(value) if float(value).is_integer() else float(value)
    text = _as_text(value)
    try:
        number = float(text)
    except ValueError:
        return 0
    return int(number) if number.is_integer() else number


def _coerce_optional_number(value: Any) -> int | float | None:
    if value is None or value == "":
        return None
    return _coerce_number(value)


def _timestamp(now: Callable[[], float]) -> int | float:
    return _coerce_number(now())


def _decode_hash(raw: Mapping[Any, Any]) -> dict[str, str]:
    return {_as_text(key): _as_text(value) for key, value in raw.items()}


def _json_dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"))


def _json_loads(value: str, default: Any) -> Any:
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def _bool_to_redis(value: Any) -> str:
    return "true" if bool(value) else "false"


def _bool_from_redis(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    return _as_text(value).strip().lower() in {"1", "true", "yes", "on"}


def _clean_mapping(mapping: Mapping[str, Any]) -> dict[str, str]:
    return {key: _as_text(value) for key, value in mapping.items() if value is not None}


class RedisStore:
    def __init__(
        self,
        redis_client: Any,
        *,
        now: Callable[[], float] | None = None,
        sandbox_result_ttl_seconds: int = DEFAULT_SANDBOX_RESULT_TTL_SECONDS,
    ) -> None:
        self.redis = redis_client
        self._now = now or time.time
        self.sandbox_result_ttl_seconds = sandbox_result_ttl_seconds

    async def create_project(
        self,
        name: str,
        *,
        project_id: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        pid = project_id or _new_id()
        created = _coerce_number(created_at) if created_at is not None else self._ts()
        record = {"id": pid, "name": name, "created_at": created}
        await self.redis.hset(f"project:{pid}", mapping=_clean_mapping(record))
        await self.redis.zadd("projects", {pid: created})
        return record

    async def get_project(self, project_id: str) -> dict[str, Any] | None:
        raw = await self.redis.hgetall(f"project:{project_id}")
        if not raw:
            return None
        return self._project_from_hash(raw)

    async def list_projects(self, *, start: int = 0, end: int = -1) -> list[dict[str, Any]]:
        ids = await self.redis.zrange("projects", start, end)
        return await self._load_hashes(ids, "project", self._project_from_hash)

    async def create_conversation(
        self,
        project_id: str,
        *,
        title: str = "",
        conversation_id: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        cid = conversation_id or _new_id()
        created = _coerce_number(created_at) if created_at is not None else self._ts()
        record = {
            "id": cid,
            "project_id": project_id,
            "title": title,
            "created_at": created,
        }
        await self.redis.hset(f"conversation:{cid}", mapping=_clean_mapping(record))
        await self.redis.zadd(f"project:{project_id}:conversations", {cid: created})
        return record

    async def get_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        raw = await self.redis.hgetall(f"conversation:{conversation_id}")
        if not raw:
            return None
        return self._conversation_from_hash(raw)

    async def list_conversations(self, project_id: str) -> list[dict[str, Any]]:
        ids = await self.redis.zrange(f"project:{project_id}:conversations", 0, -1)
        return await self._load_hashes(ids, "conversation", self._conversation_from_hash)

    async def create_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        *,
        message_id: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        mid = message_id or _new_id()
        created = _coerce_number(created_at) if created_at is not None else self._ts()
        record = {
            "id": mid,
            "conversation_id": conversation_id,
            "role": role,
            "content": content,
            "created_at": created,
        }
        await self.redis.hset(f"message:{mid}", mapping=_clean_mapping(record))
        await self.redis.zadd(f"conversation:{conversation_id}:messages", {mid: created})
        return record

    async def get_history(self, conversation_id: str) -> list[dict[str, Any]]:
        ids = await self.redis.zrange(f"conversation:{conversation_id}:messages", 0, -1)
        return await self._load_hashes(ids, "message", self._message_from_hash)

    async def create_rule(
        self,
        project_id: str,
        content: str,
        *,
        rule_id: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        rid = rule_id or _new_id()
        created = _coerce_number(created_at) if created_at is not None else self._ts()
        record = {
            "id": rid,
            "project_id": project_id,
            "content": content,
            "created_at": created,
        }
        await self.redis.hset(f"rule:{rid}", mapping=_clean_mapping(record))
        await self.redis.zadd(f"project:{project_id}:rules", {rid: created})
        return record

    async def list_rules(self, project_id: str) -> list[dict[str, Any]]:
        ids = await self.redis.zrange(f"project:{project_id}:rules", 0, -1)
        return await self._load_hashes(ids, "rule", self._rule_from_hash)

    async def delete_rule(self, project_id: str, rule_id: str) -> None:
        await self.redis.delete(f"rule:{rule_id}")
        await self.redis.zrem(f"project:{project_id}:rules", rule_id)

    async def set_sandbox_result(
        self,
        build_hash: str,
        result: Mapping[str, Any],
        *,
        ttl_seconds: int | None = None,
    ) -> dict[str, Any]:
        ttl = ttl_seconds or self.sandbox_result_ttl_seconds
        tested_at = result.get("tested_at", self._ts())
        record = {
            "build_hash": build_hash,
            "passed": bool(result.get("passed", False)),
            "findings": list(result.get("findings", [])),
            "replay_url": result.get("replay_url", ""),
            "tested_at": _coerce_number(tested_at),
        }
        key = f"sandbox:result:{build_hash}"
        await self.redis.hset(
            key,
            mapping={
                "passed": _bool_to_redis(record["passed"]),
                "findings_json": _json_dumps(record["findings"]),
                "replay_url": record["replay_url"],
                "tested_at": record["tested_at"],
            },
        )
        await self.redis.expire(key, ttl)
        return record

    async def get_sandbox_result(self, build_hash: str) -> dict[str, Any] | None:
        raw = await self.redis.hgetall(f"sandbox:result:{build_hash}")
        if not raw:
            return None
        data = _decode_hash(raw)
        return {
            "build_hash": build_hash,
            "passed": _bool_from_redis(data.get("passed", "false")),
            "findings": _json_loads(data.get("findings_json", "[]"), []),
            "replay_url": data.get("replay_url", ""),
            "tested_at": _coerce_number(data.get("tested_at", 0)),
        }

    async def set_job_state(
        self,
        job_id: str,
        *,
        project_id: str,
        status: str,
        iteration: int | None = None,
        current_step: str | None = None,
        build_hash: str | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        record: dict[str, Any] = {
            "id": job_id,
            "project_id": project_id,
            "status": status,
            "iteration": iteration,
            "current_step": current_step,
            "build_hash": build_hash,
            **extra,
        }
        await self.redis.hset(f"job:{job_id}", mapping=_clean_mapping(record))
        await self.redis.set(f"project:{project_id}:active_job", job_id)
        return self._job_from_hash(record)

    async def get_job_state(self, job_id: str) -> dict[str, Any] | None:
        raw = await self.redis.hgetall(f"job:{job_id}")
        if not raw:
            return None
        return self._job_from_hash(raw)

    async def set_active_job(self, project_id: str, job_id: str) -> None:
        await self.redis.set(f"project:{project_id}:active_job", job_id)

    async def get_active_job(self, project_id: str) -> str | None:
        value = await self.redis.get(f"project:{project_id}:active_job")
        if value is None:
            return None
        return _as_text(value)

    async def append_job_event(
        self,
        job_id: str,
        event_type: str,
        payload: Mapping[str, Any],
    ) -> str:
        event_id = await self.redis.xadd(
            f"job:{job_id}:events",
            {
                "type": event_type,
                "payload_json": _json_dumps(dict(payload)),
                "created_at": self._ts(),
            },
        )
        return _as_text(event_id)

    async def get_job_events(
        self,
        job_id: str,
        *,
        start: str = "-",
        end: str = "+",
        count: int | None = None,
    ) -> list[dict[str, Any]]:
        rows = await self.redis.xrange(
            f"job:{job_id}:events", min=start, max=end, count=count
        )
        return [self._event_from_stream_row(row) for row in rows]

    async def delete_conversation(self, conversation_id: str) -> None:
        message_ids = await self.redis.zrange(
            f"conversation:{conversation_id}:messages", 0, -1
        )
        await self.redis.delete(
            f"conversation:{conversation_id}",
            f"conversation:{conversation_id}:messages",
            *[f"message:{_as_text(mid)}" for mid in message_ids],
        )

    async def delete_project(self, project_id: str) -> None:
        conversation_ids = await self.redis.zrange(
            f"project:{project_id}:conversations", 0, -1
        )
        rule_ids = await self.redis.zrange(f"project:{project_id}:rules", 0, -1)
        for conversation_id in conversation_ids:
            await self.delete_conversation(_as_text(conversation_id))
        await self.redis.delete(
            f"project:{project_id}",
            f"project:{project_id}:conversations",
            f"project:{project_id}:rules",
            f"project:{project_id}:active_job",
            *[f"rule:{_as_text(rid)}" for rid in rule_ids],
        )
        await self.redis.zrem("projects", project_id)

    async def close(self) -> None:
        close = getattr(self.redis, "aclose", None) or getattr(self.redis, "close", None)
        if close is None:
            return
        result = close()
        if hasattr(result, "__await__"):
            await result

    cache_sandbox_result = set_sandbox_result
    add_project = create_project
    add_conversation = create_conversation
    add_message = create_message
    add_rule = create_rule

    def _ts(self) -> int | float:
        return _timestamp(self._now)

    async def _load_hashes(
        self,
        ids: list[Any],
        prefix: str,
        parser: Callable[[Mapping[Any, Any]], dict[str, Any]],
    ) -> list[dict[str, Any]]:
        if not ids:
            return []

        pipeline_factory = getattr(self.redis, "pipeline", None)
        if callable(pipeline_factory):
            pipe = pipeline_factory()
            if hasattr(pipe, "__aenter__"):
                async with pipe as active_pipe:
                    for item_id in ids:
                        active_pipe.hgetall(f"{prefix}:{_as_text(item_id)}")
                    raw_records = await active_pipe.execute()
            else:
                for item_id in ids:
                    pipe.hgetall(f"{prefix}:{_as_text(item_id)}")
                execute_result = pipe.execute()
                raw_records = (
                    await execute_result
                    if isawaitable(execute_result)
                    else execute_result
                )
            return [parser(raw) for raw in raw_records if raw]

        records: list[dict[str, Any]] = []
        for item_id in ids:
            raw = await self.redis.hgetall(f"{prefix}:{_as_text(item_id)}")
            if raw:
                records.append(parser(raw))
        return records

    def _project_from_hash(self, raw: Mapping[Any, Any]) -> dict[str, Any]:
        data = _decode_hash(raw)
        return {
            "id": data["id"],
            "name": data.get("name", ""),
            "created_at": _coerce_number(data.get("created_at", 0)),
        }

    def _conversation_from_hash(self, raw: Mapping[Any, Any]) -> dict[str, Any]:
        data = _decode_hash(raw)
        return {
            "id": data["id"],
            "project_id": data.get("project_id", ""),
            "title": data.get("title", ""),
            "created_at": _coerce_number(data.get("created_at", 0)),
        }

    def _message_from_hash(self, raw: Mapping[Any, Any]) -> dict[str, Any]:
        data = _decode_hash(raw)
        return {
            "id": data["id"],
            "conversation_id": data.get("conversation_id", ""),
            "role": data.get("role", ""),
            "content": data.get("content", ""),
            "created_at": _coerce_number(data.get("created_at", 0)),
        }

    def _rule_from_hash(self, raw: Mapping[Any, Any]) -> dict[str, Any]:
        data = _decode_hash(raw)
        return {
            "id": data["id"],
            "project_id": data.get("project_id", ""),
            "content": data.get("content", ""),
            "created_at": _coerce_number(data.get("created_at", 0)),
        }

    def _job_from_hash(self, raw: Mapping[Any, Any]) -> dict[str, Any]:
        data = _decode_hash(raw)
        record: dict[str, Any] = {
            "id": data.get("id", ""),
            "project_id": data.get("project_id", ""),
            "status": data.get("status", ""),
        }
        iteration = _coerce_optional_number(data.get("iteration"))
        if iteration is not None:
            record["iteration"] = iteration
        for key in ("current_step", "build_hash"):
            if data.get(key):
                record[key] = data[key]
        for key, value in data.items():
            if key not in record and value != "":
                record[key] = value
        return record

    def _event_from_stream_row(self, row: Any) -> dict[str, Any]:
        event_id, raw_fields = row
        fields = _decode_hash(raw_fields)
        return {
            "id": _as_text(event_id),
            "type": fields.get("type", ""),
            "payload": _json_loads(fields.get("payload_json", "{}"), {}),
        }


class InMemoryStore:
    def __init__(
        self,
        *,
        now: Callable[[], float] | None = None,
        sandbox_result_ttl_seconds: int = DEFAULT_SANDBOX_RESULT_TTL_SECONDS,
    ) -> None:
        self._now = now or time.time
        self.sandbox_result_ttl_seconds = sandbox_result_ttl_seconds
        self.projects: dict[str, dict[str, Any]] = {}
        self.project_order: dict[str, float] = {}
        self.conversations: dict[str, dict[str, Any]] = {}
        self.project_conversations: dict[str, dict[str, float]] = {}
        self.messages: dict[str, dict[str, Any]] = {}
        self.conversation_messages: dict[str, dict[str, float]] = {}
        self.rules: dict[str, dict[str, Any]] = {}
        self.project_rules: dict[str, dict[str, float]] = {}
        self.sandbox_results: dict[str, tuple[dict[str, Any], float]] = {}
        self.jobs: dict[str, dict[str, Any]] = {}
        self.active_jobs: dict[str, str] = {}
        self.job_events: dict[str, list[dict[str, Any]]] = {}

    async def create_project(
        self,
        name: str,
        *,
        project_id: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        pid = project_id or _new_id()
        created = _coerce_number(created_at) if created_at is not None else self._ts()
        record = {"id": pid, "name": name, "created_at": created}
        self.projects[pid] = dict(record)
        self.project_order[pid] = float(created)
        return dict(record)

    async def get_project(self, project_id: str) -> dict[str, Any] | None:
        return self._copy_or_none(self.projects.get(project_id))

    async def list_projects(self, *, start: int = 0, end: int = -1) -> list[dict[str, Any]]:
        ids = self._sorted_ids(self.project_order, start, end)
        return [dict(self.projects[pid]) for pid in ids if pid in self.projects]

    async def create_conversation(
        self,
        project_id: str,
        *,
        title: str = "",
        conversation_id: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        cid = conversation_id or _new_id()
        created = _coerce_number(created_at) if created_at is not None else self._ts()
        record = {
            "id": cid,
            "project_id": project_id,
            "title": title,
            "created_at": created,
        }
        self.conversations[cid] = dict(record)
        self.project_conversations.setdefault(project_id, {})[cid] = float(created)
        return dict(record)

    async def get_conversation(self, conversation_id: str) -> dict[str, Any] | None:
        return self._copy_or_none(self.conversations.get(conversation_id))

    async def list_conversations(self, project_id: str) -> list[dict[str, Any]]:
        ids = self._sorted_ids(self.project_conversations.get(project_id, {}), 0, -1)
        return [dict(self.conversations[cid]) for cid in ids if cid in self.conversations]

    async def create_message(
        self,
        conversation_id: str,
        role: str,
        content: str,
        *,
        message_id: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        mid = message_id or _new_id()
        created = _coerce_number(created_at) if created_at is not None else self._ts()
        record = {
            "id": mid,
            "conversation_id": conversation_id,
            "role": role,
            "content": content,
            "created_at": created,
        }
        self.messages[mid] = dict(record)
        self.conversation_messages.setdefault(conversation_id, {})[mid] = float(created)
        return dict(record)

    async def get_history(self, conversation_id: str) -> list[dict[str, Any]]:
        ids = self._sorted_ids(self.conversation_messages.get(conversation_id, {}), 0, -1)
        return [dict(self.messages[mid]) for mid in ids if mid in self.messages]

    async def create_rule(
        self,
        project_id: str,
        content: str,
        *,
        rule_id: str | None = None,
        created_at: float | None = None,
    ) -> dict[str, Any]:
        rid = rule_id or _new_id()
        created = _coerce_number(created_at) if created_at is not None else self._ts()
        record = {
            "id": rid,
            "project_id": project_id,
            "content": content,
            "created_at": created,
        }
        self.rules[rid] = dict(record)
        self.project_rules.setdefault(project_id, {})[rid] = float(created)
        return dict(record)

    async def list_rules(self, project_id: str) -> list[dict[str, Any]]:
        ids = self._sorted_ids(self.project_rules.get(project_id, {}), 0, -1)
        return [dict(self.rules[rid]) for rid in ids if rid in self.rules]

    async def delete_rule(self, project_id: str, rule_id: str) -> None:
        self.rules.pop(rule_id, None)
        self.project_rules.get(project_id, {}).pop(rule_id, None)

    async def set_sandbox_result(
        self,
        build_hash: str,
        result: Mapping[str, Any],
        *,
        ttl_seconds: int | None = None,
    ) -> dict[str, Any]:
        ttl = ttl_seconds or self.sandbox_result_ttl_seconds
        tested_at = result.get("tested_at", self._ts())
        record = {
            "build_hash": build_hash,
            "passed": bool(result.get("passed", False)),
            "findings": list(result.get("findings", [])),
            "replay_url": result.get("replay_url", ""),
            "tested_at": _coerce_number(tested_at),
        }
        self.sandbox_results[build_hash] = (dict(record), float(self._ts()) + ttl)
        return dict(record)

    async def get_sandbox_result(self, build_hash: str) -> dict[str, Any] | None:
        cached = self.sandbox_results.get(build_hash)
        if cached is None:
            return None
        record, expires_at = cached
        if float(self._ts()) >= expires_at:
            self.sandbox_results.pop(build_hash, None)
            return None
        return dict(record)

    async def set_job_state(
        self,
        job_id: str,
        *,
        project_id: str,
        status: str,
        iteration: int | None = None,
        current_step: str | None = None,
        build_hash: str | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        record = {
            "id": job_id,
            "project_id": project_id,
            "status": status,
            **({"iteration": iteration} if iteration is not None else {}),
            **({"current_step": current_step} if current_step else {}),
            **({"build_hash": build_hash} if build_hash else {}),
            **extra,
        }
        self.jobs[job_id] = dict(record)
        self.active_jobs[project_id] = job_id
        return dict(record)

    async def get_job_state(self, job_id: str) -> dict[str, Any] | None:
        return self._copy_or_none(self.jobs.get(job_id))

    async def set_active_job(self, project_id: str, job_id: str) -> None:
        self.active_jobs[project_id] = job_id

    async def get_active_job(self, project_id: str) -> str | None:
        return self.active_jobs.get(project_id)

    async def append_job_event(
        self,
        job_id: str,
        event_type: str,
        payload: Mapping[str, Any],
    ) -> str:
        events = self.job_events.setdefault(job_id, [])
        event_id = f"{len(events) + 1}-0"
        events.append({"id": event_id, "type": event_type, "payload": dict(payload)})
        return event_id

    async def get_job_events(
        self,
        job_id: str,
        *,
        start: str = "-",
        end: str = "+",
        count: int | None = None,
    ) -> list[dict[str, Any]]:
        events = [dict(event) for event in self.job_events.get(job_id, [])]
        if start != "-":
            events = [event for event in events if event["id"] >= start]
        if end != "+":
            events = [event for event in events if event["id"] <= end]
        if count is not None:
            events = events[:count]
        return events

    async def delete_conversation(self, conversation_id: str) -> None:
        message_ids = list(self.conversation_messages.get(conversation_id, {}))
        for message_id in message_ids:
            self.messages.pop(message_id, None)
        self.conversation_messages.pop(conversation_id, None)
        conversation = self.conversations.pop(conversation_id, None)
        if conversation:
            project_id = conversation["project_id"]
            self.project_conversations.get(project_id, {}).pop(conversation_id, None)

    async def delete_project(self, project_id: str) -> None:
        conversation_ids = list(self.project_conversations.get(project_id, {}))
        for conversation_id in conversation_ids:
            await self.delete_conversation(conversation_id)
        rule_ids = list(self.project_rules.get(project_id, {}))
        for rule_id in rule_ids:
            await self.delete_rule(project_id, rule_id)
        self.projects.pop(project_id, None)
        self.project_order.pop(project_id, None)
        self.project_conversations.pop(project_id, None)
        self.project_rules.pop(project_id, None)
        self.active_jobs.pop(project_id, None)

    async def close(self) -> None:
        return None

    cache_sandbox_result = set_sandbox_result
    add_project = create_project
    add_conversation = create_conversation
    add_message = create_message
    add_rule = create_rule

    def _ts(self) -> int | float:
        return _timestamp(self._now)

    def _sorted_ids(
        self, scores: Mapping[str, float], start: int, end: int
    ) -> list[str]:
        ids = [item_id for item_id, _score in sorted(scores.items(), key=lambda item: item[1])]
        if end == -1:
            return ids[start:]
        return ids[start : end + 1]

    def _copy_or_none(self, value: dict[str, Any] | None) -> dict[str, Any] | None:
        return dict(value) if value is not None else None


async def create_store(
    *,
    redis_url: str | None = None,
    redis_client: Any | None = None,
    allow_memory_fallback: bool | None = None,
    now: Callable[[], float] | None = None,
    sandbox_result_ttl_seconds: int | None = None,
) -> RedisStore | InMemoryStore:
    config = StoreConfig.from_env()
    url = redis_url or config.redis_url
    fallback = config.allow_memory_fallback if allow_memory_fallback is None else allow_memory_fallback
    ttl = sandbox_result_ttl_seconds or config.sandbox_result_ttl_seconds

    if redis_client is not None:
        return await _redis_store_or_fallback(
            redis_client,
            allow_memory_fallback=fallback,
            now=now,
            sandbox_result_ttl_seconds=ttl,
        )

    try:
        import redis.asyncio as redis
    except ImportError as exc:
        if fallback:
            return InMemoryStore(now=now, sandbox_result_ttl_seconds=ttl)
        raise ConnectionError("redis package is not installed") from exc

    client = redis.from_url(url, decode_responses=True)
    return await _redis_store_or_fallback(
        client,
        allow_memory_fallback=fallback,
        now=now,
        sandbox_result_ttl_seconds=ttl,
    )


async def _redis_store_or_fallback(
    redis_client: Any,
    *,
    allow_memory_fallback: bool,
    now: Callable[[], float] | None,
    sandbox_result_ttl_seconds: int,
) -> RedisStore | InMemoryStore:
    try:
        await redis_client.ping()
    except Exception as exc:
        close = getattr(redis_client, "aclose", None)
        if close is not None:
            result = close()
            if hasattr(result, "__await__"):
                await result
        if allow_memory_fallback:
            return InMemoryStore(now=now, sandbox_result_ttl_seconds=sandbox_result_ttl_seconds)
        raise ConnectionError("Redis is unavailable and memory fallback is disabled") from exc

    return RedisStore(
        redis_client,
        now=now,
        sandbox_result_ttl_seconds=sandbox_result_ttl_seconds,
    )
