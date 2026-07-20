"""gitEssay backend — LangGraph agent graph + SSE bridge.

A hand-rolled ReAct StateGraph (agent node calls model.bind_tools -> tools node
executes -> route). Tools that produce reviewable output (propose_patch /
ask_user) are TERMINAL: the tools node sets state.terminal and the after_tools
edge routes to END, preserving the current one-patch-per-turn / ask-then-new-turn
UX. No checkpointer (no HITL interrupts), so the graph is built and run
statelessly per request — which also lets the tools node close over the DB
session, project id, memory flag, and the run's budget/context.

Subagents: `delegate_task` runs the SAME graph builder recursively with
depth+1 and a restricted tool set (no propose_patch/ask_user; no delegate at
MAX_AGENT_DEPTH). Boundary conditions:
  - at most 4 layers total (depth 0..MAX_AGENT_DEPTH=3) — the delegate tool is
    structurally absent at depth 3;
  - a shared SubagentBudget caps total dispatches (8) and images (6) per root
    run across the whole tree;
  - subagents get NO conversation history (context can't explode) and a lower
    recursion limit (12);
  - a failing subagent returns an error STRING as the tool result — the parent
    run is never crashed by its children.

run_agent_stream() drives graph.astream(stream_mode=['messages','updates'],
version='v2') and yields the normalized SSE events the frontend consumes:
text / thinking / step / patch / ask / done / error.
"""
import base64
import io
import logging
from dataclasses import dataclass, field, replace

from langchain.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.errors import GraphRecursionError
from langgraph.graph import END, START, StateGraph

from app.agent_prompt import (
    build_subagent_prompt,
    build_system_prompt,
    load_literature_notes,
    load_memories,
)
from app.agent_state import AgentState
from app.agent_tools import (
    ask_user as ask_user_tool,
    delegate_task as delegate_task_tool,
    do_read,
    list_literature as list_literature_tool,
    propose_patch as propose_patch_tool,
    read_document as read_document_tool,
    read_figure as read_figure_tool,
    read_literature as read_literature_tool,
    read_notes as read_notes_tool,
    remember as remember_tool,
    search_document as search_document_tool,
    search_literature as search_literature_tool,
)
from app.literature_search import literature_index, read_section, search_chunks
from app.llm import build_model
from app.models import Literature, LiteratureImage, Memory, new_id, now_ms
from app.storage import abs_path

log = logging.getLogger(__name__)

RECURSION_LIMIT = 18  # ~9 model calls (agent+tools = 2 steps each); bounds runaway loops
MAX_AGENT_DEPTH = 3  # depth 0..3 → at most 4 layers including the main agent
SUBAGENT_RECURSION_LIMIT = 12
SUBAGENT_DISPATCH_BUDGET = 8  # total delegate_task calls per root run (whole tree)
IMAGE_BUDGET = 6  # figures attached to the model per root run
REPORT_CHAR_CAP = 6000  # subagent report size returned to the parent
TASK_CHAR_CAP = 4000
NOTE_CHAR_CAP = 2000
SEARCH_RESULT_CAP = 8000
FIGURE_MAX_EDGE = 1568  # px, longest side (Anthropic guidance)
FIGURE_MAX_BYTES = 1_500_000  # per-image base64 payload target


@dataclass
class SubagentBudget:
    """Shared, mutable run budget — one instance per ROOT run, passed down the
    whole subagent tree so nesting can't multiply resource use unboundedly."""

    dispatches_left: int = SUBAGENT_DISPATCH_BUDGET
    images_left: int = IMAGE_BUDGET


@dataclass(frozen=True)
class RunContext:
    """What a graph (or sub-graph) closes over. `replace(ctx, depth=…)` descends."""

    db: object  # Session (kept untyped to avoid importing sqlalchemy here)
    settings: object  # AISettings
    project_id: str
    memory_enabled: bool
    depth: int
    budget: SubagentBudget = field(default_factory=SubagentBudget)


# --- input shaping ---------------------------------------------------------
def _history_to_messages(history: list) -> list:
    msgs = []
    for t in history or []:
        role = t.get("role")
        content = t.get("content", "")
        msgs.append(AIMessage(content=content) if role == "assistant" else HumanMessage(content=content))
    return msgs


