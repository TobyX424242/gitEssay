"""gitEssay backend — LangGraph agent tools (native function-calling).

The @tool definitions expose the SCHEMA + DESCRIPTION to the model via
model.bind_tools(...). Execution is NOT done by invoking these functions directly
— the custom tools node in agent_graph.py intercepts each tool_call and runs the
real logic with full graph-state access (the doc snapshot, the read de-dupe map,
the DB session for `remember`, and the terminal flag for propose_patch/ask_user).
The function bodies raise to make accidental direct invocation obvious.

`do_read` / `_filter_paragraphs` / `_cap` are ports of the frontend's former
read/search helpers so the backend returns the same-shaped results.
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
def remember(note: str, literature_id: str = "") -> str:
    """Save a DURABLE note to long-term memory — a stable preference,
    convention, decision, or fact worth recalling next time. With a
    `literature_id` (from list_literature) the note is attached to that paper —
    use this for per-paper reading notes (key claims, methods, weaknesses,
    quotable passages with page hints). Without it, the note is project-wide.
    Use sparingly; never for transient task state or the current edit."""
    raise NotImplementedError("executed via the tools node in agent_graph.py")


@tool
def read_notes(literature_id: str = "") -> str:
    """Read your saved long-term notes: all project-wide notes, or — with a
    `literature_id` — the notes you previously saved about that paper. Check
    before re-analyzing a paper you may have already worked on."""
    raise NotImplementedError("executed via the tools node in agent_graph.py")


@tool
def list_literature() -> str:
    """List the reference literature uploaded to this project: id, title, page
    and figure counts. Use the ids with search_literature / read_literature /
    read_figure / remember."""
    raise NotImplementedError("executed via the tools node in agent_graph.py")


@tool
def search_literature(query: str, literature_id: str = "") -> str:
    """Search the project's reference literature with hybrid keyword+semantic
    retrieval. Returns the most relevant passages, each labeled [title §
    section]. Scope to one paper with `literature_id`, or omit it to search
    across the whole library. Use this to find evidence, definitions, results,
    and citable claims in the references."""
    raise NotImplementedError("executed via the tools node in agent_graph.py")


@tool
def read_literature(literature_id: str, section: str = "") -> str:
    """Read one literature item. With no `section`, returns the document opening
    PLUS its full section outline; then call again with a `section` substring
    from that outline (e.g. \"Methods\", \"3.2\") to read a specific part.
    Long papers are never returned whole — navigate with the outline."""
    raise NotImplementedError("executed via the tools node in agent_graph.py")


@tool
def read_figure(literature_id: str, image_seq: int) -> str:
    """Look at figure/table image #image_seq from a literature item (see
    list_literature for figure counts). When the model's vision capability is
    enabled in settings, the image itself is attached for you to see; otherwise
    you get its caption and surrounding context only."""
    raise NotImplementedError("executed via the tools node in agent_graph.py")


@tool
def delegate_task(task: str, literature_ids: list[str] = [], include_document: bool = False) -> str:
    """Dispatch a subagent to work autonomously on an analysis sub-task and
    report back. Use for work that needs several lookup rounds and would
    clutter this conversation: summarizing a paper, comparing methods across
    papers, extracting all results on a topic. `task` is a self-contained
    briefing (the subagent does NOT see this conversation); `literature_ids`
    scopes it to specific papers; `include_document` gives it the user's
    current document text. The subagent can read/search literature and take
    notes, but cannot edit the document or talk to the user. Its final report
    is returned to you as this tool's result. Do NOT delegate trivial one-off
    lookups you can do with a single search."""
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
    Each entry in `edits` is EITHER a text edit OR an equation edit — never both:
    - TEXT edit: {"search": str, "replace": str}. `search` is the
      SHORTEST span that is unique in the document — usually a single sentence or
      phrase (shorter matches more reliably than long) — copied CHARACTER-FOR-
      CHARACTER from within ONE paragraph (never across paragraphs): reproduce every
      space, punctuation mark, and quotation mark exactly as written, including any
      curly/straight quotes and dashes. Do NOT reflow, reformat, re-punctuate, or
      "fix" the passage. `replace` is the new text.
    - EQUATION edit: {"equation": str, "latex": str} — replaces the LaTeX
      source of the equation whose [[EQ:nonce]] token equals `equation`. Use this
      ONLY to change an equation's content; `latex` is the COMPLETE new LaTeX and
      MUST parse under KaTeX (check braces, \\commands, environments). Never put
      LaTeX source into a text edit's search/replace.
    - APPEND edit: {"append": str} — appends the text to the END of the document
      as new paragraph(s) (separate paragraphs with blank lines). Use this to ADD
      brand-new content (a new section, conclusion, paragraph). The appended text
      is plain prose: it must NOT contain [[CITE:…]] or [[EQ:…]] tokens. It MAY
      contain NEW display equations: put the LaTeX between lines containing only
      $$ (a $$ fence line before and after the LaTeX); each becomes a real
      equation block and MUST parse under KaTeX.
    You may emit several edits in one call. Citations and equations appear in the
    document as OPAQUE TOKENS like [[CITE:1a2b3c4d]] and [[EQ:9e8f7a6b]] — treat
    each token as a single indivisible unit: copy it VERBATIM into search and
    replace; never modify, split, merge, or invent one. To KEEP a token, copy it
    unchanged into replace; to REMOVE it, omit the token from replace. The raw
    LaTeX behind each [[EQ:nonce]] is listed with the document; read it from
    there instead of guessing. Do NOT wrap anything in markdown code fences."""
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
