"""gitEssay backend — LangGraph agent tools (native function-calling).

The @tool definitions expose the SCHEMA + DESCRIPTION to the model via
model.bind_tools(...). Execution is NOT done by invoking these functions directly
— the custom tools node in agent_graph.py intercepts each tool_call and runs the
real logic with full graph-state access (the doc snapshot, the read de-dupe map,
the DB session for `remember`, and the terminal flag for propose_patch/ask_user).
The function bodies raise to make accidental direct invocation obvious.

`do_read` / `_filter_paragraphs` / `_cap` are ports of the frontend frameRead
helpers (src/chat/providers.ts) so the backend returns the same-shaped results.
"""
from langchain.tools import tool

READ_CHAR_CAP = 24000
SEARCH_MATCH_CAP = 12


@tool
def read_document(query: str = "") -> str:
    """Re-read the document. With no query, returns the full document. With a
    query, returns only paragraphs containing the query (case-insensitive). Use
    this when you need to locate or verify text before editing, or when you are
    unsure where text lives."""
    raise NotImplementedError("executed via the tools node in agent_graph.py")


@tool
def search_document(query: str) -> str:
    """Find paragraphs containing the query (case-insensitive). Use to locate
    text before editing."""
    raise NotImplementedError("executed via the tools node in agent_graph.py")


@tool
def remember(note: str) -> str:
    """Save a DURABLE note about this project to long-term memory — a stable
    preference, convention, decision, or fact the user would want you to recall
    next time. Use sparingly; never for transient task state or the current edit."""
    raise NotImplementedError("executed via the tools node in agent_graph.py")


@tool
def propose_patch(explanation: str, edits: list[dict]) -> str:
    """Propose document edits for the user to review before they apply.
    `explanation` is REQUIRED and becomes the version label for this edit: a
    single short imperative line (~6–10 words, ≤ ~80 chars) that names the
    SPECIFIC subject of the change, not just the action, so it is distinguishable
    from similar edits. Prefer "Clarify the data-collection steps" over "Clarify";
    "Soften the causality claim" over "Rephrase"; "Fix tense in the methods
    paragraph" over "Edit". Keep it a label, not a full sentence.
    `edits` is a list of {"search": str, "replace": str} pairs. `search` is the
    SHORTEST span that is unique in the document — usually a single sentence or
    phrase (shorter matches more reliably than long) — copied CHARACTER-FOR-
    CHARACTER from within ONE paragraph (never across paragraphs): reproduce every
    space, punctuation mark, and quotation mark exactly as written, including any
    curly/straight quotes and dashes. Do NOT reflow, reformat, re-punctuate, or
    "fix" the passage. `replace` is the new text. You may emit several edits in
    one call. Citations and equations appear in the document as OPAQUE TOKENS like
    [[CITE:1a2b3c4d]] and [[EQ:9e8f7a6b]] — treat each token as a single
    indivisible unit: copy it VERBATIM into search and replace; never modify,
    split, merge, or invent one. To KEEP a token, copy it unchanged into replace;
    to REMOVE it, omit the token from replace. Do NOT wrap anything in markdown
    code fences."""
    raise NotImplementedError("executed via the tools node in agent_graph.py")


@tool
def ask_user(question: str, options: list[str]) -> str:
    """Ask the user a clarifying question with concrete options. The UI always
    appends a free-text choice, so do NOT add an "Other" option yourself. Use
    this whenever the request is ambiguous and the answer changes what you do."""
    raise NotImplementedError("executed via the tools node in agent_graph.py")


# --- read/search helpers (executed by the tools node) ----------------------
def _cap(text: str, limit: int = READ_CHAR_CAP) -> str:
    if len(text) <= limit:
        return text
    return f"{text[:limit]}\n\n[…truncated, {len(text) - limit} more chars…]"


def _filter_paragraphs(paragraphs: list[str], query: str) -> list[str]:
    q = (query or "").strip().lower()
    if not q:
        return list(paragraphs)
    return [p for p in paragraphs if q in p.lower()]


def do_read(paragraphs: list[str], query: str, kind: str) -> tuple[str, int]:
    """Port of the frontend frameRead. Returns (result_text, hits).

    A full read (read_document with no query) returns the whole document; any
    query (read_document with a query, or search_document) returns matching
    paragraphs as a numbered list, capped to SEARCH_MATCH_CAP.
    """
    q = (query or "").strip()
    if kind == "search" or q:
        matches = _filter_paragraphs(paragraphs, q)[:SEARCH_MATCH_CAP]
        if matches:
            body = "\n\n".join(f"{i + 1}. {p}" for i, p in enumerate(matches))
        else:
            body = "(no paragraphs matched)"
        return _cap(body), len(matches)
    full = "\n\n".join(paragraphs) or "(empty document)"
    return _cap(full), len(paragraphs)
