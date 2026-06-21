import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.utils import extension_validator


def write_file(root: Path, relative_path: str, content: str = "") -> None:
    path = root / relative_path
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def write_manifest(root: Path, manifest: dict) -> None:
    write_file(root, "manifest.json", json.dumps(manifest))


class ExtensionValidatorTests(unittest.TestCase):
    def test_valid_mv3_extension_has_no_errors(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_manifest(
                root,
                {
                    "manifest_version": 3,
                    "name": "Valid Extension",
                    "version": "1.0.0",
                    "background": {"service_worker": "background.js"},
                    "action": {"default_popup": "popup.html"},
                    "content_scripts": [
                        {
                            "matches": ["https://example.com/*"],
                            "js": ["content.js"],
                            "css": ["content.css"],
                        }
                    ],
                    "icons": {"16": "icons/icon16.png"},
                    "permissions": ["storage", "scripting"],
                    "host_permissions": ["https://example.com/*"],
                },
            )
            write_file(root, "background.js", "chrome.runtime.onInstalled.addListener(() => {});")
            write_file(root, "content.js", "document.documentElement.dataset.valid = 'true';")
            write_file(root, "content.css", "html { color-scheme: light dark; }")
            write_file(root, "popup.html", "<!doctype html><title>Popup</title>")
            write_file(root, "icons/icon16.png", "fake")

            issues = extension_validator.validate_extension(root)

            self.assertEqual([], [issue for issue in issues if issue["level"] == "error"])

    def test_manifest_file_references_and_mv3_compatibility_are_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_manifest(
                root,
                {
                    "manifest_version": 2,
                    "name": "Broken Extension",
                    "version": "1.0.0",
                    "background": {"service_worker": "background.js", "scripts": ["background.js"], "persistent": True},
                    "action": {"default_popup": "missing-popup.html"},
                    "content_scripts": [{"matches": ["<all_urls>"], "js": ["missing-content.js"]}],
                    "permissions": ["storage", "madeUpPermission"],
                },
            )
            write_file(
                root,
                "background.js",
                "chrome.browserAction.setBadgeText({text: 'x'}); chrome.tabs.executeScript({code: '1'}); localStorage.setItem('x', 'y');",
            )

            issues = extension_validator.validate_extension(root)
            messages = "\n".join(issue["message"] for issue in issues)
            categories = {issue["category"] for issue in issues}

            self.assertIn("manifest", categories)
            self.assertIn("file_reference", categories)
            self.assertIn("mv3_compatibility", categories)
            self.assertIn("manifest_version must be 3", messages)
            self.assertIn("missing-popup.html", messages)
            self.assertIn("missing-content.js", messages)
            self.assertIn("chrome.browserAction", messages)
            self.assertIn("chrome.tabs.executeScript", messages)
            self.assertIn("localStorage", messages)

    def test_node_absence_is_a_warning_not_an_error(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_manifest(
                root,
                {
                    "manifest_version": 3,
                    "name": "No Node",
                    "version": "1.0.0",
                    "background": {"service_worker": "background.js"},
                },
            )
            write_file(root, "background.js", "const ok = true;")

            with patch.object(extension_validator.shutil, "which", return_value=None):
                issues = extension_validator.validate_extension(root)

            self.assertIn(
                {
                    "level": "warning",
                    "category": "js_syntax",
                    "message": "node is not available; skipped JavaScript syntax checks",
                },
                issues,
            )
            self.assertEqual([], [issue for issue in issues if issue["level"] == "error"])

    def test_manifest_paths_cannot_escape_extension_root(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_manifest(
                root,
                {
                    "manifest_version": 3,
                    "name": "Traversal",
                    "version": "1.0.0",
                    "background": {"service_worker": "../outside.js"},
                },
            )

            issues = extension_validator.validate_extension(root)

            self.assertTrue(
                any(
                    issue["level"] == "error"
                    and issue["category"] == "file_reference"
                    and "../outside.js" in issue["message"]
                    for issue in issues
                )
            )


if __name__ == "__main__":
    unittest.main()
