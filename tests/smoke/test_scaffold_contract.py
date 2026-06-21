from __future__ import annotations

import json
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]


class ScaffoldContractTests(unittest.TestCase):
    def read_root_file(self, relative_path: str) -> str:
        path = ROOT / relative_path
        self.assertTrue(path.exists(), f"{relative_path} should exist")
        return path.read_text(encoding="utf-8")

    def test_env_example_lists_required_runtime_configuration(self) -> None:
        env_example = self.read_root_file(".env.example")
        required_names = [
            "CONJURE_AGENT_PROVIDER",
            "DEVIN_API_KEY",
            "DEVIN_ORG_ID",
            "DEVIN_API_BASE_URL",
            "DEVIN_MODE",
            "DEVIN_REPOS",
            "ANTHROPIC_API_KEY",
            "CONJURE_ANTHROPIC_MODEL",
            "NVIDIA_API_KEY",
            "NVIDIA_MODEL",
            "NVIDIA_API_BASE_URL",
            "REDIS_URL",
            "BROWSERBASE_API_KEY",
            "BROWSERBASE_PROJECT_ID",
            "SIMULAR_API_KEY",
            "SENTRY_DSN",
            "SENTRY_SANDBOX_DSN",
            "BACKEND_URL",
            "BACKEND_WS_URL",
            "VITE_BACKEND_URL",
            "VITE_BACKEND_WS_URL",
            "VITE_SENTRY_DSN",
        ]

        missing = [name for name in required_names if f"{name}=" not in env_example]
        self.assertEqual([], missing)

    def test_env_example_does_not_contain_obvious_committed_secrets(self) -> None:
        env_example = self.read_root_file(".env.example")
        uncommented_values = [
            line.split("=", 1)[1].strip()
            for line in env_example.splitlines()
            if line and not line.startswith("#") and "=" in line
        ]
        suspicious_value = re.compile(
            r"(sk-ant-|sk_live_|cog_[A-Za-z0-9_-]{16,}|browserbase_[A-Za-z0-9]{16,}|[A-Za-z0-9_-]{32,})"
        )

        leaked = [value for value in uncommented_values if suspicious_value.search(value)]
        self.assertEqual([], leaked)

    def test_gitignore_keeps_local_secrets_and_generated_artifacts_out(self) -> None:
        gitignore = self.read_root_file(".gitignore")
        required_patterns = [
            ".env",
            ".env.*",
            "!.env.example",
            "node_modules/",
            ".venv/",
            "demo_code/",
            "dist/",
            "coverage/",
            "playwright-report/",
            "test-results/",
        ]

        missing = [pattern for pattern in required_patterns if pattern not in gitignore]
        self.assertEqual([], missing)

    def test_readme_documents_backend_extension_and_test_workflows(self) -> None:
        readme = self.read_root_file("README.md").lower()
        required_phrases = [
            "backend setup",
            "extension setup",
            "dev commands",
            "test commands",
            "devin",
            "nemotron",
            "browserbase",
            "simular",
            "sentry",
            "redis",
            "do not commit secrets",
        ]

        missing = [phrase for phrase in required_phrases if phrase not in readme]
        self.assertEqual([], missing)

    def test_package_json_exposes_workspace_commands(self) -> None:
        package_json = json.loads(self.read_root_file("package.json"))
        scripts = package_json.get("scripts", {})
        required_scripts = [
            "dev:backend",
            "dev:extension",
            "test",
            "test:smoke",
            "test:backend-smoke",
        ]

        missing = [script for script in required_scripts if script not in scripts]
        self.assertEqual([], missing)


if __name__ == "__main__":
    unittest.main()
