"""SQLite storage. One file, no setup. Events are append-only so phones can sync safely."""
from __future__ import annotations

import json
import os
import secrets
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

# No 0/O/1/I/L so codes are easy to read out over the phone.
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8

SCHEMA = """
CREATE TABLE IF NOT EXISTS families (
    code TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    plan_json TEXT,
    plan_updated TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    family_code TEXT NOT NULL REFERENCES families(code),
    kind TEXT NOT NULL,
    data_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (family_code, id)
);
CREATE INDEX IF NOT EXISTS idx_events_family ON events (family_code, seq);
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def db_path() -> str:
    return os.environ.get("HOMERECOVER_DB", os.path.join(os.path.dirname(__file__), "..", "homerecover.db"))


def connect() -> sqlite3.Connection:
    conn = sqlite3.connect(db_path(), timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def create_family(name: str) -> str:
    with connect() as conn:
        for _ in range(10):
            code = new_code()
            try:
                conn.execute(
                    "INSERT INTO families (code, name, created_at) VALUES (?, ?, ?)",
                    (code, name, now_iso()),
                )
                return code
            except sqlite3.IntegrityError:
                continue
    raise RuntimeError("could not allocate a family code")


def get_family(code: str) -> Optional[Dict[str, Any]]:
    with connect() as conn:
        row = conn.execute("SELECT * FROM families WHERE code = ?", (code,)).fetchone()
    if row is None:
        return None
    return {
        "code": row["code"],
        "name": row["name"],
        "plan": json.loads(row["plan_json"]) if row["plan_json"] else None,
        "plan_updated": row["plan_updated"],
    }


def save_plan(code: str, plan: Dict[str, Any], updated_at: str) -> bool:
    """Last write wins. Returns True if the stored plan was replaced."""
    with connect() as conn:
        row = conn.execute("SELECT plan_updated FROM families WHERE code = ?", (code,)).fetchone()
        if row is None:
            return False
        if row["plan_updated"] and row["plan_updated"] > updated_at:
            return False
        conn.execute(
            "UPDATE families SET plan_json = ?, plan_updated = ? WHERE code = ?",
            (json.dumps(plan, ensure_ascii=False), updated_at, code),
        )
        return True


def add_events(code: str, events: List[Dict[str, Any]]) -> int:
    """Insert events, ignoring ones already stored (same id). Returns how many were new."""
    added = 0
    with connect() as conn:
        for ev in events:
            cur = conn.execute(
                "INSERT OR IGNORE INTO events (id, family_code, kind, data_json, created_at) VALUES (?, ?, ?, ?, ?)",
                (ev["id"], code, ev["kind"], json.dumps(ev["data"], ensure_ascii=False), ev["created_at"]),
            )
            added += cur.rowcount
    return added


def list_events(code: str, since: int = 0) -> Tuple[List[Dict[str, Any]], int]:
    with connect() as conn:
        rows = conn.execute(
            "SELECT seq, id, kind, data_json, created_at FROM events WHERE family_code = ? AND seq > ? ORDER BY seq",
            (code, since),
        ).fetchall()
    events = [
        {"id": r["id"], "kind": r["kind"], "data": json.loads(r["data_json"]), "created_at": r["created_at"], "seq": r["seq"]}
        for r in rows
    ]
    latest = events[-1]["seq"] if events else since
    return events, latest
