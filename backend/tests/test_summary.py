"""gitEssay backend — auto-summary subagent tests (map-reduce, long-doc bounds).

The LLM is monkeypatched (`app.ai.call_model`), so no provider is needed.
"""
import pytest

from app import literature_ingest, literature_summary
from app.literature_ingest import ExtractedChunk, ExtractedDoc, ingest
from app.literature_summary import (
    MAX_CHUNKS,
    _select_chunks,
    ai_configured,
    generate_summary,
    start_summary,
)
from app.models import AISettings, Literature, LiteratureChunk, new_id, now_ms


@pytest.fixture()
def configured(db):
    """AI settings with a key (so ai_configured is True); call_model still fake."""
    s = db.get(AISettings, 1)
    s.base_url = "https://api.example.com/v1"
    s.api_key = "test-key"
    s.model = "test-model"
    db.commit()
    return s


@pytest.fixture()
def ready_lit(db, project):
    """A ready literature row with a handful of chunks (no files needed)."""
    lid = new_id()
    lit = Literature(
        id=lid, project_id=project["id"], filename="paper.pdf", title="Paper S",
        status="ready", page_count=5, chunk_count=3, image_count=0, created_at=now_ms(),
    )
    db.add(lit)
    for i, (head, text) in enumerate([
        ("1 Intro", "We study attention in transformers."),
        ("2 Methods", "Multi-head self-attention, scaled dot-product."),
        ("3 Results", "BLEU improves by 2 points on WMT."),
    ]):
        db.add(LiteratureChunk(id=new_id(), literature_id=lid, seq=i, heading=head, text=text))
    db.commit()
    return lit


def _fake_call_model(summary_text="FINAL SUMMARY"):
    calls = []

    def fake(settings, system, user):
        calls.append({"system": system, "user": user})
        if "library summary" in system:
            return summary_text
        return f"notes for part ({len(user)} chars)"

    fake.calls = calls
    return fake


# --- long-document selection bounds ----------------------------------------------
def test_select_chunks_bounds_and_covers_long_docs(db, ready_lit):
    lid = ready_lit.id
    # Simulate a book: 500 chunks.
    for i in range(3, 500):
        db.add(LiteratureChunk(id=new_id(), literature_id=lid, seq=i,
                               heading=f"Ch {i}", text=f"content {i} " * 50))
    db.commit()
    chunks = db.query(LiteratureChunk).filter_by(literature_id=lid).order_by(LiteratureChunk.seq).all()
    assert len(chunks) == 500
    sel = _select_chunks(chunks)
    assert len(sel) <= MAX_CHUNKS
    assert sel[0].seq == 0  # opening kept
    assert sel[-1].seq == 499  # conclusion kept
    seqs = [c.seq for c in sel]
    assert seqs == sorted(seqs)  # document order preserved


def test_select_chunks_short_doc_passthrough(db, ready_lit):
    chunks = db.query(LiteratureChunk).filter_by(literature_id=ready_lit.id).all()
    assert len(_select_chunks(chunks)) == 3


# --- summary generation ------------------------------------------------------------
def test_generate_summary_map_reduce(db, project, ready_lit, configured, monkeypatch):
    fake = _fake_call_model()
    monkeypatch.setattr("app.ai.call_model", fake)
    generate_summary(db, ready_lit.id)
    db.refresh(ready_lit)
    assert ready_lit.summary_status == "ready"
    assert ready_lit.summary == "FINAL SUMMARY"
    # 1 map call (3 small chunks fit one group) + 1 reduce call
    assert len(fake.calls) == 2
    assert "Per-part notes" in fake.calls[-1]["user"]


def test_generate_summary_empty_doc_raises(db, project, configured):
    lid = new_id()
    db.add(Literature(id=lid, project_id=project["id"], filename="x.pdf",
                      title="X", status="ready", created_at=now_ms()))
    db.commit()
    with pytest.raises(RuntimeError, match="no text"):
        generate_summary(db, lid)


def test_start_summary_skips_when_unconfigured(db, project, ready_lit, monkeypatch):
    s = db.get(AISettings, 1)
    s.api_key = ""
    db.commit()
    started = []
    monkeypatch.setattr(literature_summary.threading, "Thread",
                        lambda *a, **k: started.append(a) or type("T", (), {"start": lambda self: None})())
    start_summary(ready_lit.id)
    db.refresh(ready_lit)
    assert ready_lit.summary_status == "skipped"
    assert not started