def _initial_user_message(req) -> str:
    if req.mode == "selection" and req.selection_text:
        return "\n".join([
            "The user selected this passage as the edit target:",
            '"""',
            req.selection_text,
            '"""',
            "",
            f"User request: {req.instruction}",
            "",
            "Edit the selection directly with propose_patch, or use read_document/search_document first if you need wider context from the full document.",
        ])
    full = "\n\n".join(req.doc_paragraphs)
    return "\n".join([
        "Here is the current document:",
        '"""',
        full,
        '"""',
        "",
        f"User request: {req.instruction}",
    ])


def _seed_state(req, ctx: RunContext) -> dict:
    paragraphs = list(req.doc_paragraphs)
    memories = load_memories(ctx.db, req.project_id) if req.memory_enabled else []
    literatures = literature_index(ctx.db, req.project_id)
    system_prompt = build_system_prompt(req.memory_enabled, memories, literatures)
    messages = [
        SystemMessage(content=system_prompt),
        *_history_to_messages(req.history),
        HumanMessage(content=_initial_user_message(req)),
    ]
    # In document mode the full doc is embedded in the initial message, so a later
    # full read should back-reference it. Selection mode starts empty (full doc not
    # yet seen — the agent must read_document to see the rest).
    read_hits = {"": len(paragraphs)} if req.mode == "document" else {}
    return {
        "messages": messages,
        "doc_paragraphs": paragraphs,
        "steps": [],
        "terminal": None,
        "read_hits": read_hits,
    }


# --- tool set ---------------------------------------------------------------
def _tools_for(ctx: RunContext) -> list:
    """Depth-aware tool binding. Only the depth-0 main agent can touch the user
    (propose_patch/ask_user); only agents below MAX_AGENT_DEPTH can delegate —
    so the tree is structurally capped at 4 layers."""
    tools = [
        read_document_tool,
        search_document_tool,
        list_literature_tool,
        search_literature_tool,
        read_literature_tool,
        read_figure_tool,
    ]
    if ctx.memory_enabled:
        tools += [remember_tool, read_notes_tool]
    if ctx.depth == 0:
        tools += [propose_patch_tool, ask_user_tool]
    if ctx.depth < MAX_AGENT_DEPTH:
        tools.append(delegate_task_tool)
    return tools


# --- literature tool helpers (executed by the tools node) ---------------------
def _lit_or_error(ctx: RunContext, literature_id: str) -> tuple[Literature | None, str | None]:
    lid = (literature_id or "").strip()
    lit = ctx.db.get(Literature, lid) if lid else None
    if lit is None or lit.project_id != ctx.project_id:
        return None, f"Unknown literature id '{literature_id}' — call list_literature for valid ids."
    if lit.status != "ready":
        return None, f"'{lit.title}' is not ready yet (status: {lit.status}). Try again later."
    return lit, None


def _format_hits(hits) -> str:
    if not hits:
        return "(no matching passages in the literature)"
    parts = []
    total = 0
    for i, h in enumerate(hits):
        block = f"[{i + 1}] 《{h.title}》 § {h.heading or '(no section)'}\n{h.text}"
        if total + len(block) > SEARCH_RESULT_CAP:
            break
        parts.append(block)
        total += len(block)
    return "\n\n".join(parts)


def _list_literature_text(ctx: RunContext) -> str:
    rows = (
        ctx.db.query(Literature)
        .filter_by(project_id=ctx.project_id)
        .order_by(Literature.created_at.asc())
        .all()
    )
    if not rows:
        return "(no literature uploaded to this project yet)"
    lines = []
    for lit in rows:
        status = "" if lit.status == "ready" else f" [{lit.status}]"
        lines.append(
            f"- id={lit.id} | 《{lit.title or lit.filename}》 | {lit.page_count}p, "
            f"{lit.chunk_count} chunks, {lit.image_count} figures{status}"
        )
    return "\n".join(lines)


