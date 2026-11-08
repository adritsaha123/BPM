"""token_store: JSON files on the laptop, Postgres when DATABASE_URL is set."""

import pytest

from app import token_store
from app.config import get_settings


@pytest.fixture(autouse=True)
def fresh_settings():
    get_settings.cache_clear()
    yield
    get_settings.cache_clear()


def test_files_without_database(monkeypatch, tmp_path):
    monkeypatch.setenv("DATABASE_URL", "")
    f = tmp_path / "t.json"
    assert token_store.load("whoop:x", f) is None
    token_store.save("whoop:x", f, {"access_token": "a"})
    assert token_store.load("whoop:x", f) == {"access_token": "a"}
    token_store.delete("whoop:x", f)
    assert not f.exists()


class FakeDb:
    """Stands in for a psycopg connection: just enough SQL for token_store."""

    def __init__(self):
        self.rows: dict[str, dict] = {}
        self._result = None

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def execute(self, sql, params=()):
        if sql.lstrip().startswith("SELECT"):
            self._result = (self.rows[params[0]],) if params[0] in self.rows else None
        elif sql.lstrip().startswith("INSERT"):
            self.rows[params[0]] = params[1].obj  # Jsonb wrapper
        elif sql.lstrip().startswith("DELETE"):
            self.rows.pop(params[0], None)
        return self

    def fetchone(self):
        return self._result


def test_postgres_when_database_url_is_set(monkeypatch, tmp_path):
    pytest.importorskip("psycopg")
    monkeypatch.setenv("DATABASE_URL", "postgresql://example/db")
    db = FakeDb()
    monkeypatch.setattr(token_store, "_connect", lambda: db)
    f = tmp_path / "unused.json"
    token_store.save("whoop:u1", f, {"access_token": "w"})
    assert db.rows == {"whoop:u1": {"access_token": "w"}} and not f.exists()
    assert token_store.load("whoop:u1", f) == {"access_token": "w"}
    token_store.delete("whoop:u1", f)
    assert token_store.load("whoop:u1", f) is None
