"""gitEssay backend — agent framework v2 tests (literature tools, subagents, vision).

The LLM is replaced by a scripted fake (`ScriptedModel` via monkeypatched
`agent_graph.build_model`): each graph build (main or subagent) pops the next
script; a script item is either a ("tool", {args}) call or a plain-reply string.
"""
import os

import pytest
from langchain.messages import AIMessage, HumanMessage
from PIL import Image

from app import agent_graph
from app.literature_search import fts_enabled, index_chunk_fts
from app.agent_graph import (
    IMAGE_BUDGET,
    MAX_AGENT_DEPTH,
    SUBAGENT_DISPATCH_BUDGET,
    RunContext,
    SubagentBudget,
    build_graph,
)
from app.models import (
    AISettings,
    Literature,
    LiteratureChunk,
    LiteratureImage,
    Memory,
    new_id,
    now_ms,
)
from app.storage import literature_dir, literature_rel_path


class ScriptedModel:
    """Stands in for a LangChain chat model: bind_tools records the tool list,
    invoke pops scripted responses (tool call tuple or plain text)."""

    def __init__(self, script):
        self.script = list(script)
        self.tools = None

    def bind_tools(self, tools):
        self.tools = tools
        return self

    def invoke(self, messages):
        if not self.script:
            return AIMessage(content="(script exhausted)")
        item = self.script.pop(0)
        if isinstance(item, str):
            return AIMessage(content=item)
        name, args = item
        return AIMessage(
            content="",
            tool_calls=[{"name": name, "args": args, "id": f"tc-{len(self.script)}"}],
        )


@pytest.fixture()
def models(monkeypatch):
    """Queue of per-graph model scripts. Each build_graph (incl. subagent
    graphs) pops the next script. Returns the created models for inspection."""
    state = {"scripts": [], "built": []}

    def factory(settings):
        script = state["scripts"].pop(0) if state["scripts"] else []
        m = ScriptedModel(script)
        state["built"].append(m)
        return m

    monkeypatch.setattr(agent_graph, "build_model", factory)
    return state


@pytest.fixture()
def settings(db):
    s = db.get(AISettings, 1)
    s.vision_capable = False
    s.embedding_model = ""
    db.commit()
    return s


@pytest.fixture()
def ready_lit(db, project):
    """A ready literature row with one chunk and one real PNG on disk."""
    lid = new_id()
    img_rel = literature_rel_path(lid, "images", "img_0.png")
    os.makedirs(os.path.join(literature_dir(lid), "images"), exist_ok=True)
    Image.new("RGB", (16, 16), color=(10, 90, 200)).save(
        os.path.join(literature_dir(lid), "images", "img_0.png"), "PNG"
    )
    lit = Literature(
        id=lid, project_id=project["id"], filename="paper.pdf", title="Paper P",
        status="ready", page_count=3, char_count=40, chunk_count=1, image_count=1,
        created_at=now_ms(),
    )
    db.add(lit)
    chunk_id = new_id()
    db.add(LiteratureChunk(id=chunk_id, literature_id=lid, seq=0,
                           heading="1 Intro", text="Some intro text about attention."))
    db.add(LiteratureImage(id=new_id(), literature_id=lid, seq=0, caption="Fig A",
                           path=img_rel, width=16, height=16))
    db.commit()
    if fts_enabled():  # mirror what ingest() does for real parses
        index_chunk_fts(db, lid, chunk_id, "1 Intro", "Some intro text about attention.")
        db.commit()
    return lit


def make_ctx(db, settings, project_id, depth=0, memory_enabled=True, budget=None):
    return RunContext(
        db=db, settings=settings, project_id=project_id,
        memory_enabled=memory_enabled, depth=depth,
        budget=budget or SubagentBudget(),
    )


def run_graph(ctx, user_text="go"):
    graph = build_graph(ctx)
    state = {
        "messages": [HumanMessage(content=user_text)],
        "doc_paragraphs": ["the quick brown fox"],
        "steps": [],
        "terminal": None,
        "read_hits": {},
    }
    return graph.invoke(state, config={"recursion_limit": 14})


def tool_names(model) -> set:
    return {getattr(t, "name", "") for t in (model.tools or [])}