def _read_literature_text(ctx: RunContext, literature_id: str, section: str) -> tuple[str, str]:
    lit, err = _lit_or_error(ctx, literature_id)
    if err:
        return err, ""
    outline, body = read_section(ctx.db, lit.id, section or None)
    header = f"《{lit.title}》"
    # The auto-generated summary is the cheapest orientation the agent can get —
    # always lead with it when available, before navigating into sections.
    if lit.summary:
        header += f"\nAI summary:\n{lit.summary}"
    if outline:
        header += "\nSection outline:\n" + "\n".join(f"  {i + 1}. {h}" for i, h in enumerate(outline))
    if section and not body:
        return f"{header}\n\n(no section matches '{section}' — see the outline above)", lit.title
    scope = f"section matching '{section}'" if section else "opening"
    return f"{header}\n\n--- {scope} ---\n{body or '(empty)'}", lit.title


def _load_figure_b64(path: str) -> tuple[str, str]:
    """Downscale + (re)encode a figure for a vision model. Returns (b64, mime)."""
    from PIL import Image

    im = Image.open(path)
    im.thumbnail((FIGURE_MAX_EDGE, FIGURE_MAX_EDGE))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    if buf.tell() > FIGURE_MAX_BYTES:  # too big for one payload → JPEG
        buf = io.BytesIO()
        im.convert("RGB").save(buf, "JPEG", quality=85)
        return base64.b64encode(buf.getvalue()).decode(), "image/jpeg"
    return base64.b64encode(buf.getvalue()).decode(), "image/png"


def _figure_result(ctx: RunContext, literature_id: str, seq: int) -> tuple[str, list, str]:
    """Returns (tool_text, extra_messages, lit_title). With vision ON and image
    budget left, extra_messages carries the figure as a standard multimodal
    content block (langchain translates it per provider)."""
    lit, err = _lit_or_error(ctx, literature_id)
    if err:
        return err, [], ""
    img = (
        ctx.db.query(LiteratureImage)
        .filter_by(literature_id=lit.id, seq=seq)
        .first()
    )
    if img is None:
        return f"《{lit.title}》 has no figure #{seq} (0..{lit.image_count - 1}).", [], lit.title
    text = f"Figure #{seq} from 《{lit.title}》. Caption: {img.caption or '(none)'}"
    if not ctx.settings.vision_capable:
        return (
            text
            + "\n(The model's vision capability is OFF — enable 'Model can see images' in settings to let me look at the image itself.)",
            [],
            lit.title,
        )
    if ctx.budget.images_left <= 0:
        return text + "\n(Per-run image budget reached — no more figures this run.)", [], lit.title
    try:
        b64, mime = _load_figure_b64(abs_path(img.path))
    except Exception as e:  # noqa: BLE001
        return text + f"\n(Could not load the image file: {e})", [], lit.title
    ctx.budget.images_left -= 1
    human = HumanMessage(
        content=[
            {"type": "text", "text": text},
            {"type": "image", "source_type": "base64", "mime_type": mime, "data": b64},
        ]
    )
    return text + "\n[image attached — describe and use what you see]", [human], lit.title


def _read_notes_text(ctx: RunContext, literature_id: str) -> str:
    q = ctx.db.query(Memory).filter_by(project_id=ctx.project_id)
    scope = "Project-wide notes"
    lid = (literature_id or "").strip()
    if lid:
        lit, err = _lit_or_error(ctx, lid)
        if err and "Unknown" in err:
            return err
        q = q.filter(Memory.literature_id == lid)
        scope = f"Notes on 《{lit.title}》" if lit else "Notes"
    rows = q.order_by(Memory.created_at.desc()).limit(20).all()
    if not rows:
        return f"{scope}: (none yet)"
    return scope + ":\n" + "\n".join(f"- {r.content}" for r in rows)


