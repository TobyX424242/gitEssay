"""gitEssay backend — literature ingestion: PDF/DOCX → chunks + images.

Upload flow: the router saves the original file and a `processing` row, then
`start_ingest` parses it on a daemon thread. PDFs go through a TWO-TIER parse:
edgeparse first (pdf_fast.py — Rust, no OCR, milliseconds), audited by the
parse evaluator (parse_eval.py); only when the audit judges the result
unreliable does the heavy docling+RapidOCR pipeline run as fallback (and is
audited once more, for the confidence label only). DOCX still goes straight
to docling. On success the row becomes `ready` with denormalized counts; on
failure `error` with the exception message.

`_extract()` is the testable seam — tests monkeypatch it so the suite never
needs docling's models. A real-docling smoke test lives behind GE_TEST_DOCLING=1.
"""
import glob
import json
import logging
import os
import shutil
import threading
from dataclasses import dataclass, field

from sqlalchemy.orm import Session

from app.db import SessionLocal
from app.literature_search import embed_texts, fts_enabled, index_chunk_fts
from app.literature_summary import start_summary
from app.models import AISettings, Literature, LiteratureChunk, LiteratureImage, new_id
from app.storage import abs_path, literature_dir, literature_rel_path

log = logging.getLogger(__name__)

ALLOWED_EXTENSIONS = {".pdf", ".docx"}
MAX_UPLOAD_BYTES = 50 * 1024 * 1024  # 50 MB

# Chunk refinement (post-HierarchicalChunker): merge tiny fragments, split
# oversized ones at paragraph boundaries. Character-based — no HF tokenizer.
_CHUNK_TARGET = 1400
_CHUNK_SPLIT_AT = 2400
_CHUNK_MERGE_BELOW = 300

_converter = None
_converter_lock = threading.Lock()  # serializes lazy init AND convert (torch)


@dataclass
class ExtractedChunk:
    heading: str
    text: str


@dataclass
class ExtractedImage:
    caption: str
    pil_image: object  # PIL.Image; saved to disk by ingest()


@dataclass
class ExtractedDoc:
    title: str
    page_count: int
    chunks: list[ExtractedChunk] = field(default_factory=list)
    images: list[ExtractedImage] = field(default_factory=list)


# Pages per conversion segment: PDFs convert in page segments so the caller
# gets REAL progress (segment k of N done). Models load once per process, so
# the overhead over a single-shot convert is ~30% — the price of a progress bar.
_SEGMENT_PAGES = 10


def _page_count(path: str) -> int | None:
    """Total PDF pages (cheap, no models). None for DOCX / unreadable files."""
    try:
        import pypdfium2 as pdfium

        pdf = pdfium.PdfDocument(path)
        n = len(pdf)
        pdf.close()
        return n
    except Exception:  # noqa: BLE001 — not a PDF (e.g. DOCX) or unreadable
        return None


# --- docling conversion (the seam) ------------------------------------------
def _get_converter():
    global _converter
    with _converter_lock:
        if _converter is None:
            from docling.datamodel.base_models import InputFormat
            from docling.datamodel.pipeline_options import PdfPipelineOptions, RapidOcrOptions
            from docling.document_converter import DocumentConverter, PdfFormatOption

            pdf_opts = PdfPipelineOptions()
            # The default onnxruntime backend is not installed (docling-slim
            # doesn't pull it), so scanned pages would fail OCR at runtime.
            # The torch backend reuses the already-bundled torch + .pth models.
            pdf_opts.ocr_options = RapidOcrOptions(backend="torch")
            pdf_opts.generate_picture_images = True  # extract figure images
            pdf_opts.images_scale = 2.0  # ~144 dpi — legible for vision models
            _converter = DocumentConverter(
                format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pdf_opts)}
            )
        return _converter