# --- depth-based tool binding --------------------------------------------------
def test_depth0_binds_user_facing_and_delegate(db, settings, project, models):
    models["scripts"].append([])  # main graph model
    run_graph(make_ctx(db, settings, project["id"], depth=0))
    names = tool_names(models["built"][0])
    assert {"propose_patch", "ask_user", "delegate_task"} <= names
    assert {"read_document", "search_literature", "read_literature", "read_figure"} <= names
    assert {"remember", "read_notes"} <= names  # memory on


def test_subagent_loses_user_facing_tools(db, settings, project, models):
    models["scripts"].append([])
    run_graph(make_ctx(db, settings, project["id"], depth=1))
    names = tool_names(models["built"][0])
    assert "delegate_task" in names  # can still nest deeper
    assert "propose_patch" not in names
    assert "ask_user" not in names


def test_max_depth_has_no_delegate(db, settings, project, models):
    models["scripts"].append([])
    run_graph(make_ctx(db, settings, project["id"], depth=MAX_AGENT_DEPTH))
    names = tool_names(models["built"][0])
    assert "delegate_task" not in names  # structural hard stop at layer 4


def test_memory_off_drops_note_tools(db, settings, project, models):
    models["scripts"].append([])
    run_graph(make_ctx(db, settings, project["id"], depth=0, memory_enabled=False))
    names = tool_names(models["built"][0])
    assert "remember" not in names
    assert "read_notes" not in names


# --- delegate_task: budget + report flow ----------------------------------------
def test_delegate_budget_exhaustion(db, settings, project, models):
    budget = SubagentBudget(dispatches_left=0)
    models["scripts"].append([("delegate_task", {"task": "analyze X"}), "fallback answer"])
    result = run_graph(make_ctx(db, settings, project["id"], budget=budget))
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert any("budget" in m.content and "exhausted" in m.content for m in tool_msgs)
    assert len(models["built"]) == 1  # no subagent graph was ever built


def test_delegate_runs_subagent_and_returns_report(db, settings, project, ready_lit, models):
    ctx = make_ctx(db, settings, project["id"])
    models["scripts"].append([
        ("delegate_task", {"task": "summarize the paper", "literature_ids": [ready_lit.id]}),
        "main summary done",
    ])
    models["scripts"].append([  # the subagent's script
        ("search_literature", {"query": "attention"}),
        "sub report: the paper uses attention",
    ])
    result = run_graph(ctx)
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert any("sub report: the paper uses attention" in m.content for m in tool_msgs)
    assert ctx.budget.dispatches_left == SUBAGENT_DISPATCH_BUDGET - 1
    # steps: the parent's delegate chip + the subagent's own (nested) steps
    kinds = [(s["kind"], s.get("depth")) for s in result["steps"]]
    assert ("delegate", 1) in kinds
    assert ("literature_search", 1) in kinds  # surfaced nested step


def test_subagent_cannot_delegate_at_max_depth(db, settings, project, ready_lit, models):
    """A depth-3 subagent tree: delegate at depth 3 is refused (belt & braces
    on top of the structural tool absence)."""
    ctx = make_ctx(db, settings, project["id"], depth=MAX_AGENT_DEPTH)
    text, steps = agent_graph._run_subagent(ctx, "too deep", [], False, {"doc_paragraphs": []})
    assert "maximum subagent depth" in text
    assert steps == []


def test_delegate_invalid_literature_ids_are_dropped(db, settings, project, models):
    models["scripts"].append([
        ("delegate_task", {"task": "look at nothing", "literature_ids": ["bogus-id"]}),
        "done",
    ])
    models["scripts"].append(["empty report"])
    result = run_graph(make_ctx(db, settings, project["id"]))
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert any("empty report" in m.content for m in tool_msgs)  # no crash


# --- read_figure / vision ---------------------------------------------------------
def test_read_figure_vision_off_is_text_only(db, settings, project, ready_lit, models):
    settings.vision_capable = False
    db.commit()
    models["scripts"].append([
        ("read_figure", {"literature_id": ready_lit.id, "image_seq": 0}),
        "described from caption",
    ])
    result = run_graph(make_ctx(db, settings, project["id"]))
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert any("vision capability is OFF" in m.content for m in tool_msgs)
    # no multimodal HumanMessage was injected
    humans = [m for m in result["messages"] if getattr(m, "type", None) == "human"]
    assert all(isinstance(m.content, str) for m in humans)


