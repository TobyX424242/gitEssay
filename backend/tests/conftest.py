"""gitEssay backend — pytest fixtures.

The DB path is read from GITESSAY_DB at import time (app/db.py), so it must be
pointed at a throwaway file BEFORE any `app.*` import. Each test gets its own
project, so tests share one seeded app instance safely (all state is
project-scoped).
"""
import os
import tempfile

os.environ["GITESSAY_DB"] = os.path.join(tempfile.mkdtemp(prefix="ge-test-"), "test.db")

import pytest
from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app


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
