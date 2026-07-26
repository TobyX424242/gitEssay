"""Checkpoint DAG tests: auto rolling singleton, durable chaining, retention,
restore — the rules documented in app/routers/checkpoints.py's docstring."""
import pytest

from app.routers import checkpoints
from tests.conftest import state


def list_cps(client, pid):
    r = client.get(f"/api/projects/{pid}/checkpoints")
    assert r.status_code == 200
    return r.json()


def current(client, pid):
    r = client.get(f"/api/projects/{pid}/current")
    assert r.status_code == 200
    return r.json()


def capture(client, pid, n, **kw):
    body = {"state": state(n), **kw}
    r = client.post(f"/api/projects/{pid}/checkpoints", json=body)
    assert r.status_code == 200, r.text
    return r.json()


def test_new_project_has_init_checkpoint_as_current(client, project):
    pid = project["id"]
    cps = list_cps(client, pid)
    assert len(cps) == 1
    assert cps[0]["source"] == "init"
    assert cps[0]["parent_id"] is None
    assert current(client, pid)["id"] == cps[0]["id"]


def test_auto_capture_is_a_rolling_singleton(client, project):
    pid = project["id"]
    init = list_cps(client, pid)[0]

    a1 = capture(client, pid, 1, source="auto")
    assert a1["id"] == f"{pid}::auto"
    assert a1["parent_id"] == init["id"]

    a2 = capture(client, pid, 2, source="auto")
    assert a2["id"] == a1["id"]  # same slot, upserted
    assert len(list_cps(client, pid)) == 2  # init + auto only
    assert current(client, pid)["id"] == a1["id"]


def test_manual_capture_skips_auto_and_clears_the_slot(client, project):
    pid = project["id"]
    init = list_cps(client, pid)[0]
    capture(client, pid, 1, source="auto")

    m = capture(client, pid, 2, source="manual", label="v1")
    # current was the auto slot → chain off the auto's parent (init), not the
    # auto node itself; the auto slot is dropped.
    assert m["parent_id"] == init["id"]
    ids = [c["id"] for c in list_cps(client, pid)]
    assert f"{pid}::auto" not in ids
    assert current(client, pid)["id"] == m["id"]


def test_manual_captures_chain_off_latest_durable(client, project):
    pid = project["id"]
    m1 = capture(client, pid, 1, source="manual")
    m2 = capture(client, pid, 2, source="manual")
    init = list_cps(client, pid)[-1]
    assert m1["parent_id"] == init["id"]
    assert m2["parent_id"] == m1["id"]


def test_skip_if_unchanged_dedups_identical_state(client, project):
    pid = project["id"]
    capture(client, pid, 1, source="manual")
    assert capture(client, pid, 1, source="manual", skip_if_unchanged=True) is None
    assert len(list_cps(client, pid)) == 2  # init + one manual
    # a changed state must still capture
    assert capture(client, pid, 2, source="manual", skip_if_unchanged=True) is not None


def test_retention_prunes_oldest_but_keeps_init_and_current(client, project, monkeypatch):
    pid = project["id"]
    monkeypatch.setattr(checkpoints, "MAX_DURABLE_CHECKPOINTS", 3)
    made = [capture(client, pid, n, source="manual") for n in range(5)]

    cps = list_cps(client, pid)
    assert len(cps) == 3  # init + the two newest durables
    ids = [c["id"] for c in cps]
    assert any(c["source"] == "init" for c in cps)  # baseline preserved
    assert current(client, pid)["id"] in ids  # current pointer preserved
    for gone in made[:3]:
        assert gone["id"] not in ids  # oldest pruned first


def test_restore_sets_current_and_clears_auto(client, project):
    pid = project["id"]
    init = list_cps(client, pid)[0]
    capture(client, pid, 1, source="auto")
    before = len(list_cps(client, pid))

    r = client.post(f"/api/projects/{pid}/checkpoints/{init['id']}/restore")
    assert r.status_code == 200
    assert current(client, pid)["id"] == init["id"]
    ids = [c["id"] for c in list_cps(client, pid)]
    assert f"{pid}::auto" not in ids
    assert len(ids) == before - 1  # restore never creates a row


def test_restore_rejects_cross_project_checkpoint(client, project):
    pid = project["id"]
    other = client.post("/api/projects", json={"name": "Other"}).json()
    foreign = list_cps(client, other["id"])[0]
    r = client.post(f"/api/projects/{pid}/checkpoints/{foreign['id']}/restore")
    assert r.status_code == 404


def test_capture_on_missing_project_is_404(client):
    r = client.post("/api/projects/nope/checkpoints", json={"state": state(1)})
    assert r.status_code == 404


def test_list_checkpoints_omits_state(client, project):
    """The list endpoint is metadata-only (states can be huge); state is
    fetched per-checkpoint via GET /checkpoints/{cid}."""
    pid = project["id"]
    capture(client, pid, 1, source="manual")
    cps = list_cps(client, pid)
    assert len(cps) == 2
    assert all("state" not in c for c in cps)


def test_get_checkpoint_returns_full_state(client, project):
    pid = project["id"]
    m = capture(client, pid, 7, source="manual", label="v7")
    r = client.get(f"/api/projects/{pid}/checkpoints/{m['id']}")
    assert r.status_code == 200
    body = r.json()
    assert body["state"] == state(7)
    assert body["label"] == "v7"


def test_get_checkpoint_rejects_cross_project_and_missing(client, project):
    pid = project["id"]
    other = client.post("/api/projects", json={"name": "Other"}).json()
    foreign = list_cps(client, other["id"])[0]
    r = client.get(f"/api/projects/{pid}/checkpoints/{foreign['id']}")
    assert r.status_code == 404
    r = client.get(f"/api/projects/{pid}/checkpoints/nope")
    assert r.status_code == 404
