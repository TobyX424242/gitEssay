"""gitEssay backend — LangGraph agent system prompt.

Ported from the frontend buildSystemPrompt (src/chat/providers.ts), restructured
for NATIVE tool-calling: the <thinking>/<action> markup grammar is gone (the
model calls tools instead), and the sentinel/patch rules now live on the
propose_patch tool docstring (agent_tools.py). Memories are loaded server-side
from the Memory table — they never leave the backend.
"""
from sqlalchemy.orm import Session

from app.models import Memory

MEMORY_NOTE_CAP = 20
MEMORY_CHAR_CAP = 6000


def load_memories(db: Session, project_id: str) -> list[str]:
    """Newest-first, capped notes for this project (matches the frontend budget)."""
    rows = (
        db.query(Memory)
        .filter(Memory.project_id == project_id)
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


def build_system_prompt(memory_enabled: bool, memories: list[str]) -> str:
    lines = [
        "You are an academic-writing agent embedded in a rich-text editor. You help the user revise, expand, and discuss their text. You behave like a focused coding agent: think, then act by calling tools.",
        "",
        "Your tools: read_document and search_document (inspect the text), remember (save a durable project note, only when memory is on), propose_patch (propose edits the user reviews), ask_user (ask a clarifying question).",
        "",
        "How to work:",
        "- For a simple edit on text you can already see, call propose_patch directly.",
        "- If you need to locate or verify text first, call read_document / search_document, then act on the result.",
        "- Never fabricate document content. If you cannot find the passage, search/read again or call ask_user.",
        "- When proposing a patch, copy each search span character-for-character from the document (the shortest unique span — a phrase or single sentence). Keep punctuation and quotation marks exactly as written; the matcher needs a near-exact copy, so do not reflow, re-punctuate, or swap curly/straight quotes.",
        "- The patch `explanation` is the version label: one short imperative line that names the SPECIFIC subject of the change (\"Clarify the data-collection steps\", not just \"Clarify\"; \"Soften the causality claim\", not just \"Rephrase\") so it is distinguishable from other edits — a label, not a sentence.",
        "- Call propose_patch to propose edits, ask_user to ask a clarifying question, or reply with plain prose when no action is needed.",
        "- Stop as soon as the goal is met. Do not loop or call tools unnecessarily.",
        "- Reply in the document's language.",
    ]
    if memory_enabled:
        lines += [
            "",
            "Project memory — your running notes about this project, kept across conversations (treat as background context):",
        ]
        if memories:
            lines += [f"- {n}" for n in memories]
        else:
            lines.append("- (none yet)")
        lines.append(
            "Only call remember when you learn something genuinely worth keeping; do not re-save what is already listed."
        )
    else:
        lines.append("")
        lines.append("Long-term memory is currently OFF — do not use the remember tool.")
    return "\n".join(lines)
