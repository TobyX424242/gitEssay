"""gitEssay backend — pytest fixtures.

The DB path is read from GITESSAY_DB at import time (app/db.py), so it must be
pointed at a throwaway file BEFORE any `app.*` import. Each test gets its own
project, so tests share one seeded app instance safely (all state is
project-scoped).
"""
import os
import tempfile

os.environ["GITESSAY_DB"] = os.path.join(tempfile.mkdtemp(prefix="ge-test-"), "test.db")
# Tests must never touch the developer's real OS keychain — force the DB
# fallback path in app/secrets.py.
os.environ["GITESSAY_DISABLE_KEYRING"] = "1"

import pytest
from fastapi.testclient import TestClient

from app import bg
from app.db import SessionLocal
from app.main import _startup, app

# Importing app.main no longer initializes the DB (startup moved to the ASGI
# lifespan, which TestClient only runs as a context manager). Run it once
# here so both the `client` and the bare `db` fixtures see a seeded app.
_startup()


@pytest.fixture(autouse=True)
def _quiesce_background():
    """Wait out in-flight literature ingest/summary threads after each test:
    the shared test DB means a previous test's background parse could still be
    running inside the next test's monkeypatch window (flaky call counts)."""
    yield
    bg.wait_for_background()


@pytest.fixture()
def client():
    return TestClient(app)


@pytest.fixture()
def db():
    """A direct DB session on the shared test database."""
    s = SessionLocal()
    try:
        yield s
    finally:
        s.close()


@pytest.fixture()
def project(client):
    """A fresh project (with its seeded init checkpoint)."""
    r = client.post("/api/projects", json={"name": "Test"})
    assert r.status_code == 200, r.text
    return r.json()


def state(n: int) -> dict:
    """A minimal distinct SerializedEditorState-shaped payload per n."""
    return {"root": {"children": [{"type": "paragraph", "version": 1, "children": [
        {"type": "text", "version": 1, "text": f"doc {n}"}], "format": "",
        "indent": 0, "direction": None}], "direction": None, "format": "",
        "indent": 0, "type": "root", "version": 1}}
