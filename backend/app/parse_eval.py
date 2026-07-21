"""gitEssay backend — parse-quality evaluation (the fast/OCR tier arbiter).

After the fast edgeparse pass (pdf_fast.py), a bounded "auditor subagent"
judges whether the extraction is trustworthy enough to keep, or must be
re-parsed with the heavy OCR-capable docling pipeline. The same evaluation
runs once more after an OCR fallback — its verdict then only sets the
user-facing confidence, never triggers another fallback.

Two stages:
  1. HEURISTICS (free, no LLM): text density and garbled-character ratio.
     Catches the common hard failure — a scanned/image-only PDF fed to a
     non-OCR extractor — without spending an LLM call.
  2. LLM AUDIT (one bounded call via ai.call_model): a head+middle+tail
     sample of chunks is judged for mojibake, column interleaving, shattered
     words, missing body text, and destroyed tables.

Failure policy: if the audit itself is unavailable (AI not configured is NOT
a failure — heuristics decide; but an LLM error or unparseable reply IS), the
fast result is kept with confidence `partial` — we never pay the OCR cost
because of evaluation-infrastructure trouble.
"""
import json
import logging
import re
from dataclasses import dataclass

from sqlalchemy.orm import Session

from app import ai
from app.literature_ingest import ExtractedChunk
from app.literature_summary import ai_configured
from app.models import AISettings

log = logging.getLogger(__name__)

VERDICTS = ("reliable", "partial", "unreliable")

# Heuristic thresholds: below ~80 chars/page a "PDF" is almost certainly a
# scan; above 1% replacement/control characters the font mapping is broken.
_MIN_CHARS_PER_PAGE = 80
_MAX_GARBAGE_RATIO = 0.01

# LLM audit sampling budget: 8 chunks ≈ ≤8k chars — one small call per document.
_SAMPLE_HEAD = 2
_SAMPLE_TAIL = 2
_SAMPLE_MIDDLE = 4
_SAMPLE_CHAR_CAP = 8_000

_SYSTEM = (
    "You are a strict quality auditor for machine-extracted PDF text. You judge "
    "ONLY extraction fidelity — never the content's quality, style, or truthfulness. "
    "You always answer with exactly one JSON object on a single line: no markdown "
    "fences, no commentary, no preamble."
)

_USER_TEMPLATE = """The following numbered samples were extracted from a born-digital PDF ("{filename}") by a fast, non-OCR text extractor. They cover the beginning, middle, and end of the document.

Check ONLY for these extraction defects:
1. Mojibake / wrong character mapping: "(cid:123)" sequences, U+FFFD replacement chars, substituted glyphs, exploded accents.
2. Reading-order corruption: multi-column text interleaved line-by-line, unrelated fragments injected mid-sentence, headers/footers/captions spliced into body prose.
3. Shattered words: spaces inside words, one character per line, broken ligatures.
4. Missing body text: only headers, footers, page numbers, or scattered fragments — the classic symptom of a SCANNED page fed to a non-OCR extractor.
5. Tables destroyed into meaningless token streams that corrupt the surrounding prose.

Important calibrations:
- Legitimate sparse text (formulas, bullet lists, figure captions, references) is NOT a defect by itself.
- Mild imperfections that leave the bulk of the text trustworthy are "partial", not "unreliable".
- Reserve "unreliable" for severe damage (garbled text, interleaved columns, shattered words, missing body) that requires re-parsing with an OCR-capable engine.

Verdicts:
- "reliable": no significant defects; the text is coherent and complete.
- "partial": minor localized flaws (e.g. one broken table, occasional odd lines) but the document is usable.
- "unreliable": severe damage; must be re-parsed with OCR.

Samples:
{samples}

Answer with exactly one JSON object on a single line (no fences, no extra text). The "reason" is shown to the document's owner next to a confidence label: write 1-2 short sentences, at most 300 characters, in the dominant language of the document, naming the concrete defects you found (or stating that the text looks clean):
{{"verdict": "reliable" | "partial" | "unreliable", "reason": "..."}}"""


