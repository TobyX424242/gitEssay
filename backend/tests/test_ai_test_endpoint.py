"""POST /api/ai/test must never send the STORED key to a DIFFERENT base_url —
the endpoint is unauthenticated, so a base_url override + the implicit stored
key would be an API-key exfiltration primitive. call_model is monkeypatched;
no network.
"""
import pytest

from app.models import AISettings


@pytest.fixture()
def settings(db):
    """Snapshot the singleton settings row and restore it afterwards (the
    suite shares one DB — leave no residue for other tests)."""
    s = db.get(AISettings, 1)
    snap = {k: getattr(s, k) for k in
            ("provider_format", "base_url", "model", "temperature",
             "max_input_tokens", "max_output_tokens", "vision_capable",
             "embedding_model")}
    snap_key = s.api_key
    s.base_url = "https://api.saved.example"
    s.api_key = "stored-sekret"
    s.model = "saved-model"
    db.commit()
    yield s
    for k, v in snap.items():
        setattr(s, k, v)
    s.api_key = snap_key
    db.commit()


def test_ai_test_refuses_stored_key_to_new_base_url(client, settings, monkeypatch):
    called = []
    monkeypatch.setattr("app.ai.call_model", lambda *a: called.append(a) or "OK")
    r = client.post("/api/ai/test", json={"base_url": "https://evil.example.com"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is False
    assert "Re-enter the API key" in body["message"]
    assert called == [], "call_model must not run — the key would leak"


def test_ai_test_allows_same_base_url_with_stored_key(client, settings, monkeypatch):
    seen = {}

    def fake(s, system, user):
        seen["api_key"] = s.api_key
        seen["base_url"] = s.base_url
        return "OK"

    monkeypatch.setattr("app.ai.call_model", fake)
    # Trailing-slash variant of the stored URL is still the SAME endpoint.
    r = client.post("/api/ai/test", json={"base_url": "https://api.saved.example/"})
    assert r.json()["ok"] is True
    assert seen == {"api_key": "stored-sekret", "base_url": "https://api.saved.example/"}


def test_ai_test_allows_new_base_url_with_explicit_key(client, settings, monkeypatch):
    seen = {}

    def fake(s, system, user):
        seen["api_key"] = s.api_key
        return "OK"

    monkeypatch.setattr("app.ai.call_model", fake)
    r = client.post(
        "/api/ai/test",
        json={"base_url": "https://other.example.com", "api_key": "freshly-typed"},
    )
    assert r.json()["ok"] is True
    assert seen["api_key"] == "freshly-typed", "the typed key — not the stored one — is used"
