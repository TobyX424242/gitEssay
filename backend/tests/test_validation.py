"""Input-whitelist tests (REVIEW.md M8/L6): free-string fields are now Literal-
validated, so bad values fail fast with 422 instead of silently misbehaving."""
from tests.conftest import state


def test_checkpoint_source_is_whitelisted(client, project):
    pid = project["id"]
    r = client.post(
        f"/api/projects/{pid}/checkpoints",
        json={"state": state(1), "source": "bogus"},
    )
    assert r.status_code == 422
    # every value in the frontend's CheckpointSource union is accepted
    for src in ("manual", "auto", "ai-accept"):
        r = client.post(
            f"/api/projects/{pid}/checkpoints", json={"state": state(2), "source": src}
        )
        assert r.status_code == 200, src


def test_edit_state_is_whitelisted(client, project):
    conv = client.post(
        f"/api/projects/{project['id']}/conversations", json={"title": "t"}
    ).json()
    msg = {
        "id": "m1",
        "role": "assistant",
        "text": "p",
        "edits": [{"search": "a", "replace": "b", "state": "pending"}],
    }
    client.post(f"/api/conversations/{conv['id']}/messages", json={"messages": [msg]})
    r = client.patch(
        f"/api/conversations/{conv['id']}/messages/m1/edits/0", json={"state": "bogus"}
    )
    assert r.status_code == 422
    r = client.patch(
        f"/api/conversations/{conv['id']}/messages/m1/edits/0", json={"state": "applied"}
    )
    assert r.status_code == 200


def test_provider_format_is_whitelisted(client):
    r = client.put("/api/ai/settings", json={"provider_format": "OpenAI"})
    assert r.status_code == 422
    for fmt in ("openai", "anthropic"):
        assert client.put("/api/ai/settings", json={"provider_format": fmt}).status_code == 200


def test_agent_run_mode_is_whitelisted(client, project):
    body = {
        "project_id": project["id"],
        "instruction": "x",
        "mode": "bogus",
        "doc_paragraphs": [],
    }
    r = client.post("/api/agent/run", json=body)
    assert r.status_code == 422
