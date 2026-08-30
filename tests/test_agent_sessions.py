"""Agent thread cockpit — Cursor + Claude scanners (tmpdir fixtures)."""

from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from unittest.mock import patch

from brutus.agent_sessions import (
    active_counts,
    filter_cockpit,
    merge_overlays,
    read_transcript_excerpt,
    scan_agent_sessions,
    summarize_transcript,
)
from brutus.memory import MemoryStore


def _write_cursor_session(root: Path, project: str, sid: str, query: str) -> Path:
    d = root / project / "agent-transcripts" / sid
    d.mkdir(parents=True)
    # Nested subagent folder must be ignored by scanner.
    (d / "subagents" / "deadbeef-0000-0000-0000-000000000001").mkdir(parents=True)
    jl = d / f"{sid}.jsonl"
    row = {
        "role": "user",
        "message": {
            "content": [
                {
                    "type": "text",
                    "text": f"<user_query>\n{query}\n</user_query>",
                }
            ]
        },
    }
    jl.write_text(json.dumps(row) + "\n", encoding="utf-8")
    return jl


def _write_claude_session(projects: Path, sessions: Path, project: str, sid: str, title: str, pid: int) -> Path:
    p = projects / project
    p.mkdir(parents=True, exist_ok=True)
    jl = p / f"{sid}.jsonl"
    lines = [
        {"type": "custom-title", "customTitle": title, "sessionId": sid},
        {
            "type": "user",
            "message": {"role": "user", "content": f"please help with {title}"},
        },
    ]
    jl.write_text("\n".join(json.dumps(x) for x in lines) + "\n", encoding="utf-8")
    sessions.mkdir(parents=True, exist_ok=True)
    (sessions / f"{pid}.json").write_text(
        json.dumps(
            {
                "pid": pid,
                "sessionId": sid,
                "cwd": "/Users/justinfowler/Projects/brutus",
                "startedAt": 1_700_000_000_000,
                "name": "brutus-live",
            }
        ),
        encoding="utf-8",
    )
    return jl


def test_scan_cursor_and_claude(tmp_path: Path):
    cursor = tmp_path / "cursor"
    claude_p = tmp_path / "claude_projects"
    claude_s = tmp_path / "claude_sessions"
    sid_c = "11111111-1111-1111-1111-111111111111"
    sid_a = "22222222-2222-2222-2222-222222222222"
    _write_cursor_session(cursor, "Users-justinfowler-Projects-brutus", sid_c, "build the agents tab")
    _write_claude_session(
        claude_p,
        claude_s,
        "-Users-justinfowler-Projects-brutus",
        sid_a,
        "Debug Brutus chat",
        pid=os.getpid(),  # this process is alive
    )

    rows = scan_agent_sessions(
        cursor_root=cursor,
        claude_projects=claude_p,
        claude_sessions=claude_s,
        force=True,
    )
    by_id = {r["id"]: r for r in rows}
    assert f"cursor:{sid_c}" in by_id
    assert by_id[f"cursor:{sid_c}"]["title"] == "build the agents tab"
    assert by_id[f"cursor:{sid_c}"]["surface"] == "cursor"
    # Nested subagent uuid folder must not appear as its own row.
    assert "cursor:deadbeef-0000-0000-0000-000000000001" not in by_id

    assert f"claude:{sid_a}" in by_id
    assert by_id[f"claude:{sid_a}"]["title"] == "Debug Brutus chat"
    assert by_id[f"claude:{sid_a}"]["live"] is True
    assert by_id[f"claude:{sid_a}"]["cwd"] == "/Users/justinfowler/Projects/brutus"


def test_overlay_filter_and_counts(tmp_path: Path):
    cursor = tmp_path / "cursor"
    sid = "33333333-3333-3333-3333-333333333333"
    _write_cursor_session(cursor, "Users-justinfowler-Projects-brutus", sid, "old work")
    with patch("brutus.agent_sessions.subprocess.run") as run:
        rows = scan_agent_sessions(
            cursor_root=cursor,
            claude_projects=tmp_path / "empty_c",
            claude_sessions=tmp_path / "empty_s",
            force=True,
        )
    run.assert_not_called(), "fixture roots must not merge this laptop's live Claude agents"
    mem = MemoryStore(tmp_path / "m.sqlite")
    mem.upsert_agent_overlay(f"cursor:{sid}", archived=True)
    merged = merge_overlays(rows, mem.list_agent_overlays())
    assert filter_cockpit(merged) == []
    shown = filter_cockpit(merged, include_hidden=True)
    assert len(shown) == 1
    assert shown[0]["hidden"] is True

    mem.upsert_agent_overlay(f"cursor:{sid}", archived=False, pinned=True)
    merged = merge_overlays(rows, mem.list_agent_overlays())
    kept = filter_cockpit(merged)
    assert len(kept) == 1
    assert kept[0]["kept"] is True
    counts = active_counts(merged)
    assert counts["cursor"] == 1
    assert counts["total"] == 1


