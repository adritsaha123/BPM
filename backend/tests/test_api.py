from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"


def test_ai_chat_mock(monkeypatch):
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    from app.config import get_settings

    get_settings.cache_clear()
    r = client.post("/ai/chat", json={"message": "hello"})
    assert r.status_code == 200
    assert "hello" in r.json()["reply"]


def test_items_crud():
    r = client.post("/items", json={"title": "demo"})
    assert r.status_code == 201
    item_id = r.json()["id"]
    assert any(i["id"] == item_id for i in client.get("/items").json())
    assert client.delete(f"/items/{item_id}").status_code == 204
    assert client.delete(f"/items/{item_id}").status_code == 404