def _collect(doc, filename: str) -> tuple[str, list, list]:
    """(title, raw chunks, images) from one converted DoclingDocument."""
    from docling.chunking import HierarchicalChunker
    from docling_core.types.doc.labels import DocItemLabel

    title = ""
    for text_item in getattr(doc, "texts", []):
        label = getattr(text_item, "label", None)
        text = (getattr(text_item, "text", "") or "").strip()
        if not text:
            continue
        if label == DocItemLabel.TITLE:
            title = text
            break
        if label == DocItemLabel.SECTION_HEADER and not title:
            title = text  # fallback: first section header

    raw: list[ExtractedChunk] = []
    for ch in HierarchicalChunker().chunk(doc):
        meta = getattr(ch, "meta", None)
        headings = list(getattr(meta, "headings", None) or [])
        text = (getattr(ch, "text", "") or "").strip()
        if text:
            raw.append(ExtractedChunk(heading=" › ".join(headings), text=text))

    images: list[ExtractedImage] = []
    for pic in getattr(doc, "pictures", []):
        try:
            pil = pic.get_image(doc)
        except Exception:  # noqa: BLE001 — a broken image must not fail the doc
            pil = None
        if pil is None:
            continue
        try:
            caption = (pic.caption_text(doc) or "").strip()
        except Exception:  # noqa: BLE001 — captions are best-effort
            caption = ""
        images.append(ExtractedImage(caption=caption, pil_image=pil))
    return title, raw, images


def _extract(path: str, filename: str, on_progress=None) -> ExtractedDoc:
    """Convert one file with docling. Slow + model-heavy on first call; run
    off the request thread. Serialized: torch isn't thread-safe.

    PDFs convert in _SEGMENT_PAGES-sized page segments; `on_progress(done_pages,
    total_pages)` fires after each segment (real progress for the UI). DOCX
    converts in one shot (no page concept → progress stays indeterminate).
    """
    converter = _get_converter()
    total = _page_count(path)
    segments: list[tuple[int, int] | None] = (
        [(s, min(s + _SEGMENT_PAGES - 1, total)) for s in range(1, total + 1, _SEGMENT_PAGES)]
        if total
        else [None]
    )

    title = ""
    raw: list[ExtractedChunk] = []
    images: list[ExtractedImage] = []
    doc_pages = 0  # fallback page count from the converted document (DOCX)
    with _converter_lock:  # one document (all its segments) at a time
        for seg in segments:
            if seg is None:
                doc = converter.convert(path).document
            else:
                doc = converter.convert(path, page_range=seg).document
            try:
                doc_pages = max(doc_pages, doc.num_pages())
            except Exception:  # noqa: BLE001
                pass
            seg_title, seg_chunks, seg_images = _collect(doc, filename)
            if not title and seg_title:
                title = seg_title
            raw.extend(seg_chunks)
            images.extend(seg_images)
            if seg is not None and on_progress is not None:
                try:
                    on_progress(seg[1], total)
                except Exception:  # noqa: BLE001 — progress is best-effort
                    log.debug("progress callback failed", exc_info=True)

    if not title:
        title = os.path.splitext(os.path.basename(filename))[0]
    return ExtractedDoc(
        title=title[:300],
        page_count=total or doc_pages,
        chunks=refine_chunks(raw),
        images=images,
    )


# --- chunk refinement (pure) -------------------------------------------------
def refine_chunks(chunks: list[ExtractedChunk]) -> list[ExtractedChunk]:
    """Split oversized chunks at paragraph breaks; merge tiny same-heading
    neighbors. Keeps retrieval units coherent without a tokenizer."""
    out: list[ExtractedChunk] = []
    for c in chunks:
        text = c.text.strip()
        if not text:
            continue
        if len(text) > _CHUNK_SPLIT_AT:
            out.extend(_split_chunk(ExtractedChunk(c.heading, text)))
        else:
            out.append(ExtractedChunk(c.heading, text))
    merged: list[ExtractedChunk] = []
    for c in out:
        if (
            merged
            and len(c.text) < _CHUNK_MERGE_BELOW
            and merged[-1].heading == c.heading
            and len(merged[-1].text) + len(c.text) + 2 <= _CHUNK_SPLIT_AT
        ):
            merged[-1] = ExtractedChunk(c.heading, f"{merged[-1].text}\n\n{c.text}")
        else:
            merged.append(c)
    return merged