def test_codex_catalog_is_scanned_with_provider_stable_identity(tmp_path: Path):
    db = tmp_path / "codex.sqlite"
    with sqlite3.connect(db) as conn:
        conn.execute(
            """CREATE TABLE local_thread_catalog (
                host_id TEXT, thread_id TEXT, display_title TEXT,
                source_created_at INTEGER, source_updated_at INTEGER,
                source_recency_at INTEGER, cwd TEXT, source_kind TEXT,
                source_detail TEXT, model_provider TEXT, git_branch TEXT,
                observation_sequence INTEGER, missing_candidate INTEGER,
                thread_source TEXT, project_id TEXT, conversation_origin TEXT
            )"""
        )
        conn.execute(
            "INSERT INTO local_thread_catalog VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (
                "local", "abc-123", "Nucleus audit", 100, 200, 200,
                "/Users/justinfowler/Projects/brutus", "local", "", "openai",
                "codex/nucleus", 1, 0, "desktop", "brutus", "desktop",
            ),
        )

    rows = scan_agent_sessions(
        cursor_root=tmp_path / "cursor",
        claude_projects=tmp_path / "claude",
        claude_sessions=tmp_path / "sessions",
        codex_db=db,
        codex_root=tmp_path / "codex-root",
        force=True,
    )

    row = next(item for item in rows if item["surface"] == "codex")
    assert row["id"] == "codex:local:abc-123"
    assert row["host_id"] == "local"
    assert row["session_id"] == "abc-123"
    assert row["state"] == "unknown"
    assert row["status_source"] == "catalog"


def _write_runtime_status(
    root: Path,
    *,
    surface: str,
    thread_id: str,
    state: str,
    observed_at: float,
    version: int = 1,
) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{surface}--{thread_id}.json").write_text(
        json.dumps(
            {
                "version": version,
                "surface": surface,
                "thread_id": thread_id,
                "state": state,
                "observed_at": observed_at,
                "hook_event_name": "UserPromptSubmit" if state == "active" else "Stop",
                "turn_id": "turn-1",
            }
        ),
        encoding="utf-8",
    )


def test_runtime_status_joins_exact_native_id_and_maps_states(tmp_path: Path):
    db = tmp_path / "codex.sqlite"
    with sqlite3.connect(db) as conn:
        conn.execute(
            """CREATE TABLE local_thread_catalog (
                host_id TEXT, thread_id TEXT, display_title TEXT,
                source_created_at INTEGER, source_updated_at INTEGER,
                source_recency_at INTEGER, cwd TEXT, source_kind TEXT,
                source_detail TEXT, model_provider TEXT, git_branch TEXT,
                observation_sequence INTEGER, missing_candidate INTEGER,
                thread_source TEXT, project_id TEXT, conversation_origin TEXT
            )"""
        )
        for i, sid in enumerate(("active-id", "idle-id", "not-loaded-id", "missing-id")):
            conn.execute(
                "INSERT INTO local_thread_catalog VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("local", sid, sid, 100, 200 + i, 200 + i, "/tmp", "local", "", "openai", "", 1, 0, "desktop", "p", "desktop"),
            )
    runtime = tmp_path / "runtime"
    now = time.time()
    _write_runtime_status(runtime, surface="codex", thread_id="active-id", state="active", observed_at=now)
    _write_runtime_status(runtime, surface="codex", thread_id="idle-id", state="idle", observed_at=now)
    _write_runtime_status(runtime, surface="codex", thread_id="not-loaded-id", state="not_loaded", observed_at=now)
    rows = scan_agent_sessions(
        cursor_root=tmp_path / "cursor",
        claude_projects=tmp_path / "claude",
        claude_sessions=tmp_path / "sessions",
        codex_db=db,
        codex_root=tmp_path / "root",
        runtime_status_dir=runtime,
        force=True,
    )
    by_id = {row["session_id"]: row for row in rows}
    assert (by_id["active-id"]["state"], by_id["active-id"]["live"]) == ("running", True)
    assert (by_id["idle-id"]["state"], by_id["idle-id"]["live"]) == ("idle", False)
    assert (by_id["not-loaded-id"]["state"], by_id["not-loaded-id"]["live"]) == ("not_loaded", False)
    assert by_id["missing-id"]["status_source"] == "catalog"
    assert by_id["active-id"]["status_source"] == "lifecycle_hook"
    assert by_id["active-id"]["status_turn_id"] == "turn-1"