def test_summary_safe_failure_marks_failed(db, project, ready_lit, configured, monkeypatch):
    monkeypatch.setattr(
        literature_summary, "generate_summary",
        lambda db_, lid: (_ for _ in ()).throw(RuntimeError("LLM down")),
    )
    literature_summary._summary_safe(ready_lit.id)
    db.refresh(ready_lit)
    assert ready_lit.summary_status == "failed"


def test_ingest_autokicks_summary(client, project, db, monkeypatch):
    monkeypatch.setattr(
        literature_ingest, "_extract",
        lambda path, filename, **_: ExtractedDoc(
            title="Auto", page_count=1,
            chunks=[ExtractedChunk("Intro", "hello world")], images=[]),
    )
    kicked = []
    monkeypatch.setattr(literature_ingest, "start_summary", lambda lid: kicked.append(lid))
    monkeypatch.setattr("app.routers.literature.start_ingest", lambda lid: None)
    r = client.post(
        f"/api/projects/{project['id']}/literature",
        files={"file": ("a.pdf", b"%PDF x", "application/pdf")},
    )
    lid = r.json()["id"]
    ingest(db, lid)
    assert kicked == [lid]


# --- download + regenerate endpoints --------------------------------------------------
def test_download_serves_original(client, project, db, monkeypatch):
    monkeypatch.setattr(
        literature_ingest, "_extract",
        lambda path, filename, **_: ExtractedDoc(
            title="T", page_count=1, chunks=[ExtractedChunk("A", "text")], images=[]),
    )
    monkeypatch.setattr("app.routers.literature.start_ingest", lambda lid: None)
    payload = b"%PDF-1.4 original-bytes"
    r = client.post(
        f"/api/projects/{project['id']}/literature",
        files={"file": ("my-paper.pdf", payload, "application/pdf")},
    )
    lid = r.json()["id"]
    dl = client.get(f"/api/literature/{lid}/download")
    assert dl.status_code == 200
    assert dl.content == payload
    assert "my-paper.pdf" in dl.headers.get("content-disposition", "")


def test_regenerate_summary_endpoint(client, project, db, ready_lit, configured, monkeypatch):
    monkeypatch.setattr("app.routers.literature.start_summary", lambda lid: None)
    r = client.post(f"/api/literature/{ready_lit.id}/summary")
    assert r.status_code == 200
    # not ready → 409; AI unconfigured → 400
    s = db.get(AISettings, 1)
    s.api_key = ""
    db.commit()
    r = client.post(f"/api/literature/{ready_lit.id}/summary")
    assert r.status_code == 400
    ready_lit.status = "processing"
    db.commit()
    s.api_key = "k"
    db.commit()
    r = client.post(f"/api/literature/{ready_lit.id}/summary")
    assert r.status_code == 409


def test_agent_read_literature_includes_summary(db, project, ready_lit, configured, monkeypatch):
    """The LangGraph read_literature tool leads with the AI summary when present."""
    from app import agent_graph
    from app.agent_graph import RunContext, SubagentBudget, build_graph
    from langchain.messages import AIMessage, HumanMessage

    ready_lit.summary = "This paper is about attention."
    db.commit()
    settings = db.get(AISettings, 1)

    class M:
        def __init__(self):
            self.script = [
                ("read_literature", {"literature_id": ready_lit.id}),
                "done",
            ]

        def bind_tools(self, tools):
            return self

        def invoke(self, messages):
            item = self.script.pop(0)
            if isinstance(item, str):
                return AIMessage(content=item)
            name, args = item
            return AIMessage(content="", tool_calls=[{"name": name, "args": args, "id": "t1"}])

    monkeypatch.setattr(agent_graph, "build_model", lambda s: M())
    ctx = RunContext(db=db, settings=settings, project_id=project["id"],
                     memory_enabled=False, depth=0, budget=SubagentBudget())
    result = build_graph(ctx).invoke(
        {"messages": [HumanMessage(content="go")], "doc_paragraphs": ["x"],
         "steps": [], "terminal": None, "read_hits": {}},
        config={"recursion_limit": 6},
    )
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert any("This paper is about attention." in m.content for m in tool_msgs)
