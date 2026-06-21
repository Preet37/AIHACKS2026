import asyncio
import os
import unittest

from backend.utils.memory import extract_and_save_rules, extract_rules
from backend.utils.store import InMemoryStore


def run(coro):
    return asyncio.run(coro)


class MemoryTests(unittest.TestCase):
    def test_extract_rules_default_is_safe(self):
        async def scenario():
            old_demo = os.environ.pop("CONJURE_MEMORY_DEMO", None)
            try:
                history = [
                    {
                        "role": "user",
                        "content": (
                            "Remember that I prefer compact UI for generated tools."
                        ),
                    }
                ]

                self.assertEqual(await extract_rules(history, existing_rules=[]), [])
            finally:
                if old_demo is not None:
                    os.environ["CONJURE_MEMORY_DEMO"] = old_demo

        run(scenario())

    def test_extract_rules_demo_mode_returns_rule_candidates(self):
        async def scenario():
            history = [
                {
                    "role": "user",
                    "content": (
                        "Remember that I prefer compact UI. "
                        "Always avoid oversized hero sections in tools. "
                        "Never use autoplaying media."
                    ),
                }
            ]

            rules = await extract_rules(history, existing_rules=[], demo_mode=True)

            self.assertIn("Prefer compact UI.", rules)
            self.assertIn("Always avoid oversized hero sections in tools.", rules)
            self.assertIn("Never use autoplaying media.", rules)

        run(scenario())

    def test_extract_rules_deduplicates_existing_rules(self):
        async def scenario():
            history = [
                {
                    "role": "user",
                    "content": (
                        "Remember that I prefer compact UI. "
                        "Never use autoplaying media."
                    ),
                }
            ]

            rules = await extract_rules(
                history,
                existing_rules=["Prefer compact UI."],
                demo_mode=True,
            )

            self.assertEqual(rules, ["Never use autoplaying media."])

        run(scenario())

    def test_extract_and_save_rules_persists_candidates(self):
        async def scenario():
            store = InMemoryStore()
            history = [
                {
                    "role": "user",
                    "content": "Remember that I prefer dense dashboards.",
                }
            ]

            saved = await extract_and_save_rules(
                store, "p1", history, existing_rules=[], demo_mode=True
            )
            rules = await store.list_rules("p1")

            self.assertEqual(saved, ["Prefer dense dashboards."])
            self.assertEqual(
                [rule["content"] for rule in rules], ["Prefer dense dashboards."]
            )

        run(scenario())
