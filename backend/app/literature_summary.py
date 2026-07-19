"""gitEssay backend — automatic literature summarization (map-reduce subagent).

After a document parses to `ready`, a background thread generates a summary of
it with the configured LLM. This is a bounded, deterministic subagent — NOT the
tool-loop graph: a summarizer must cover the document systematically, which a
free-roaming agent can't be trusted to do, and a book-length input must never
blow the context budget.

Strategy (handles the very-long-document edge case by construction):
  1. SELECT at most MAX_CHUNKS chunks: always the opening (title/abstract) and
     the closing (conclusions), plus an EVEN SAMPLE across the middle — so a
     500-page book and a 10-page paper get the same bounded input.
  2. MAP: group the selection into ~GROUP_CHAR_CAP-sized blocks; one LLM call
     per group → 3-5 extractive bullets (claims, methods, numbers).
  3. REDUCE: one LLM call over title + outline + group bullets → the final
     structured summary (purpose / methods / key results / caveats).

Cost per paper: ≤ ceil(MAX_CHUNKS*avg_chunk/GROUP_CHAR_CAP) + 1 ≈ 5 LLM calls.
Runs on a daemon thread with its own DB session; failures flip summary_status
to 'failed' and never affect the parsed document.
"""
import logging
import threading

from sqlalchemy.orm import Session

from app import ai
from app.db import SessionLocal
from app.literature_search import read_section
from app.models import AISettings, Literature, LiteratureChunk

log = logging.getLogger(__name__)

# Selection budget: ~32 chunks ≈ 45k chars — fits the fit_input truncation
# budget of any reasonable setting, regardless of document length.
MAX_CHUNKS = 32
GROUP_CHAR_CAP = 12_000
_MAP_SYSTEM = (
    "You are summarizing part of an academic document for a research library. "
    "Extract 3-5 concise bullet points: key claims, methods, datasets, and "
    "quantitative results. Be faithful to the text; no commentary."
)
_REDUCE_SYSTEM = (
    "You are writing the library summary of an academic document. From the "
    "title, section outline, and per-part notes, write a structured summary "
    "(≤300 words) with these headings: Purpose; Methods; Key results; "
    "Caveats & limitations; Why it might be cited. Faithful, specific, no fluff."
)


def _select_chunks(chunks: list[LiteratureChunk], max_chunks: int = MAX_CHUNKS) -> list[LiteratureChunk]:
    """Bounded, coverage-preserving selection: head + tail + even middle sample."""
    if len(chunks) <= max_chunks:
        return list(chunks)
    head = chunks[:4]
    tail = chunks[-2:]
    middle = chunks[4:-2]
    budget = max_chunks - len(head) - len(tail)
    step = len(middle) / budget
    sampled = [middle[int(i * step)] for i in range(budget)]
    return head + sampled + tail


def _group_chunks(chunks: list[LiteratureChunk]) -> list[str]:
    """Pack selected chunks into ≤GROUP_CHAR_CAP text blocks (with headings)."""
    groups: list[str] = []
    cur: list[str] = []
    cur_len = 0
    for c in chunks:
        block = f"[{c.heading}]\n{c.text}" if c.heading else c.text
        if cur and cur_len + len(block) > GROUP_CHAR_CAP:
            groups.append("\n\n".join(cur))
            cur, cur_len = [], 0
        cur.append(block)
        cur_len += len(block)
    if cur:
        groups.append("\n\n".join(cur))
    return groups


def generate_summary(db: Session, literature_id: str) -> None:
    """Generate and store the summary for one READY literature row. Raises on
    LLM failure (the caller flips summary_status)."""
    lit = db.get(Literature, literature_id)
    if lit is None or lit.status != "ready":
        return
    chunks = (
        db.query(LiteratureChunk)
        .filter_by(literature_id=literature_id)
        .order_by(LiteratureChunk.seq)
        .all()
    )
    if not chunks:
        raise RuntimeError("no text was extracted from this document")
    settings = db.get(AISettings, 1)

    groups = _group_chunks(_select_chunks(chunks))
    notes: list[str] = []
    for i, group in enumerate(groups):
        notes.append(
            ai.call_model(settings, _MAP_SYSTEM, f"Part {i + 1} of {len(groups)}:\n\n{group}")
        )
    outline, _ = read_section(db, literature_id)
    reduce_input = "\n".join(
        [
            f"Title: {lit.title}",
            "",
            "Section outline:",
            "\n".join(f"- {h}" for h in outline) or "(none detected)",
            "",
            "Per-part notes:",
            "\n\n".join(notes),
        ]
    )
    lit.summary = ai.call_model(settings, _REDUCE_SYSTEM, reduce_input).strip()
    lit.summary_status = "ready"
    db.commit()


def ai_configured(db: Session) -> bool:
    s = db.get(AISettings, 1)
    return bool(s and s.base_url and s.api_key and s.model)


def start_summary(literature_id: str) -> None:
    """Kick off background summarization (no-op thread spawn; status transitions
    are visible via the literature endpoints). Skipped when AI is unconfigured."""
    db = SessionLocal()
    try:
        lit = db.get(Literature, literature_id)
        if lit is None or lit.status != "ready":
            return
        if not ai_configured(db):
            lit.summary_status = "skipped"
            db.commit()
            return
        lit.summary_status = "generating"
        db.commit()
    finally:
        db.close()
    threading.Thread(target=_summary_safe, args=(literature_id,), daemon=True).start()


def _summary_safe(literature_id: str) -> None:
    db = SessionLocal()
    try:
        generate_summary(db, literature_id)
    except Exception as e:  # noqa: BLE001 — the summary must never hurt the doc
        log.exception("summary generation failed: %s", literature_id)
        try:
            lit = db.get(Literature, literature_id)
            if lit is not None:
                lit.summary_status = "failed"
                db.commit()
        except Exception:  # noqa: BLE001
            db.rollback()
    finally:
        db.close()