def _save_note(ctx: RunContext, note: str, literature_id: str) -> tuple[str, str | None]:
    note = (note or "").strip()[:NOTE_CHAR_CAP]
    if not note:
        return "No note provided.", None
    lid = (literature_id or "").strip() or None
    if lid:
        lit, err = _lit_or_error(ctx, lid)
        if err:
            return err, None
    try:
        ctx.db.add(
            Memory(
                id=new_id(),
                project_id=ctx.project_id,
                literature_id=lid,
                content=note,
                created_at=now_ms(),
            )
        )
        ctx.db.commit()
        scope = " (attached to the paper)" if lid else ""
        return f'Saved to long-term memory{scope}: "{note}"', note
    except Exception:  # noqa: BLE001
        ctx.db.rollback()
        return "Could not save to long-term memory (a storage error occurred). Continue without it.", None


# --- subagent dispatch ----------------------------------------------------------
def _run_subagent(ctx: RunContext, task: str, literature_ids: list, include_document: bool, parent_state) -> tuple[str, list[dict]]:
    """Run a nested agent graph for one delegate_task call.

    Returns (report_text, sub_steps) — the report becomes the tool result and
    the subagent's own steps are surfaced (renumbered) in the parent's stream.
    Never raises: every failure degrades to a message the parent can act on."""
    task = (task or "").strip()[:TASK_CHAR_CAP]
    if not task:
        return "No task given to the subagent.", []
    if ctx.depth + 1 > MAX_AGENT_DEPTH:  # unreachable (tool unbound) — belt & braces
        return "The maximum subagent depth (4 layers) is reached — do this analysis directly.", []
    if ctx.budget.dispatches_left <= 0:
        return "The subagent dispatch budget for this run is exhausted — answer with what you already have.", []
    ctx.budget.dispatches_left -= 1

    lits: list[Literature] = []
    for lid in (literature_ids or [])[:8]:
        lit = ctx.db.get(Literature, (lid or "").strip())
        if lit is not None and lit.project_id == ctx.project_id:
            lits.append(lit)
    sub_depth = ctx.depth + 1
    try:
        notes = (
            load_literature_notes(ctx.db, [lit.id for lit in lits])
            if ctx.memory_enabled
            else []
        )
        prompt = build_subagent_prompt(
            task=task,
            depth=sub_depth,
            max_depth=MAX_AGENT_DEPTH,
            literatures=lits,
            notes=notes,
            memory_enabled=ctx.memory_enabled,
            can_delegate=sub_depth < MAX_AGENT_DEPTH,
            include_document=include_document,
        )
        doc_paragraphs = list(parent_state.get("doc_paragraphs") or []) if include_document else []
        messages = [SystemMessage(content=prompt)]
        if include_document and doc_paragraphs:
            messages.append(
                HumanMessage(content='Current document for context:\n"""' + "\n\n".join(doc_paragraphs) + '\n"""')
            )
        messages.append(HumanMessage(content="Begin. Return your report as the final message."))
        sub_state = {
            "messages": messages,
            "doc_paragraphs": doc_paragraphs,
            "steps": [],
            "terminal": None,
            "read_hits": {"": len(doc_paragraphs)} if doc_paragraphs else {},
        }
        sub_graph = build_graph(replace(ctx, depth=sub_depth))
        result = sub_graph.invoke(sub_state, config={"recursion_limit": SUBAGENT_RECURSION_LIMIT})
        # Surface the subagent's own tool activity in the parent's step stream.
        sub_steps = [{**s, "depth": sub_depth} for s in (result.get("steps") or [])]
        for msg in reversed(result.get("messages") or []):
            if getattr(msg, "type", None) == "ai":
                content = msg.content
                if isinstance(content, list):
                    content = "".join(
                        b.get("text", "") for b in content if isinstance(b, dict)
                    )
                report = (content or "").strip()
                if report:
                    return report[:REPORT_CHAR_CAP], sub_steps
        return "(the subagent finished without a report)", sub_steps
    except GraphRecursionError:
        return "The subagent exhausted its step budget before finishing — retry with a narrower task, or do the lookup directly.", []
    except Exception as e:  # noqa: BLE001 — a child must never crash the parent
        log.exception("subagent failed at depth %s", sub_depth)
        return f"The subagent failed ({type(e).__name__}: {e}) — continue without its report.", []


