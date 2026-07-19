"""gitEssay backend — LangGraph agent graph + SSE bridge.

A hand-rolled ReAct StateGraph (agent node calls model.bind_tools -> tools node
executes -> route). Tools that produce reviewable output (propose_patch /
ask_user) are TERMINAL: the tools node sets state.terminal and the after_tools
edge routes to END, preserving the current one-patch-per-turn / ask-then-new-turn
UX. No checkpointer in Phase 1 (no HITL interrupts), so the graph is built and
run statelessly per request — which also lets the tools node close over the DB
session, project id, and memory flag for `remember`.

run_agent_stream() drives graph.astream(stream_mode=['messages','updates'],
version='v2') and yields the normalized SSE events the frontend consumes:
text / thinking / step / patch / ask / done / error.
"""
from langchain.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langgraph.graph import END, START, StateGraph

from app.agent_prompt import build_system_prompt, load_memories
from app.agent_state import AgentState
from app.agent_tools import (
    ask_user as ask_user_tool,
    do_read,
    propose_patch as propose_patch_tool,
    read_document as read_document_tool,
    remember as remember_tool,
    search_document as search_document_tool,
)
from app.llm import build_model
from app.models import Memory, new_id, now_ms

RECURSION_LIMIT = 18  # ~9 model calls (agent+tools = 2 steps each); bounds runaway loops


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


def _seed_state(req, s, db) -> dict:
    paragraphs = list(req.doc_paragraphs)
    memories = load_memories(db, req.project_id) if req.memory_enabled else []
    system_prompt = build_system_prompt(req.memory_enabled, memories)
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


def _tools_for(memory_enabled: bool) -> list:
    tools = [read_document_tool, search_document_tool, propose_patch_tool, ask_user_tool]
    if memory_enabled:
        tools.append(remember_tool)
    return tools


# --- graph -----------------------------------------------------------------
def build_graph(s, req, db):
    """Compile a fresh StateGraph for this run (cheap), closing over DB/project/memory."""
    bound = build_model(s).bind_tools(_tools_for(req.memory_enabled))
    project_id = req.project_id
    memory_enabled = req.memory_enabled

    def agent_node(state):
        return {"messages": [bound.invoke(state["messages"])]}

    def tools_node(state):
        last = state["messages"][-1]
        calls = getattr(last, "tool_calls", None) or []
        new_messages: list[ToolMessage] = []
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

            elif name == "remember" and memory_enabled:
                note = (args.get("note") or "").strip()
                if note and project_id:
                    try:
                        db.add(Memory(id=new_id(), project_id=project_id, content=note, created_at=now_ms()))
                        db.commit()
                        text = f'Saved to long-term memory: "{note}"'
                    except Exception:
                        db.rollback()
                        text = "Could not save to long-term memory (a storage error occurred). Continue without it."
                else:
                    text = "No note provided."
                new_steps.append({"kind": "remember", "note": note or None, "at": at})
                at += 1
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
    graph = build_graph(s, req, db)
    inputs = _seed_state(req, s, db)
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
