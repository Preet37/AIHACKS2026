import asyncio
import unittest

from backend.utils.store import InMemoryStore, RedisStore, create_store


class MutableClock:
    def __init__(self, value: float) -> None:
        self.value = value

    def __call__(self) -> float:
        return self.value


class FakeRedis:
    def __init__(self, *, fail_ping: bool = False) -> None:
        self.fail_ping = fail_ping
        self.hashes: dict[str, dict[str, str]] = {}
        self.zsets: dict[str, dict[str, float]] = {}
        self.strings: dict[str, str] = {}
        self.streams: dict[str, list[tuple[str, dict[str, str]]]] = {}
        self.expirations: dict[str, int] = {}
        self.closed = False

    async def ping(self) -> bool:
        if self.fail_ping:
            raise OSError("redis unavailable")
        return True

    async def hset(self, name, key=None, value=None, mapping=None):
        bucket = self.hashes.setdefault(name, {})
        if mapping is not None:
            bucket.update({str(k): str(v) for k, v in mapping.items()})
            return len(mapping)
        bucket[str(key)] = str(value)
        return 1

    async def hgetall(self, name):
        return dict(self.hashes.get(name, {}))

    async def zadd(self, name, mapping):
        bucket = self.zsets.setdefault(name, {})
        bucket.update({str(member): float(score) for member, score in mapping.items()})
        return len(mapping)

    async def zrange(self, name, start, end):
        members = [
            member
            for member, _score in sorted(
                self.zsets.get(name, {}).items(), key=lambda item: item[1]
            )
        ]
        if end == -1:
            return members[start:]
        return members[start : end + 1]

    async def zrem(self, name, *members):
        bucket = self.zsets.get(name, {})
        removed = 0
        for member in members:
            removed += 1 if bucket.pop(str(member), None) is not None else 0
        return removed

    async def delete(self, *names):
        removed = 0
        for name in names:
            removed += 1 if self.hashes.pop(name, None) is not None else 0
            removed += 1 if self.zsets.pop(name, None) is not None else 0
            removed += 1 if self.strings.pop(name, None) is not None else 0
            removed += 1 if self.streams.pop(name, None) is not None else 0
        return removed

    async def expire(self, name, ttl):
        self.expirations[name] = ttl
        return True

    async def set(self, name, value):
        self.strings[name] = str(value)
        return True

    async def get(self, name):
        return self.strings.get(name)

    async def xadd(self, name, fields, id="*"):
        stream = self.streams.setdefault(name, [])
        stream_id = f"{len(stream) + 1}-0" if id == "*" else id
        stream.append((stream_id, {str(k): str(v) for k, v in fields.items()}))
        return stream_id

    async def xrange(self, name, min="-", max="+", count=None):
        rows = list(self.streams.get(name, []))
        if count is not None:
            rows = rows[:count]
        return rows

    async def aclose(self):
        self.closed = True


def run(coro):
    return asyncio.run(coro)