@dataclass
class EvalResult:
    verdict: str  # reliable | partial | unreliable
    note: str


def heuristic_failure(chunks: list[ExtractedChunk], page_count: int) -> str | None:
    """Cheap hard-failure checks. Returns a reason string when the extraction
    is clearly unusable, else None."""
    text = "".join(c.text for c in chunks)
    if not text.strip():
        return "no extractable text (likely a scanned/image-only PDF)"
    if page_count and len(text) / page_count < _MIN_CHARS_PER_PAGE:
        return (
            f"very low text density ({len(text) // page_count} chars/page) "
            "— likely a scanned document"
        )
    garbage = sum(
        1 for ch in text if ch == "\ufffd" or (ord(ch) < 32 and ch not in "\n\t\r")
    )
    if garbage / len(text) > _MAX_GARBAGE_RATIO:
        return f"high garbled-character ratio ({garbage}/{len(text)})"
    return None


def _sample_chunks(chunks: list[ExtractedChunk]) -> list[ExtractedChunk]:
    """Head + tail + even middle sample, bounded by _SAMPLE_CHAR_CAP."""
    n = _SAMPLE_HEAD + _SAMPLE_MIDDLE + _SAMPLE_TAIL
    if len(chunks) <= n:
        selected = list(chunks)
    else:
        head = chunks[:_SAMPLE_HEAD]
        tail = chunks[-_SAMPLE_TAIL:]
        middle = chunks[_SAMPLE_HEAD:-_SAMPLE_TAIL]
        step = len(middle) / _SAMPLE_MIDDLE
        selected = head + [middle[int(i * step)] for i in range(_SAMPLE_MIDDLE)] + tail
    out: list[ExtractedChunk] = []
    total = 0
    per_chunk_cap = max(500, _SAMPLE_CHAR_CAP // max(len(selected), 1))
    for c in selected:
        text = c.text[:per_chunk_cap]
        if total + len(text) > _SAMPLE_CHAR_CAP:
            text = text[: max(0, _SAMPLE_CHAR_CAP - total)]
        if not text:
            break
        out.append(ExtractedChunk(heading=c.heading, text=text))
        total += len(text)
    return out


def _parse_verdict(raw: str) -> EvalResult:
    """Extract the first {...} JSON object from the model reply and validate
    the verdict. Raises ValueError on any deviation."""
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        raise ValueError("no JSON object in reply")
    data = json.loads(raw[start : end + 1])
    verdict = str(data.get("verdict", "")).strip().lower()
    if verdict not in VERDICTS:
        raise ValueError(f"invalid verdict: {verdict!r}")
    reason = str(data.get("reason", "")).strip()[:300]
    return EvalResult(verdict=verdict, note=reason)


def evaluate_parse(
    db: Session, chunks: list[ExtractedChunk], page_count: int, filename: str = ""
) -> EvalResult:
    """Judge one extraction. Never raises: infrastructure failure degrades to
    `partial` (keep the result), heuristic hard-failure returns `unreliable`."""
    reason = heuristic_failure(chunks, page_count)
    if reason is not None:
        log.info("parse evaluation: unreliable (heuristic): %s", reason)
        return EvalResult("unreliable", reason)
    if not ai_configured(db):
        return EvalResult("reliable", "heuristic checks passed (AI evaluation not configured)")
    samples = "\n\n".join(
        f"--- sample {i + 1} ---\n{c.text}" for i, c in enumerate(_sample_chunks(chunks))
    )
    try:
        settings = db.get(AISettings, 1)
        raw = ai.call_model(
            settings, _SYSTEM, _USER_TEMPLATE.format(filename=filename, samples=samples)
        )
        result = _parse_verdict(raw)
        log.info("parse evaluation: %s — %s", result.verdict, result.note)
        return result
    except Exception as e:  # noqa: BLE001 — audit trouble must not cost an OCR run
        log.exception("parse evaluation unavailable; keeping result as partial")
        return EvalResult("partial", f"evaluation unavailable ({type(e).__name__})")
