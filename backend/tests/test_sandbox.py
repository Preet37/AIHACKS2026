import asyncio
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.utils import sandbox


def write_file(root: Path, relative_path: str, content: str = "") -> None:
    path = root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def write_valid_extension(root: Path) -> None:
    write_file(
        root,
        "manifest.json",
        json.dumps(
            {
                "manifest_version": 3,
                "name": "Sandbox Target",
                "version": "1.0.0",
                "background": {"service_worker": "background.js"},
                "content_scripts": [{"matches": ["https://example.com/*"], "js": ["content.js"]}],
            }
        ),
    )
    write_file(root, "background.js", "chrome.runtime.onInstalled.addListener(() => {});")
    write_file(root, "content.js", "document.body.dataset.sandbox = 'ok';")


class MemorySandboxCache:
    def __init__(self) -> None:
        self.values: dict[str, dict] = {}

    async def get(self, build_hash: str) -> dict | None:
        return self.values.get(build_hash)

    async def set(self, build_hash: str, result: dict, ttl_seconds: int) -> None:
        self.values[build_hash] = dict(result)
        self.values[build_hash]["ttl_seconds"] = ttl_seconds


class SandboxTests(unittest.TestCase):
    def test_extension_hash_is_stable_and_content_sensitive(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_valid_extension(root)

            first = sandbox.compute_extension_hash(root)
            second = sandbox.compute_extension_hash(root)
            write_file(root, "content.js", "document.body.dataset.sandbox = 'changed';")
            changed = sandbox.compute_extension_hash(root)

            self.assertEqual(first, second)
            self.assertNotEqual(first, changed)

    def test_local_fallback_passes_valid_extension_when_browserbase_keys_are_absent(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_valid_extension(root)
            clean_env = {
                key: value
                for key, value in os.environ.items()
                if not key.startswith("BROWSERBASE_") and not key.startswith("SIMULAR_")
            }

            with patch.dict(os.environ, clean_env, clear=True):
                result = asyncio.run(sandbox.run_in_sandbox(root, "https://example.com"))

            self.assertTrue(result.passed)
            self.assertEqual("local_fallback", result.source)
            self.assertFalse(result.cache_hit)
            self.assertEqual("https://example.com", result.target_url)
            self.assertEqual(sandbox.compute_extension_hash(root), result.build_hash)
            self.assertIn("BROWSERBASE_API_KEY", result.env_required["browserbase"])
            self.assertIn("SIMULAR_API_KEY", result.env_required["simular"])

    def test_local_fallback_fails_when_static_validation_has_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_file(
                root,
                "manifest.json",
                json.dumps(
                    {
                        "manifest_version": 3,
                        "name": "Broken Sandbox Target",
                        "version": "1.0.0",
                        "background": {"service_worker": "missing.js"},
                    }
                ),
            )
            clean_env = {
                key: value
                for key, value in os.environ.items()
                if not key.startswith("BROWSERBASE_") and not key.startswith("SIMULAR_")
            }

            with patch.dict(os.environ, clean_env, clear=True):
                result = asyncio.run(sandbox.run_in_sandbox(root, "https://example.com"))

            self.assertFalse(result.passed)
            self.assertEqual("local_fallback", result.source)
            self.assertTrue(any("missing.js" in finding for finding in result.findings))

    def test_cached_result_is_returned_by_build_hash_boundary(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_valid_extension(root)
            build_hash = sandbox.compute_extension_hash(root)
            cache = MemorySandboxCache()
            cache.values[build_hash] = {
                "passed": True,
                "source": "cache_seed",
                "build_hash": build_hash,
                "target_url": "https://example.com",
                "findings": ["already tested"],
                "crashes": [],
                "suspicious_behavior": [],
                "logs": [],
                "screenshot": None,
                "replay_url": "https://browserbase.example/replay",
            }

            result = asyncio.run(sandbox.run_in_sandbox(root, "https://example.com", cache=cache))

            self.assertTrue(result.passed)
            self.assertTrue(result.cache_hit)
            self.assertEqual("cache_seed", result.source)
            self.assertEqual(["already tested"], result.findings)
            self.assertEqual("https://browserbase.example/replay", result.replay_url)


if __name__ == "__main__":
    unittest.main()
