import sqlite3
from datetime import datetime, timezone
from pathlib import Path

DB_PATH = Path(__file__).parent / "survey_data.db"

SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS questions (
    id                TEXT PRIMARY KEY,
    gost_code         TEXT,
    title_short       TEXT,
    description       TEXT,
    process_group     TEXT,
    standard_ref      TEXT,
    priority          TEXT,
    weight            TEXT,
    mandatory         TEXT,
    management_area   TEXT,
    process_name      TEXT,
    process_code      TEXT,
    question_number   INTEGER,
    question_text     TEXT,
    answer_hint       TEXT,
    expected_evidence TEXT
);

CREATE INDEX IF NOT EXISTS idx_q_process ON questions(process_code);

CREATE TABLE IF NOT EXISTS sessions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT DEFAULT '',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    status      TEXT DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS answers (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id   INTEGER NOT NULL REFERENCES sessions(id),
    question_id  TEXT    NOT NULL REFERENCES questions(id),
    answer_text  TEXT    DEFAULT '',
    compliance   TEXT    DEFAULT 'not_checked',
    score        INTEGER,
    comment      TEXT    DEFAULT '',
    review_flag  INTEGER DEFAULT 0,
    answered_at  TEXT,
    updated_at   TEXT    NOT NULL,
    UNIQUE(session_id, question_id)
);

CREATE INDEX IF NOT EXISTS idx_a_session   ON answers(session_id);
CREATE INDEX IF NOT EXISTS idx_a_session_q ON answers(session_id, question_id);

CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def init_db() -> None:
    conn = get_db()
    conn.executescript(SCHEMA_SQL)
    conn.commit()
    conn.close()


def utcnow() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def is_imported() -> bool:
    conn = get_db()
    try:
        return conn.execute("SELECT COUNT(*) FROM questions").fetchone()[0] > 0
    except Exception:
        return False
    finally:
        conn.close()