class StoreTests(unittest.TestCase):
    def test_in_memory_store_round_trips_core_records(self):
        async def scenario():
            store = InMemoryStore(now=MutableClock(1000))

            project = await store.create_project("Demo", project_id="p1")
            conversation = await store.create_conversation(
                "p1", title="First build", conversation_id="c1", created_at=1001
            )
            await store.create_message(
                "c1", "user", "Hide Shorts", message_id="m1", created_at=1002
            )
            await store.create_message(
                "c1", "assistant", "Built it", message_id="m2", created_at=1003
            )
            await store.create_rule(
                "p1", "Prefer compact controls.", rule_id="r1", created_at=1004
            )

            self.assertEqual(project["id"], "p1")
            self.assertEqual(conversation["project_id"], "p1")
            self.assertEqual(
                [message["role"] for message in await store.get_history("c1")],
                ["user", "assistant"],
            )
            self.assertEqual(
                [rule["content"] for rule in await store.list_rules("p1")],
                ["Prefer compact controls."],
            )

        run(scenario())

    def test_in_memory_sandbox_cache_honors_ttl(self):
        async def scenario():
            clock = MutableClock(2000)
            store = InMemoryStore(now=clock)

            self.assertIsNone(await store.get_sandbox_result("build-a"))

            await store.set_sandbox_result(
                "build-a",
                {"passed": True, "findings": [], "replay_url": "https://replay.test/a"},
                ttl_seconds=10,
            )
            cached = await store.get_sandbox_result("build-a")
            self.assertEqual(
                cached,
                {
                    "build_hash": "build-a",
                    "passed": True,
                    "findings": [],
                    "replay_url": "https://replay.test/a",
                    "tested_at": 2000,
                },
            )

            clock.value = 2011
            self.assertIsNone(await store.get_sandbox_result("build-a"))

        run(scenario())

    def test_in_memory_job_state_events_and_active_job(self):
        async def scenario():
            store = InMemoryStore(now=MutableClock(3000))

            await store.set_job_state(
                "job-1",
                project_id="p1",
                status="running",
                iteration=2,
                current_step="sandbox",
                build_hash="hash-1",
            )
            event_id = await store.append_job_event(
                "job-1", "sandbox_result", {"passed": False, "findings": ["needs fix"]}
            )

            self.assertEqual(await store.get_active_job("p1"), "job-1")
            self.assertEqual(
                await store.get_job_state("job-1"),
                {
                    "id": "job-1",
                    "project_id": "p1",
                    "status": "running",
                    "iteration": 2,
                    "current_step": "sandbox",
                    "build_hash": "hash-1",
                },
            )
            self.assertEqual(event_id, "1-0")
            self.assertEqual(
                await store.get_job_events("job-1"),
                [
                    {
                        "id": "1-0",
                        "type": "sandbox_result",
                        "payload": {"passed": False, "findings": ["needs fix"]},
                    }
                ],
            )

        run(scenario())

    def test_redis_store_uses_design_doc_keys_and_ttl(self):
        async def scenario():
            redis = FakeRedis()
            store = RedisStore(redis, now=MutableClock(4000))

            await store.create_project("Demo", project_id="p1", created_at=4001)
            await store.create_conversation(
                "p1", title="Conversation", conversation_id="c1", created_at=4002
            )
            await store.create_message(
                "c1", "user", "Make this better", message_id="m1", created_at=4003
            )
            await store.create_rule(
                "p1", "Always keep controls compact.", rule_id="r1", created_at=4004
            )
            await store.set_sandbox_result(
                "hash-1",
                {"passed": False, "findings": ["console error"], "replay_url": "replay"},
                ttl_seconds=55,
            )
            await store.set_job_state(
                "job-1",
                project_id="p1",
                status="running",
                iteration=1,
                current_step="sandbox",
                build_hash="hash-1",
            )
            await store.append_job_event(
                "job-1", "sandbox_start", {"target_url": "https://x"}
            )

            self.assertEqual(redis.hashes["project:p1"]["name"], "Demo")
            self.assertEqual(redis.zsets["projects"]["p1"], 4001)
            self.assertEqual(redis.hashes["conversation:c1"]["project_id"], "p1")
            self.assertEqual(redis.zsets["project:p1:conversations"]["c1"], 4002)
            self.assertEqual(redis.hashes["message:m1"]["content"], "Make this better")
            self.assertEqual(redis.zsets["conversation:c1:messages"]["m1"], 4003)
            self.assertEqual(
                redis.hashes["rule:r1"]["content"], "Always keep controls compact."
            )
            self.assertEqual(redis.zsets["project:p1:rules"]["r1"], 4004)
            self.assertEqual(
                redis.hashes["sandbox:result:hash-1"]["findings_json"],
                '["console error"]',
            )
            self.assertEqual(redis.expirations["sandbox:result:hash-1"], 55)
            self.assertEqual(redis.hashes["job:job-1"]["build_hash"], "hash-1")
            self.assertEqual(redis.strings["project:p1:active_job"], "job-1")
            self.assertEqual(
                redis.streams["job:job-1:events"][0][1]["type"], "sandbox_start"
            )
            self.assertEqual(
                await store.get_history("c1"),
                [
                    {
                        "id": "m1",
                        "conversation_id": "c1",
                        "role": "user",
                        "content": "Make this better",
                        "created_at": 4003,
                    }
                ],
            )

        run(scenario())

    def test_create_store_falls_back_when_redis_is_unavailable(self):
        async def scenario():
            store = await create_store(
                redis_url="redis://unit-test",
                redis_client=FakeRedis(fail_ping=True),
                allow_memory_fallback=True,
            )

            self.assertIsInstance(store, InMemoryStore)

            with self.assertRaises(ConnectionError):
                await create_store(
                    redis_url="redis://unit-test",
                    redis_client=FakeRedis(fail_ping=True),
                    allow_memory_fallback=False,
                )

        run(scenario())
