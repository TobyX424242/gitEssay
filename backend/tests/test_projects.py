"""Project CRUD + cascade tests (incl. the Memory-cascade fix, REVIEW.md M4)."""
from app.db import SessionLocal
from app.models import Checkpoint, Conversation, Memory
from tests.conftest import state


def counts(pid):
    db = SessionLocal()
    try:
        return {
            "checkpoints": db.query(Checkpoint).filter_by(project_id=pid).count(),
            "conversations": db.query(Conversation).filter_by(project_id=pid).count(),
            "memories": db.query(Memory).filter_by(project_id=pid).count(),
        }
    finally:
        db.close()


def test_seed_created_default_project(client):
    names = [p["name"] for p in client.get("/api/projects").json()]
    assert "Default" in names


def test_rename_project(client, project):
    r = client.patch(f"/api/projects/{project['id']}", json={"name": "Renamed"})
    assert r.status_code == 200
    assert client.get(f"/api/projects/{project['id']}").json()["name"] == "Renamed"


def test_delete_project_removes_all_children(client, project):
    pid = project["id"]
    client.post(f"/api/projects/{pid}/checkpoints", json={"state": state(1), "source": "auto"})
    client.post(f"/api/projects/{pid}/conversations", json={"title": "c"})
    client.post(f"/api/projects/{pid}/memories", json={"content": "m"})
    assert counts(pid) == {"checkpoints": 2, "conversations": 1, "memories": 1}

    r = client.delete(f"/api/projects/{pid}")
    assert r.status_code == 200
    assert client.get(f"/api/projects/{pid}").status_code == 404
    # Every child table — including memories — must be empty, not just the two
    # that were deleted explicitly before the Memory fix.
    assert counts(pid) == {"checkpoints": 0, "conversations": 0, "memories": 0}
