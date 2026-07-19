"""gitEssay backend — LangGraph agent system prompt.

Ported from the frontend buildSystemPrompt (src/chat/providers.ts), restructured
for NATIVE tool-calling: the <thinking>/<action> markup grammar is gone (the
model calls tools instead), and the sentinel/patch rules now live on the
propose_patch tool docstring (agent_tools.py). Memories are loaded server-side
from the Memory table — they never leave the backend.

Two prompt families:
- build_system_prompt: the main (depth-0) agent, with project memories and the
  ready-literature index injected.
- build_subagent_prompt: analysis subagents (depth 1..3) — no user, no document
  edits, scoped literature + its notes, a report as the final message.
"""
from sqlalchemy.orm import Session

from app.models import Literature, Memory

MEMORY_NOTE_CAP = 20
MEMORY_CHAR_CAP = 6000
# Per-literature notes injected into a subagent scoped to that paper.
LIT_NOTE_CAP = 10
# Compact literature index in the main prompt.
LIT_INDEX_CAP = 20
_LIT_TITLE_CAP = 80


def load_memories(db: Session, project_id: str) -> list[str]:
    """Newest-first, capped PROJECT-WIDE notes (literature-scoped notes are read
    on demand via read_notes / injected into subagents, not the main prompt)."""
    rows = (
        db.query(Memory)
        .filter(Memory.project_id == project_id, Memory.literature_id.is_(None))
        .order_by(Memory.created_at.desc())
        .all()
    )
    notes: list[str] = []
    budget = MEMORY_CHAR_CAP
    for r in rows:
        c = (r.content or "").strip()
        if not c or len(notes) >= MEMORY_NOTE_CAP or budget <= 0:
            break
        notes.append(c)
        budget -= len(c)
    return notes


def load_literature_notes(db: Session, literature_ids: list[str]) -> list[tuple[str, str]]:
    """(literature title, note) pairs for the given papers, newest first."""
    if not literature_ids:
        return []
    rows = (
        db.query(Memory, Literature.title)
        .join(Literature, Literature.id == Memory.literature_id)
        .filter(Memory.literature_id.in_(literature_ids))
        .order_by(Memory.created_at.desc())
        .limit(LIT_NOTE_CAP)
        .all()
    )
    return [(title, m.content.strip()) for m, title in rows if m.content.strip()]


def _literature_index_lines(literatures: list[Literature]) -> list[str]:
    if not literatures:
        return []
    lines = [
        "",
        "Reference literature in this project (search/read/cite these; figures via read_figure):",
    ]
    for lit in literatures[:LIT_INDEX_CAP]:
        title = (lit.title or lit.filename)[:_LIT_TITLE_CAP]
        lines.append(f"- id={lit.id} | {title} | {lit.page_count}p, {lit.image_count} figures")
    if len(literatures) > LIT_INDEX_CAP:
        lines.append(f"- …and {len(literatures) - LIT_INDEX_CAP} more (call list_literature)")
    return lines


def build_system_prompt(
    memory_enabled: bool, memories: list[str], literatures: list[Literature] | None = None
) -> str:
    lines = [
        "You are an academic-writing agent embedded in a rich-text editor. You help the user revise, expand, and discuss their text. You behave like a focused coding agent: think, then act by calling tools.",
        "",
        "Your tools: read_document and search_document (inspect the user's text), list_literature / search_literature / read_literature / read_figure (the project's uploaded reference papers), read_notes and remember (long-term memory, only when memory is on), delegate_task (dispatch a subagent for multi-step analysis), propose_patch (propose edits the user reviews), ask_user (ask a clarifying question).",
        "",
        "How to work:",
        "- For a simple edit on text you can already see, call propose_patch directly.",
        "- If you need to locate or verify text first, call read_document / search_document, then act on the result.",
        "- Never fabricate document content. If you cannot find the passage, search/read again or call ask_user.",
        "- Ground claims about the literature in the actual papers: search_literature first, then read_literature for context, and cite sources by their title (e.g. “(see: <title>)”). Never invent a reference.",
        "- delegate_task is for multi-round analysis (summarize a paper, compare across papers); do trivial lookups yourself with one search.",
        "- When proposing a patch, copy each search span character-for-character from the document (the shortest unique span — a phrase or single sentence). Keep punctuation and quotation marks exactly as written; the matcher needs a near-exact copy, so do not reflow, re-punctuate, or swap curly/straight quotes.",
        "- The patch `explanation` is the version label: one short imperative line that names the SPECIFIC subject of the change (\"Clarify the data-collection steps\", not just \"Clarify\"; \"Soften the causality claim\", not just \"Rephrase\") so it is distinguishable from other edits — a label, not a sentence.",
        "- Call propose_patch to propose edits, ask_user to ask a clarifying question, or reply with plain prose when no action is needed.",
        "- Stop as soon as the goal is met. Do not loop or call tools unnecessarily.",
        "- Reply in the document's language.",
    ]
    lines += _literature_index_lines(literatures or [])
    if memory_enabled:
        lines += [
            "",
            "Project memory — your running notes about this project, kept across conversations (treat as background context; per-paper notes are read via read_notes):",
        ]
        if memories:
            lines += [f"- {n}" for n in memories]
        else:
            lines.append("- (none yet)")
        lines.append(
            "Only call remember when you learn something genuinely worth keeping; do not re-save what is already listed. Attach a literature_id for paper-specific notes."
        )
    else:
        lines.append("")
        lines.append("Long-term memory is currently OFF — do not use the remember or read_notes tools.")
    return "\n".join(lines)


def build_subagent_prompt(
    task: str,
    depth: int,
    max_depth: int,
    literatures: list[Literature],
    notes: list[tuple[str, str]],
    memory_enabled: bool,
    can_delegate: bool,
    include_document: bool,
) -> str:
    """System prompt for an analysis subagent. It cannot reach the user or edit
    the document — its final message IS the report to the parent agent."""
    lines = [
        f"You are an analysis subagent (layer {depth + 1} of {max_depth + 1}) inside an academic-writing assistant. A parent agent gave you a self-contained task.",
        "",
        "Constraints:",
        "- You CANNOT interact with the user or edit the document — no propose_patch, no ask_user.",
        "- Work autonomously with the literature tools (list/search/read_literature/read_figure), then write ONE final structured report as your last message: concise bullet points, every claim cited by source title.",
        "- Stop as soon as the task is answered; do not re-read what you already have.",
    ]
    if can_delegate:
        lines.append(
            "- You may dispatch your own sub-subagents (delegate_task) for independent sub-questions — sparingly, only where parallel depth helps."
        )
    if memory_enabled:
        lines.append(
            "- You may save durable findings with remember (attach the literature_id for paper-specific notes) and read prior notes with read_notes."
        )
    if include_document:
        lines.append("- The user's current document follows the task briefing, for context.")
    lines += _literature_index_lines(literatures)
    if notes:
        lines += ["", "Your prior notes on these papers:"]
        lines += [f"- [{title}] {note}" for title, note in notes]
    lines += ["", f"Task briefing: {task}"]
    return "\n".join(lines)
