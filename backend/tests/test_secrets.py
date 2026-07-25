"""API key storage: with the keychain disabled (conftest sets
GITESSAY_DISABLE_KEYRING=1), the DB fallback path must keep a full
read/write/clear roundtrip working, and the settings API must never echo the
real key back to the browser."""
from app import secrets
from app.models import AISettings


def test_db_fallback_roundtrip(db):
    s = db.get(AISettings, 1)
    s.api_key = "sk-test-123"
    db.commit()
    # Fallback path: value persists in the DB column and reads back through
    # the property.
    assert s._api_key == "sk-test-123"
    assert s.api_key == "sk-test-123"
    # Clearing works too.
    s.api_key = ""
    db.commit()
    assert s.api_key == ""


def test_settings_api_never_returns_key(client, db):
    r = client.put("/api/ai/settings", json={"api_key": "sk-secret"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["has_key"] is True
    assert body["api_key"] == ""  # masked, never the real key
    r = client.get("/api/ai/settings")
    assert r.json()["api_key"] == ""
    assert "sk-secret" not in r.text
    # Cleanup so other tests see an unconfigured AI.
    db.get(AISettings, 1).api_key = ""
    db.commit()


def test_keychain_disabled_by_env():
    assert secrets._backend() is None
