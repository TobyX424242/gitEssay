"""LaTeX equation support in the agent pipeline: the request carries the
document's equations ([{nonce, inline, latex}]), the initial user message lists
them so the agent can read each [[EQ:nonce]] as a LaTeX equation block, and
equation edits ({equation, latex}) are split from text edits in propose_patch.
"""
from app.agent_graph import _equation_listing, _initial_user_message, _split_edits
from app.schemas import AgentRunRequest


def make_req(**kw):
    base = dict(
        project_id="p",
        instruction="improve it",
        doc_paragraphs=["Energy is [[EQ:ab12cd34]] here."],
    )
    base.update(kw)
    return AgentRunRequest(**base)


def test_request_accepts_doc_equations_and_defaults_empty():
    req = make_req(doc_equations=[{"nonce": "ab12cd34", "inline": True, "latex": "E=mc^2"}])
    assert req.doc_equations[0]["latex"] == "E=mc^2"
    assert make_req().doc_equations == []


def test_equation_listing_renders_nonce_mode_and_latex():
    lines = _equation_listing(
        [
            {"nonce": "ab12cd34", "inline": True, "latex": "E=mc^2"},
            {"nonce": "ffffffff", "inline": False, "latex": "\\frac{a}{b}"},
        ]
    )
    body = "\n".join(lines)
    assert "[[EQ:ab12cd34]] (inline): E=mc^2" in body
    assert "[[EQ:ffffffff]] (display): \\frac{a}{b}" in body


def test_equation_listing_skips_malformed_entries():
    assert _equation_listing([{"inline": True}, "junk", None]) == []
    assert _equation_listing([]) == []
    assert _equation_listing(None) == []


def test_initial_message_lists_equations_for_the_agent():
    req = make_req(doc_equations=[{"nonce": "ab12cd34", "inline": True, "latex": "E=mc^2"}])
    msg = _initial_user_message(req)
    assert "LaTeX equations in the document" in msg
    assert "[[EQ:ab12cd34]] (inline): E=mc^2" in msg


def test_initial_message_omits_listing_without_equations():
    assert "LaTeX equations" not in _initial_user_message(make_req())


def test_split_edits_separates_text_and_equation_edits():
    edits, eq_edits, appends = _split_edits(
        [
            {"search": "a", "replace": "b"},
            {"equation": "ab12cd34", "latex": "E=mc^2"},
            {"append": "A brand-new ending."},
            {"search": "", "replace": ""},  # empty text edit still a text edit
        ]
    )
    assert edits == [{"search": "a", "replace": "b"}, {"search": "", "replace": ""}]
    assert eq_edits == [{"nonce": "ab12cd34", "latex": "E=mc^2"}]
    assert appends == [{"text": "A brand-new ending."}]


def test_set_eq_edit_state(client, project):
    r = client.post(f"/api/projects/{project['id']}/conversations", json={"title": "t"})
    assert r.status_code == 200
    conv = r.json()
    msg = {
        "id": "m1",
        "role": "assistant",
        "text": "patch",
        "eqEdits": [{"nonce": "ab12cd34", "latex": "x", "state": "pending"}],
    }
    r = client.post(f"/api/conversations/{conv['id']}/messages", json={"messages": [msg]})
    assert r.status_code == 200, r.text
    r = client.patch(
        f"/api/conversations/{conv['id']}/messages/m1/edits/0",
        json={"state": "applied", "kind": "eq", "prev_latex": "old-x"},
    )
    assert r.status_code == 200, r.text
    eq = r.json()["messages"][0]["eqEdits"][0]
    assert eq["state"] == "applied"
    assert eq["prevLatex"] == "old-x"


def test_set_eq_edit_state_404_without_eq_edits(client, project):
    r = client.post(f"/api/projects/{project['id']}/conversations", json={"title": "t"})
    conv = r.json()
    msg = {"id": "m1", "role": "assistant", "text": "patch", "edits": []}
    client.post(f"/api/conversations/{conv['id']}/messages", json={"messages": [msg]})
    r = client.patch(
        f"/api/conversations/{conv['id']}/messages/m1/edits/0",
        json={"state": "applied", "kind": "eq"},
    )
    assert r.status_code == 404


def test_set_append_edit_state(client, project):
    r = client.post(f"/api/projects/{project['id']}/conversations", json={"title": "t"})
    assert r.status_code == 200
    conv = r.json()
    msg = {
        "id": "m1",
        "role": "assistant",
        "text": "patch",
        "appendEdits": [{"text": "new ending", "state": "pending"}],
    }
    r = client.post(f"/api/conversations/{conv['id']}/messages", json={"messages": [msg]})
    assert r.status_code == 200, r.text
    r = client.patch(
        f"/api/conversations/{conv['id']}/messages/m1/edits/0",
        json={"state": "applied", "kind": "append"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["messages"][0]["appendEdits"][0]["state"] == "applied"


def test_set_append_edit_state_404_without_append_edits(client, project):
    r = client.post(f"/api/projects/{project['id']}/conversations", json={"title": "t"})
    conv = r.json()
    msg = {"id": "m1", "role": "assistant", "text": "patch", "edits": []}
    client.post(f"/api/conversations/{conv['id']}/messages", json={"messages": [msg]})
    r = client.patch(
        f"/api/conversations/{conv['id']}/messages/m1/edits/0",
        json={"state": "applied", "kind": "append"},
    )
    assert r.status_code == 404
