from __future__ import annotations

import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.main import app
from backend.utils import mods
from backend.utils.config import load_settings
from backend.utils.tools import project_dir_for


def write_mod_bundle(project_dir: Path, mod_id: str = "demo") -> None:
    directory = mods.mod_dir(project_dir, mod_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "manifest.json").write_text(
        json.dumps(
            {
                "name": "Demo mod",
                "manifest_version": 3,
                "content_scripts": [
                    {
                        "matches": ["https://example.com/*"],
                        "js": ["content.js"],
                        "css": ["content.css"],
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    (directory / "content.js").write_text(
        "document.body.dataset.original = 'true';",
        encoding="utf-8",
    )
    (directory / "content.css").write_text(
        "body { color: rgb(1, 2, 3); }",
        encoding="utf-8",
    )


def test_mod_record_stores_normalized_visual_edits(tmp_path: Path) -> None:
    mods.create_mod(tmp_path, prompt="Build a button", name="Button", mod_id="demo")

    record = mods.upsert_mod(
        tmp_path,
        {
            "id": "demo",
            "visual_edits": [
                {
                    "id": "text:button",
                    "type": "setText",
                    "selector": '[data-testid="cta"]',
                    "value": "Start",
                    "stale": True,
                },
                {
                    "id": "style:button",
                    "type": "setStyle",
                    "selector": '[data-testid="cta"]',
                    "styles": {"color": "#ffffff", "position": "fixed"},
                },
                {
                    "id": "box:button",
                    "type": "setBox",
                    "selector": '[data-testid="cta"]',
                    "box": {
                        "width": 180,
                        "sizing": {"width": "hug", "height": "fixed", "depth": "hug"},
                        "hug": {"left": 8, "right": 12, "bottom": False, "extra": 4},
                    },
                },
                {"type": "unknown", "selector": "body"},
            ],
        },
    )

    assert record["visual_edits"] == [
        {
            "id": "text:button",
            "type": "setText",
            "selector": '[data-testid="cta"]',
            "value": "Start",
        },
        {
            "id": "style:button",
            "type": "setStyle",
            "selector": '[data-testid="cta"]',
            "styles": {"color": "#ffffff"},
        },
        {
            "id": "box:button",
            "type": "setBox",
            "selector": '[data-testid="cta"]',
            "box": {
                "width": 180,
                "sizing": {"width": "hug", "height": "fixed"},
                "hug": {"left": 8, "right": 12},
            },
        },
    ]
    assert mods.list_mods(tmp_path)[0]["visual_edits"] == record["visual_edits"]


def test_active_bundle_appends_compiled_visual_edits(tmp_path: Path) -> None:
    mods.create_mod(tmp_path, prompt="Build a button", name="Button", mod_id="demo")
    write_mod_bundle(tmp_path, "demo")
    mods.upsert_mod(
        tmp_path,
        {
            "id": "demo",
            "visual_edits": [
                {
                    "id": "box:button",
                    "type": "setBox",
                    "selector": '[data-testid="cta"]',
                    "box": {
                        "x": 12,
                        "y": -4,
                        "width": 180,
                        "height": 44,
                        "fontScale": 1.25,
                        "sizing": {"width": "hug"},
                        "hug": {"left": 8, "right": 12},
                    },
                },
                {
                    "id": "hide:note",
                    "type": "hide",
                    "selector": ".note",
                    "hidden": True,
                },
            ],
        },
    )

    bundle = mods.active_bundles(tmp_path)[0]

    assert "document.body.dataset.original" in bundle["js"]
    assert "MutationObserver" in bundle["js"]
    assert '"type":"setBox"' in bundle["js"]
    assert '"fontScale":1.25' in bundle["js"]
    assert '"sizing":{"width":"hug"}' in bundle["js"]
    assert '"hug":{"left":8,"right":12}' in bundle["js"]
    assert "scaleTextForBox" in bundle["js"]
    assert "applyHugSizing" in bundle["js"]
    assert "translate(" in bundle["js"]
    assert bundle["css"] == "body { color: rgb(1, 2, 3); }"


def test_patch_mod_endpoint_persists_visual_edits_and_returns_bundles(
    tmp_path: Path, monkeypatch
) -> None:
    monkeypatch.setenv("CONJURE_PROJECT_ROOT", str(tmp_path))
    project_dir = project_dir_for(load_settings(), "project-api")
    mods.create_mod(project_dir, prompt="Build a button", name="Button", mod_id="demo")
    write_mod_bundle(project_dir, "demo")

    response = TestClient(app).patch(
        "/projects/project-api/mods/demo",
        json={
            "visual_edits": [
                {
                    "id": "text:button",
                    "type": "setText",
                    "selector": '[data-testid="cta"]',
                    "value": "Saved text",
                }
            ]
        },
    )

    assert response.status_code == 200
    data = response.json()
    assert data["mod"]["visual_edits"][0]["value"] == "Saved text"
    assert data["mods"][0]["visual_edits"][0]["selector"] == '[data-testid="cta"]'
    assert "Saved text" in data["bundles"][0]["js"]
