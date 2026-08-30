"""Mobile surface — FNOL widget fork served from Brutus, never from demos/fnol."""

from pathlib import Path
from unittest.mock import MagicMock, patch

from fastapi.testclient import TestClient

from brutus.config import BrutusCfg
from brutus.server import create_app

_STATIC = Path(__file__).resolve().parents[1] / "brutus" / "static"
_FNOL = Path.home() / "Projects" / "clearspeed-demos" / "public" / "demos" / "fnol"


def _client() -> TestClient:
    cfg = BrutusCfg(watchdog_enabled=False)
    with patch("brutus.server.AtlasClient") as cls:
        cls.return_value = MagicMock()
        app = create_app(cfg, start_watchdog=False)
        return TestClient(app)


def test_mobile_page_serves_and_wires_session_apis():
    c = _client()
    r = c.get("/mobile")
    assert r.status_code == 200
    assert "Cache-Control" in r.headers
    assert "no-store" in r.headers["Cache-Control"]
    html = r.text
    assert "Brutus" in html
    assert "<main" in html
    assert 'id="reconnect"' in html
    assert 'id="reconnect-btn"' in html
    assert 'id="startover-btn"' in html
    assert 'id="fields"' in html
    assert "Connecting…" in html
    assert 'aria-live="polite"' in html
    assert "/static/mobile.js" in html
    assert "/static/shine-tokens.css" in html
    # Never the Clearspeed FNOL brand surface.
    assert "clearspeeddemos.com" not in html
    assert "Report your claim" not in html
    assert "/api/anam" not in html


def test_mobile_shine_audit_markers():
    """DoD markers from docs/SESSION_UI_SHINE_BUILD_PLAN.md Wave B."""
    js = (_STATIC / "mobile.js").read_text()
    assert "isOurOwnVoice" in js
    assert "rememberSpoken" in js
    assert 'case "answer"' in js
    assert 'case "thinking"' in js
    assert "End this session?" in js
    assert "Start over?" in js
    assert "showConnecting" in js
    assert "aria-busy" in js


def test_mobile_oos5_ideas_ledger_thinking_parity():
    """OOS5 — Ideas / Ledger / Thinking are real sheets, not stubs."""
    html = (_STATIC / "mobile.html").read_text()
    js = (_STATIC / "mobile.js").read_text()
    css = (_STATIC / "mobile.css").read_text()

    assert 'id="ideas-sheet"' in html
    assert 'id="board-sheet"' in html
    assert 'id="thinking-sheet"' in html
    assert 'id="thinking"' in html
    assert 'id="ideas-list"' in html
    assert 'id="board-list"' in html
    assert 'id="ideas-add"' in html

    assert "renderThinking" in js
    assert "resolveThinking" in js
    assert "/api/todos" in js
    assert "/api/session/ideas/events" in js
    assert "/api/board" in js
    assert "/api/session/board/events" in js
    assert "method: \"DELETE\"" in js or "method: 'DELETE'" in js
    assert "needs_you" in js
    assert "with bots" in js

    assert ".pad-sheet" in css
    assert ".thinking" in css
    assert ".board-row" in css


def test_mobile_static_assets_allowed():
    c = _client()
    css = c.get("/static/mobile.css")
    js = c.get("/static/mobile.js")
    assert css.status_code == 200
    assert js.status_code == 200
    assert "text/css" in css.headers["content-type"]
    assert "javascript" in js.headers["content-type"]


def test_mobile_js_keeps_fnol_reconnect_contract_and_own_snap_key():
    js = (_STATIC / "mobile.js").read_text()
    # The hard-won bits, under a Brutus-owned key so the two surfaces cannot collide.
    assert 'SNAP_KEY = "brutusMobileResumeSnapshot"' in js
    assert 'SNAP_KEY = "fnolResumeSnapshot"' not in js
    assert "15 * 60 * 1000" in js
    assert "scrapeResume" in js
    assert "showReconnect" in js
    assert "/api/session/" in js
    assert "/api/anam" not in js
    # Provenance comment must name the source and the never-write-back rule.
    assert "demos/fnol" in js
    assert "writes back" in js


def test_mobile_fork_did_not_modify_fnol_demo():
    """The sales demo is source-only. If it is present locally, its reconnect
    key must still be the FNOL one — proof we did not write back."""
    widget = _FNOL / "fnol-widget.js"
    if not widget.is_file():
        return
    text = widget.read_text()
    assert 'SNAP_KEY = "fnolResumeSnapshot"' in text
    assert "brutusMobileResumeSnapshot" not in text