# --- graph -----------------------------------------------------------------
def build_graph(ctx: RunContext):
    """Compile a fresh StateGraph for this run (cheap), closing over the ctx."""
    bound = build_model(ctx.settings).bind_tools(_tools_for(ctx))

    def agent_node(state):
        return {"messages": [bound.invoke(state["messages"])]}

    def tools_node(state):
        last = state["messages"][-1]
        calls = getattr(last, "tool_calls", None) or []
        new_messages: list = []
        new_steps: list[dict] = []
        read_hits = dict(state.get("read_hits") or {})
        terminal = None
        at = len(state.get("steps") or [])

        for call in calls:
            name = call.get("name")
            args = call.get("args") or {}
            tcid = call.get("id")

            if name in ("read_document", "search_document"):
                query = args.get("query", "") or ""
                kind = "search" if name == "search_document" else "read"
                qkey = query.strip().lower()
                is_full = kind == "read" and not qkey
                key = "" if is_full else qkey
                if key in read_hits:
                    text = "(This is unchanged since your earlier read — refer to that earlier result above rather than re-reading.)"
                    hits = read_hits[key]
                else:
                    text, hits = do_read(state["doc_paragraphs"], query, kind)
                    read_hits[key] = hits
                new_steps.append({"kind": kind, "query": query or None, "hits": hits, "at": at})
                at += 1
                new_messages.append(ToolMessage(content=text, tool_call_id=tcid))

            elif name == "list_literature":
                text = _list_literature_text(ctx)
                new_steps.append({"kind": "literature_list", "at": at})
                at += 1
                new_messages.append(ToolMessage(content=text, tool_call_id=tcid))

            elif name == "search_literature":
                query = (args.get("query") or "").strip()
                lid = (args.get("literature_id") or "").strip() or None
                if lid:
                    _, err = _lit_or_error(ctx, lid)
                    if err:
                        text = err
                        hits = 0
                    else:
                        found = search_chunks(ctx.db, ctx.project_id, query, lid, settings=ctx.settings)
                        text = _format_hits(found)
                        hits = len(found)
                else:
                    found = search_chunks(ctx.db, ctx.project_id, query, None, settings=ctx.settings)
                    text = _format_hits(found)
                    hits = len(found)
                new_steps.append({"kind": "literature_search", "query": query or None, "hits": hits, "at": at})
                at += 1
                new_messages.append(ToolMessage(content=text, tool_call_id=tcid))

            elif name == "read_literature":
                text, title = _read_literature_text(ctx, args.get("literature_id") or "", args.get("section") or "")
                new_steps.append({"kind": "literature_read", "literature": title or None, "at": at})
                at += 1
                new_messages.append(ToolMessage(content=text, tool_call_id=tcid))

            elif name == "read_figure":
                try:
                    seq = int(args.get("image_seq"))
                except (TypeError, ValueError):
                    seq = -1
                text, extra, title = _figure_result(ctx, args.get("literature_id") or "", seq)
                new_steps.append({"kind": "figure", "literature": title or None, "query": f"#{seq}", "at": at})
                at += 1
                new_messages.append(ToolMessage(content=text, tool_call_id=tcid))
                new_messages.extend(extra)

            elif name == "read_notes" and ctx.memory_enabled:
                text = _read_notes_text(ctx, args.get("literature_id") or "")
                new_steps.append({"kind": "notes", "at": at})
                at += 1
                new_messages.append(ToolMessage(content=text, tool_call_id=tcid))

            elif name == "remember" and ctx.memory_enabled:
                text, saved = _save_note(ctx, args.get("note") or "", args.get("literature_id") or "")
                new_steps.append({"kind": "remember", "note": saved, "at": at})
                at += 1
                new_messages.append(ToolMessage(content=text, tool_call_id=tcid))

            elif name == "delegate_task":
                text, sub_steps = _run_subagent(
                    ctx,
                    args.get("task") or "",
                    args.get("literature_ids") or [],
                    bool(args.get("include_document")),
                    state,
                )
                new_steps.append(
                    {"kind": "delegate", "task": (args.get("task") or "")[:120], "depth": ctx.depth + 1, "at": at}
                )
                at += 1
                for s in sub_steps:  # renumber nested steps after the parent's
                    s["at"] = at
                    at += 1
                    new_steps.append(s)
                new_messages.append(ToolMessage(content=text, tool_call_id=tcid))

            elif name == "propose_patch":
                explanation = args.get("explanation") or ""
                edits = []
                for e in args.get("edits") or []:
                    if isinstance(e, dict):
                        edits.append({"search": e.get("search", ""), "replace": e.get("replace", "")})
                    else:  # Pydantic model instance (EditInput-shaped)
                        edits.append({"search": getattr(e, "search", ""), "replace": getattr(e, "replace", "")})
                terminal = {"kind": "patch", "explanation": explanation, "edits": edits}
                new_messages.append(ToolMessage(content="Patch proposed. The user will review it. Stop now.", tool_call_id=tcid))

            elif name == "ask_user":
                terminal = {"kind": "ask", "question": args.get("question") or "", "options": list(args.get("options") or [])}
                new_messages.append(ToolMessage(content="Question asked. Stopping for the user.", tool_call_id=tcid))

            else:
                new_messages.append(ToolMessage(content=f"Unknown tool: {name}", tool_call_id=tcid))

        delta = {"messages": new_messages, "steps": new_steps, "read_hits": read_hits}
        if terminal is not None:
            delta["terminal"] = terminal
        return delta

    def should_continue(state):
        last = state["messages"][-1]
        return "tools" if getattr(last, "tool_calls", None) else END

    def after_tools(state):
        return END if state.get("terminal") else "agent"

    g = StateGraph(AgentState)
    g.add_node("agent", agent_node)
    g.add_node("tools", tools_node)
    g.add_edge(START, "agent")
    g.add_conditional_edges("agent", should_continue, ["tools", END])
    g.add_conditional_edges("tools", after_tools, ["agent", END])
    return g.compile()