def _split_chunk(c: ExtractedChunk) -> list[ExtractedChunk]:
    parts, cur = [], ""
    for p in c.text.split("\n\n"):
        if cur and len(cur) + len(p) + 2 > _CHUNK_TARGET:
            parts.append(cur)
            cur = p
        else:
            cur = f"{cur}\n\n{p}" if cur else p
    if cur:
        parts.append(cur)
    final: list[str] = []
    for part in parts:  # a single huge paragraph with no breaks: hard-slice
        while len(part) > _CHUNK_SPLIT_AT:
            final.append(part[:_CHUNK_SPLIT_AT])
            part = part[_CHUNK_SPLIT_AT:]
        final.append(part)
    return [ExtractedChunk(c.heading, t) for t in final]


# --- two-tier PDF parse (edgeparse fast path → docling OCR fallback) --------
def _extract_pdf_tiered(db: Session, lit: Literature, path: str, progress_frac) -> ExtractedDoc:
    """Fast edgeparse pass first; the parse evaluator (parse_eval.py) audits
    the result, and only an `unreliable` verdict (or an edgeparse failure)
    triggers the heavy docling OCR fallback. The fallback result is audited
    once more — that verdict sets the confidence label but never loops.

    `progress_frac(frac)` reports monotone progress: fast pass occupies
    [0.05, 0.3], evaluation 0.3→0.4, OCR fallback [0.4, 1.0]. A forced OCR
    reparse (lit.parse_force_ocr, one-shot) skips the fast tier entirely and
    the OCR pass owns the full [0.05, 1.0] window.

    Imported lazily: pdf_fast/parse_eval import dataclasses from THIS module.
    """
    from app.parse_eval import evaluate_parse
    from app.pdf_fast import extract_fast

    def _phase(phase: str, frac: float) -> None:
        lit.parse_phase = phase
        progress_frac(frac)

    forced = bool(lit.parse_force_ocr)
    if forced:
        # One-shot: a later plain reparse uses the fast path again.
        lit.parse_force_ocr = False

    extracted = None
    if not forced:
        _phase("fast_extract", 0.05)
        try:
            extracted = extract_fast(path, lit.filename)
        except Exception:  # noqa: BLE001 — any fast-path failure falls back to OCR
            log.exception("edgeparse failed, falling back to docling OCR: %s", lit.filename)
        if extracted is not None:
            _phase("evaluating", 0.3)
            res = evaluate_parse(db, extracted.chunks, extracted.page_count, lit.filename)
            if res.verdict != "unreliable":
                lit.parse_engine = "edgeparse"
                lit.parse_confidence = res.verdict
                lit.parse_eval_note = res.note
                return extracted
            log.info(
                "fast parse judged unreliable (%s); falling back to OCR: %s",
                res.note,
                lit.filename,
            )

    lo = 0.05 if forced else 0.4
    _phase("ocr_fallback", lo)

    def _scaled(done: int, total: int) -> None:
        progress_frac(min(lo + (1.0 - lo) * (done / total), 1.0) if total else None)

    extracted = _extract(path, lit.filename, on_progress=_scaled)
    res2 = evaluate_parse(db, extracted.chunks, extracted.page_count, lit.filename)
    lit.parse_engine = "docling"
    lit.parse_confidence = res2.verdict
    prefix = "Forced OCR" if forced else "OCR fallback"
    lit.parse_eval_note = (f"{prefix} — {res2.note}" if res2.note else prefix)[:300]
    return extracted


# --- ingest driver -----------------------------------------------------------
def start_ingest(literature_id: str) -> None:
    threading.Thread(target=_ingest_safe, args=(literature_id,), daemon=True).start()


def _ingest_safe(literature_id: str) -> None:
    db = SessionLocal()
    try:
        ingest(db, literature_id)
    except Exception as e:  # noqa: BLE001 — never lose the failure
        log.exception("literature ingest failed: %s", literature_id)
        # Roll back BEFORE recording the error: the failing session may hold
        # pending chunk/image/FTS rows that must never be committed (a parse
        # is all-or-nothing). Also drop any images already written to disk.
        db.rollback()
        shutil.rmtree(
            os.path.join(literature_dir(literature_id), "images"), ignore_errors=True
        )
        try:
            with SessionLocal() as fresh:
                lit = fresh.get(Literature, literature_id)
                if lit is not None:  # may have been deleted mid-parse
                    lit.status = "error"
                    lit.error = f"{type(e).__name__}: {e}"[:2000]
                    lit.progress = None
                    lit.parse_phase = None
                    lit.embed_status = "none"
                    fresh.commit()
        except Exception:  # noqa: BLE001
            log.exception("failed to record ingest error: %s", literature_id)
    finally:
        db.close()


