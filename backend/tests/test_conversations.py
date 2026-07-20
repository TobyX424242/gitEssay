"""Conversation message-op tests: append / replace (retry) / edit-state, and
the active-conversation bookkeeping."""

def make_conv(client, pid):
    r = client.post(f"/api/projects/{pid}/conversations", json={"title": "t"})
    assert r.status_code == 200
    return r.json()


def append(client, cid, messages):
    r = client.post(f"/api/conversations/{cid}/messages", json={"messages": messages})
    assert r.status_code == 200, r.text
    return r.json()


def test_create_makes_it_active(client, project):
    conv = make_conv(client, project["id"])
    assert client.get(f"/api/projects/{project['id']}").json()[
        "active_conversation_id"
    ] == conv["id"]


def test_append_then_replace_message(client, project):
    conv = make_conv(client, project["id"])
    cid = conv["id"]
    conv = append(client, cid, [{"id": "m1", "role": "user", "text": "hi"}])
    conv = append(client, cid, [{"id": "m2", "role": "assistant", "text": "yo"}])
    assert [m["id"] for m in conv["messages"]] == ["m1", "m2"]

    r = client.put(
        f"/api/conversations/{cid}/messages/m2",
        json={"message": {"id": "m2", "role": "assistant", "text": "retry"}},
    )
    assert r.status_code == 200
    msgs = r.json()["messages"]
    assert len(msgs) == 2  # replace, not append
    assert msgs[1]["text"] == "retry"

    r = client.put(
        f"/api/conversations/{cid}/messages/nope",
        json={"message": {"id": "nope"}},
    )
    assert r.status_code == 404


def test_set_edit_state(client, project):
    conv = make_conv(client, project["id"])
    msg = {
        "id": "m1",
        "role": "assistant",
        "text": "patch",
        "edits": [{"search": "a", "replace": "b", "state": "pending"}],
    }
    append(client, conv["id"], [msg])
    r = client.patch(
        f"/api/conversations/{conv['id']}/messages/m1/edits/0",
        json={"state": "applied"},
    )
    assert r.status_code == 200
    assert r.json()["messages"][0]["edits"][0]["state"] == "applied"

    r = client.patch(
        f"/api/conversations/{conv['id']}/messages/m1/edits/9",
        json={"state": "applied"},
    )
    assert r.status_code == 404


def test_delete_active_conversation_reselects_latest(client, project):
    pid = project["id"]
    c1 = make_conv(client, pid)
    c2 = make_conv(client, pid)  # becomes active
    r = client.delete(f"/api/conversations/{c2['id']}")
    assert r.status_code == 200
    assert r.json()["active_conversation_id"] == c1["id"]
    r = client.delete(f"/api/conversations/{c1['id']}")
    assert r.json()["active_conversation_id"] is None


def test_set_active_rejects_foreign_conversation(client, project):
    other = client.post("/api/projects", json={"name": "Other"}).json()
    foreign = make_conv(client, other["id"])
    r = client.post(
        f"/api/projects/{project['id']}/conversations/active", json={"id": foreign["id"]}
    )
    assert r.status_code == 404