def test_read_figure_vision_on_attaches_image(db, settings, project, ready_lit, models):
    settings.vision_capable = True
    db.commit()
    ctx = make_ctx(db, settings, project["id"])
    models["scripts"].append([
        ("read_figure", {"literature_id": ready_lit.id, "image_seq": 0}),
        "the figure shows a blue square",
    ])
    result = run_graph(ctx)
    humans = [m for m in result["messages"] if getattr(m, "type", None) == "human"]
    image_blocks = [
        b for m in humans if isinstance(m.content, list)
        for b in m.content if isinstance(b, dict) and b.get("type") == "image"
    ]
    assert len(image_blocks) == 1
    assert image_blocks[0]["source_type"] == "base64"
    assert image_blocks[0]["data"]
    assert ctx.budget.images_left == IMAGE_BUDGET - 1


def test_read_figure_image_budget_cap(db, settings, project, ready_lit, models):
    settings.vision_capable = True
    db.commit()
    budget = SubagentBudget(images_left=0)
    models["scripts"].append([
        ("read_figure", {"literature_id": ready_lit.id, "image_seq": 0}),
        "done",
    ])
    result = run_graph(make_ctx(db, settings, project["id"], budget=budget))
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert any("image budget reached" in m.content for m in tool_msgs)


def test_read_figure_unknown_seq(db, settings, project, ready_lit, models):
    models["scripts"].append([
        ("read_figure", {"literature_id": ready_lit.id, "image_seq": 99}),
        "done",
    ])
    result = run_graph(make_ctx(db, settings, project["id"]))
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert any("has no figure #99" in m.content for m in tool_msgs)


# --- literature tools ------------------------------------------------------------
def test_search_literature_tool_formats_hits(db, settings, project, ready_lit, models):
    models["scripts"].append([
        ("search_literature", {"query": "attention"}),
        "found it",
    ])
    result = run_graph(make_ctx(db, settings, project["id"]))
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert any("《Paper P》" in m.content and "attention" in m.content for m in tool_msgs)
    steps = result["steps"]
    assert any(s["kind"] == "literature_search" and s["hits"] >= 1 for s in steps)


def test_read_literature_unknown_id(db, settings, project, models):
    models["scripts"].append([
        ("read_literature", {"literature_id": "nope"}),
        "done",
    ])
    result = run_graph(make_ctx(db, settings, project["id"]))
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert any("Unknown literature id" in m.content for m in tool_msgs)


# --- literature-scoped memory -------------------------------------------------------
def test_remember_attaches_literature(db, settings, project, ready_lit, models):
    models["scripts"].append([
        ("remember", {"note": "strong baseline for translation tasks", "literature_id": ready_lit.id}),
        "noted",
    ])
    run_graph(make_ctx(db, settings, project["id"]))
    rows = db.query(Memory).filter_by(literature_id=ready_lit.id).all()
    assert len(rows) == 1
    assert "strong baseline" in rows[0].content


def test_remember_rejects_unknown_literature(db, settings, project, models):
    models["scripts"].append([
        ("remember", {"note": "orphan note", "literature_id": "nope"}),
        "done",
    ])
    result = run_graph(make_ctx(db, settings, project["id"]))
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert any("Unknown literature id" in m.content for m in tool_msgs)
    assert db.query(Memory).filter_by(project_id=project["id"]).count() == 0


def test_read_notes_returns_literature_notes(db, settings, project, ready_lit, models):
    db.add(Memory(id=new_id(), project_id=project["id"], literature_id=ready_lit.id,
                  content="prior finding: uses sinusoidal encodings", created_at=now_ms()))
    db.commit()
    models["scripts"].append([
        ("read_notes", {"literature_id": ready_lit.id}),
        "I recall it now",
    ])
    result = run_graph(make_ctx(db, settings, project["id"]))
    tool_msgs = [m for m in result["messages"] if getattr(m, "type", None) == "tool"]
    assert any("sinusoidal" in m.content for m in tool_msgs)