# --- SSE bridge ------------------------------------------------------------
async def run_agent_stream(req, s, db):
    """Yield normalized SSE event dicts for one agent run."""
    ctx = RunContext(db=db, settings=s, project_id=req.project_id, memory_enabled=req.memory_enabled, depth=0)
    graph = build_graph(ctx)
    inputs = _seed_state(req, ctx)
    config = {"recursion_limit": RECURSION_LIMIT}
    try:
        async for chunk in graph.astream(
            inputs, config=config, stream_mode=["messages", "updates"], version="v2"
        ):
            ctype = chunk.get("type")
            if ctype == "messages":
                msg, meta = (chunk.get("data") or (None, None))
                if msg is None:
                    continue
                # Only stream the main model's own output (node 'agent'); skip
                # ToolMessages and anything from subgraphs/internal nodes so the
                # read results don't flood the chat bubble.
                if (meta or {}).get("langgraph_node") != "agent":
                    continue
                content = getattr(msg, "content", "")
                if isinstance(content, str) and content:
                    yield {"type": "text", "delta": content}
                elif isinstance(content, list):
                    text = "".join(
                        b.get("text", "")
                        for b in content
                        if isinstance(b, dict) and b.get("type") in (None, "text")
                    )
                    if text:
                        yield {"type": "text", "delta": text}
                reasoning = getattr(msg, "reasoning_content", None) or getattr(msg, "reasoning", None)
                if reasoning:
                    yield {"type": "thinking", "delta": reasoning}
            elif ctype == "updates":
                tools_delta = (chunk.get("data") or {}).get("tools")
                if not tools_delta:
                    continue
                for step in tools_delta.get("steps") or []:
                    yield {"type": "step", "step": step}
                term = tools_delta.get("terminal")
                if term:
                    if term.get("kind") == "patch":
                        yield {
                            "type": "patch",
                            "explanation": term.get("explanation", ""),
                            "edits": term.get("edits", []),
                        }
                    elif term.get("kind") == "ask":
                        yield {
                            "type": "ask",
                            "question": term.get("question", ""),
                            "options": term.get("options", []),
                        }
        yield {"type": "done"}
    except Exception as e:  # noqa: BLE001 — never let the generator die silently
        yield {"type": "error", "message": str(e)}
