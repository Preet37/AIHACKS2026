import asyncio
import json
from pathlib import Path
from unittest.mock import patch

from backend.main import _finish_provisional_mod, _query_explicitly_targets_websites
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


def test_visible_button_preflight_rejects_popup_only_bundle() -> None:
    findings = tools._visible_ui_findings(
        {"js": "console.log('popup handles the button')", "css": ""},
        "Build an agent explainer button",
    )

    assert any("No real button" in finding for finding in findings)
    assert any("webpage DOM" in finding for finding in findings)


def test_visible_button_preflight_accepts_mounted_fixed_content_script_button() -> None:
    findings = tools._visible_ui_findings(
        {
            "js": """
                const button = document.createElement('button');
                button.dataset.conjureMod = 'agent-explainer';
                button.dataset.conjureAgentAction = 'explain-page';
                button.style.position = 'fixed';
                button.style.zIndex = '2147483647';
                document.documentElement.append(button);
            """,
            "css": "",
        },
        "Build an agent explainer button",
    )

    assert findings == []


def test_visible_button_preflight_rejects_mod_owned_agent_output() -> None:
    findings = tools._visible_ui_findings(
        {
            "js": """
                const button = document.createElement('button');
                button.dataset.conjureMod = 'agent-explainer';
                button.dataset.conjureAgentAction = 'explain-page';
                button.style.position = 'fixed';
                button.style.zIndex = '2147483647';
                const output = document.createElement('div');
                output.dataset.conjureAgentOutput = 'true';
                document.documentElement.append(button, output);
            """,
            "css": "",
        },
        "Build an agent explainer button",
    )

    assert any("Do not create an agent output panel" in finding for finding in findings)


def test_visible_button_preflight_rejects_fake_agent_completion_handler() -> None:
    findings = tools._visible_ui_findings(
        {
            "js": """
                const button = document.createElement('button');
                button.dataset.conjureMod = 'fake-agent';
                button.dataset.conjureAgentAction = 'explain-page';
                button.style.position = 'fixed';
                button.style.zIndex = '2147483647';
                button.addEventListener('click', () => alert('Done'));
                document.documentElement.append(button);
            """,
            "css": "",
        },
        "Build an agent button",
    )

    assert any("must not install their own click handler" in finding for finding in findings)


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


def test_two_different_mods_on_the_same_page_are_both_saved_and_bundled(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    for mod_id, name, script in (
        ("price-highlighter", "Highlight prices", "document.body.dataset.prices = 'on';"),
        ("summary-button", "Summary button", "document.body.dataset.summary = 'on';"),
    ):
        mods.create_mod(project_dir, prompt=name, name=name, mod_id=mod_id)
        directory = mods.mod_dir(project_dir, mod_id)
        (directory / "manifest.json").write_text(
            json.dumps(
                {
                    "manifest_version": 3,
                    "name": name,
                    "version": "1.0.0",
                    "content_scripts": [
                        {
                            "matches": ["https://shop.example.com/*"],
                            "js": ["content.js"],
                        }
                    ],
                }
            ),
            encoding="utf-8",
        )
        (directory / "content.js").write_text(script, encoding="utf-8")

    assert [record["id"] for record in mods.list_mods(project_dir)] == [
        "price-highlighter",
        "summary-button",
    ]
    assert [bundle["mod_id"] for bundle in mods.active_bundles(project_dir)] == [
        "price-highlighter",
        "summary-button",
    ]


def test_start_mod_reuses_the_preassigned_turn_workspace(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    record = mods.create_mod(
        project_dir,
        prompt="Add a second customization",
        name="Provisional",
    )
    directory = mods.mod_dir(project_dir, record["id"])
    tokens = tools.set_tool_context(
        outbound_queue=None,
        pending_tab_requests=None,
        project_dir=project_dir,
        settings=Settings(project_root=tmp_path),
        active_mod_dir=directory,
    )
    try:
        result = json.loads(
            asyncio.run(tools.start_mod("Add a second customization", name="Second mod"))
        )
    finally:
        tools.reset_tool_context(tokens)

    assert result["mod_id"] == record["id"]
    assert len(mods.list_mods(project_dir)) == 1
    assert mods.get_mod(project_dir, record["id"])["name"] == "Second mod"


def test_provisional_mod_is_promoted_only_when_it_has_a_bundle(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    empty = mods.create_mod(project_dir, prompt="Empty", name="Empty")
    _finish_provisional_mod(project_dir, empty["id"], keep=True)
    assert mods.get_mod(project_dir, empty["id"]) is None

    _write_multi_site_mod(project_dir, "complete")
    mods.upsert_mod(project_dir, {"id": "complete", "status": "building"})
    _finish_provisional_mod(project_dir, "complete", keep=True)
    assert mods.get_mod(project_dir, "complete")["status"] == "active"


def test_new_mod_defaults_to_current_tab_website(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    _write_multi_site_mod(project_dir, "current-page")
    mods.upsert_mod(project_dir, {"id": "current-page", "status": "building"})

    _finish_provisional_mod(
        project_dir,
        "current-page",
        keep=True,
        current_tab_url="https://shop.example.com/products/1",
    )

    assert mods.mod_bundle(project_dir, "current-page")["matches"] == [
        "https://shop.example.com/*"
    ]
    assert mods.get_mod(project_dir, "current-page")["last_verified"] is None


def test_explicit_multi_site_request_preserves_generated_scope(tmp_path: Path) -> None:
    project_dir = tmp_path / "project"
    _write_multi_site_mod(project_dir, "shared")

    _finish_provisional_mod(
        project_dir,
        "shared",
        keep=True,
        current_tab_url="https://shop.example.com/",
        preserve_generated_scope=True,
    )

    assert mods.mod_bundle(project_dir, "shared")["matches"] == [
        "*://www.youtube.com/*",
        "https://www.reddit.com/*",
    ]


def test_email_recipient_does_not_count_as_explicit_website_scope() -> None:
    assert not _query_explicitly_targets_websites(
        "Add a button that emails hello to tkennedy4432@gmail.com"
    )
    assert _query_explicitly_targets_websites("Add it across both websites")
    assert _query_explicitly_targets_websites("Add it on reddit")


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