def test_runtime_status_fails_stale_and_malformed_records_safe(tmp_path: Path):
    runtime = tmp_path / "runtime"
    runtime.mkdir()
    _write_runtime_status(
        runtime,
        surface="codex",
        thread_id="stale-id",
        state="active",
        observed_at=time.time() - 46 * 60,
    )
    (runtime / "codex--bad-json.json").write_text("not-json", encoding="utf-8")
    _write_runtime_status(runtime, surface="codex", thread_id="bad-version", state="idle", observed_at=time.time(), version=2)
    db = tmp_path / "codex.sqlite"
    with sqlite3.connect(db) as conn:
        conn.execute(
            """CREATE TABLE local_thread_catalog (
                host_id TEXT, thread_id TEXT, display_title TEXT,
                source_created_at INTEGER, source_updated_at INTEGER,
                source_recency_at INTEGER, cwd TEXT, source_kind TEXT,
                source_detail TEXT, model_provider TEXT, git_branch TEXT,
                observation_sequence INTEGER, missing_candidate INTEGER,
                thread_source TEXT, project_id TEXT, conversation_origin TEXT
            )"""
        )
        for sid in ("stale-id", "bad-json", "bad-version"):
            conn.execute(
                "INSERT INTO local_thread_catalog VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("local", sid, sid, 100, 200, 200, "/tmp", "local", "", "openai", "", 1, 0, "desktop", "p", "desktop"),
            )
    rows = scan_agent_sessions(
        cursor_root=tmp_path / "cursor",
        claude_projects=tmp_path / "claude",
        claude_sessions=tmp_path / "sessions",
        codex_db=db,
        codex_root=tmp_path / "root",
        runtime_status_dir=runtime,
        force=True,
    )
    by_id = {row["session_id"]: row for row in rows}
    assert by_id["stale-id"]["state"] == "unknown"
    assert by_id["stale-id"]["live"] is False
    assert by_id["stale-id"]["status_source"] == "lifecycle_hook_stale"
    assert by_id["bad-json"]["status_source"] == "catalog"
    assert by_id["bad-version"]["status_source"] == "catalog"


def test_runtime_directory_change_invalidates_agent_cache(tmp_path: Path):
    cursor = tmp_path / "cursor"
    sid = "55555555-5555-5555-5555-555555555555"
    _write_cursor_session(cursor, "Users-justinfowler-Projects-brutus", sid, "cache status")
    runtime = tmp_path / "runtime"
    rows = scan_agent_sessions(
        cursor_root=cursor,
        claude_projects=tmp_path / "claude",
        claude_sessions=tmp_path / "sessions",
        runtime_status_dir=runtime,
        force=True,
    )
    assert rows[0]["live"] is False
    _write_runtime_status(runtime, surface="cursor", thread_id=sid, state="active", observed_at=time.time())
    rows = scan_agent_sessions(
        cursor_root=cursor,
        claude_projects=tmp_path / "claude",
        claude_sessions=tmp_path / "sessions",
        runtime_status_dir=runtime,
    )
    assert rows[0]["state"] == "running"
    assert rows[0]["live"] is True


def test_transcript_excerpt_and_summarize(tmp_path: Path):
    jl = tmp_path / "t.jsonl"
    rows = [
        {
            "role": "user",
            "message": {"content": [{"type": "text", "text": "<user_query>fix renewals</user_query>"}]},
        },
        {
            "role": "assistant",
            "message": {"content": [{"type": "text", "text": "Looking at Total_of_Cases__c next."}]},
        },
    ]
    jl.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    excerpt = read_transcript_excerpt(jl)
    assert "fix renewals" in excerpt
    assert "Total_of_Cases__c" in excerpt
    out = summarize_transcript(jl, cfg=None)
    assert out["ok"] is True
    assert out["source"] == "excerpt"
    assert "fix renewals" in out["summary"]