def ingest(db: Session, literature_id: str) -> None:
    """Parse the uploaded file into chunks (+FTS rows) and images. Callable
    directly from tests (with `_extract` monkeypatched)."""
    lit = db.get(Literature, literature_id)
    if lit is None:
        return
    # Count every attempt up-front so a file that keeps crashing the process
    # trips the startup auto-resume guard instead of crash-looping.
    lit.parse_attempts = (lit.parse_attempts or 0) + 1
    db.commit()
    originals = glob.glob(os.path.join(literature_dir(literature_id), "original.*"))
    if not originals:
        raise FileNotFoundError("original upload missing")

    def _progress_frac(frac) -> None:
        """Best-effort monotone progress write (frac 0..1 or None)."""
        try:
            lit.progress = frac
            db.commit()
        except Exception:  # noqa: BLE001 — never fail a parse over progress
            db.rollback()

    def _progress(done: int, total: int) -> None:
        _progress_frac(min(done / total, 1.0) if total else None)

    if os.path.splitext(originals[0])[1].lower() == ".pdf":
        # Two-tier parse: fast edgeparse + quality audit, OCR fallback only
        # when the audit judges the fast result unreliable. Sets parse_engine /
        # parse_confidence / parse_eval_note as a side effect.
        extracted = _extract_pdf_tiered(db, lit, originals[0], _progress_frac)
    else:
        # DOCX: straight to docling, no audit (no tier-1 exists for it).
        extracted = _extract(originals[0], lit.filename, on_progress=_progress)
    if not extracted.chunks:
        raise RuntimeError(
            "no extractable text found (empty document or image-only scan)"
        )
    # The document may have been deleted while docling was running (the delete
    # endpoint doesn't wait for us). Bail quietly — the delete endpoint owns
    # the disk, and we haven't written anything yet.
    with SessionLocal() as check:
        if check.get(Literature, literature_id) is None:
            return

    os.makedirs(os.path.join(literature_dir(literature_id), "images"), exist_ok=True)
    for seq, img in enumerate(extracted.images):
        rel = literature_rel_path(literature_id, "images", f"img_{seq}.png")
        img.pil_image.save(abs_path(rel), "PNG")
        db.add(
            LiteratureImage(
                id=new_id(),
                literature_id=literature_id,
                seq=seq,
                caption=img.caption,
                path=rel,
                width=getattr(img.pil_image, "width", 0),
                height=getattr(img.pil_image, "height", 0),
            )
        )

    settings = db.get(AISettings, 1)
    embedding_configured = bool(
        settings
        and (settings.embedding_model or "").strip()
        and settings.provider_format == "openai"
        and settings.api_key
        and settings.base_url
    )
    texts = [c.text for c in extracted.chunks]
    embeddings = embed_texts(texts, settings) if settings else None
    # Surface silent degradation: 'failed' means keyword search only.
    lit.embed_status = (
        "ok" if embeddings else ("failed" if embedding_configured else "disabled")
    )

    use_fts = fts_enabled()
    for seq, (chunk, embedding) in enumerate(
        zip(extracted.chunks, embeddings or [None] * len(extracted.chunks))
    ):
        cid = new_id()
        db.add(
            LiteratureChunk(
                id=cid,
                literature_id=literature_id,
                seq=seq,
                heading=chunk.heading,
                text=chunk.text,
                embedding=json.dumps(embedding) if embedding else None,
            )
        )
        if use_fts:
            index_chunk_fts(db, literature_id, cid, chunk.heading, chunk.text)

    lit.title = extracted.title
    lit.page_count = extracted.page_count
    lit.char_count = sum(len(t) for t in texts)
    lit.chunk_count = len(extracted.chunks)
    lit.image_count = len(extracted.images)
    lit.status = "ready"
    lit.error = None
    lit.progress = 1.0
    lit.parse_phase = None
    db.commit()
    # Auto-summarize in the background (skipped inside when AI is unconfigured).
    # Isolated: a failure here must not drag the (already ready) document down
    # to error in _ingest_safe.
    try:
        start_summary(literature_id)
    except Exception:  # noqa: BLE001
        log.exception("failed to start summary: %s", literature_id)
