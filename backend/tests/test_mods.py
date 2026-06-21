import asyncio
import json
from pathlib import Path
from unittest.mock import patch

from backend.utils import mods, tools
from backend.utils.config import Settings
from backend.utils.sandbox import SandboxResult


def _write_multi_site_mod(project_dir: Path, mod_id: str = "shared-mod") -> Path:
    mods.create_mod(
        project_dir,
        prompt="Hide distracting feeds on both sites",
        name="Quiet feeds",
        mod_id=mod_id,
    )
    directory = mods.mod_dir(project_dir, mod_id)
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "manifest_version": 3,
                "name": "Quiet feeds",
                "version": "1.0.0",
                "content_scripts": [
                    {
                        "matches": [
                            "*://www.youtube.com/*",
                            "https://www.reddit.com/*",
                        ],
                        "js": ["content.js"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (directory / "content.js").write_text(
        "document.documentElement.dataset.quietFeeds = 'true';",
        encoding="utf-8",
    )
    return directory


def test_target_urls_include_each_distinct_website() -> None:
    assert mods.target_urls_for_matches(
        [
            "*://*.example.com/*",
            "https://example.com/articles/*",
            "http://news.example.net/*",
            "<all_urls>",
        ]
    ) == ["https://example.com", "http://news.example.net"]


def test_mod_listing_exposes_all_supported_websites(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    _write_multi_site_mod(project_dir)

    records = mods.list_mods(project_dir)
    bundles = mods.active_bundles(project_dir)

    assert records[0]["websites"] == ["www.youtube.com", "www.reddit.com"]
    assert records[0]["matches"] == [
        "*://www.youtube.com/*",
        "https://www.reddit.com/*",
    ]
    assert bundles[0]["matches"] == records[0]["matches"]


def test_verify_mod_checks_every_matched_website(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    directory = _write_multi_site_mod(project_dir)
    calls: list[str] = []

    async def fake_sandbox_run(
        sandbox_dir: Path,
        target_url: str,
        feature_description: str | None = None,
    ) -> SandboxResult:
        assert sandbox_dir == directory
        assert feature_description == "Hide distracting feeds on both sites"
        calls.append(target_url)
        return SandboxResult(
            passed=target_url != "https://www.reddit.com",
            source="test",
            build_hash="hash",
            target_url=target_url,
            findings=[] if "youtube" in target_url else ["selector missing"],
        )

    tokens = tools.set_tool_context(
        outbound_queue=None,
        pending_tab_requests=None,
        project_dir=project_dir,
        settings=Settings(project_root=tmp_path),
    )
    try:
        with patch("backend.utils.sandbox.run_in_sandbox", side_effect=fake_sandbox_run):
            result = json.loads(asyncio.run(tools.verify_mod("shared-mod")))
    finally:
        tools.reset_tool_context(tokens)

    assert calls == ["https://www.youtube.com", "https://www.reddit.com"]
    assert result["passed"] is False
    assert result["target_urls"] == calls
    assert result["findings"] == ["https://www.reddit.com: selector missing"]
    verification = mods.get_mod(project_dir, "shared-mod")["last_verified"]
    assert verification["passed"] is False
    assert [item["target_url"] for item in verification["results"]] == calls
