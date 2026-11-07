"""Where OAuth tokens (WHOOP, Spotify) are kept.

- DATABASE_URL set (the cloud deploy, e.g. a free Neon Postgres): one row per login in the
  `oauth_tokens` table, so logins survive restarts and redeploys (Render's disk is wiped on both).
- Otherwise (the laptop): a JSON file per login, as before. Gitignored.

Keys look like "whoop:<user id>" and "spotify:<user id>"; `file` is where that login lives on disk.
"""

from __future__ import annotations

import json
from pathlib import Path

from app.config import get_settings

_SCHEMA = """
CREATE TABLE IF NOT EXISTS oauth_tokens (
    key TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
"""
_schema_ready_for: str | None = None


def _db_url() -> str:
    return get_settings().database_url.strip()


def _connect():
    import psycopg  # only needed in the cloud; keeps laptop setups free of the driver

    global _schema_ready_for
    url = _db_url()
    conn = psycopg.connect(url, autocommit=True, connect_timeout=10)
    if _schema_ready_for != url:
        conn.execute(_SCHEMA)
        _schema_ready_for = url
    return conn


def load(key: str, file: Path) -> dict | None:
    if _db_url():
        with _connect() as conn:
            row = conn.execute("SELECT data FROM oauth_tokens WHERE key = %s", (key,)).fetchone()
        return row[0] if row else None
    if not file.exists():
        return None
    try:
        return json.loads(file.read_text())
    except json.JSONDecodeError:
        return None


def save(key: str, file: Path, data: dict) -> None:
    if _db_url():
        from psycopg.types.json import Jsonb

        with _connect() as conn:
            conn.execute(
                "INSERT INTO oauth_tokens (key, data) VALUES (%s, %s) "
                "ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
                (key, Jsonb(data)),
            )
        return
    file.write_text(json.dumps(data, indent=2))
    try:
        file.chmod(0o600)
    except OSError:
        pass


def delete(key: str, file: Path) -> None:
    if _db_url():
        with _connect() as conn:
            conn.execute("DELETE FROM oauth_tokens WHERE key = %s", (key,))
        return
    file.unlink(missing_ok=True)
