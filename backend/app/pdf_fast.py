"""gitEssay backend — fast PDF extraction via edgeparse (tier-1 parser).

edgeparse is a Rust-native, OCR-free extractor: milliseconds per document on
CPU, no models, no GPU. It only handles born-digital PDFs (embedded fonts) —
scanned documents yield little or no text and are judged `unreliable` by the
parse evaluator (parse_eval.py), which sends them to the docling OCR fallback.

The output is the same ExtractedDoc shape docling produces (see
literature_ingest.py) so the rest of the ingest pipeline (refine, embed, FTS,
persist) is engine-agnostic. Figures are NOT extracted on this path (the
edgeparse Python SDK does not expose external image output); image-heavy or
scanned documents fall back to docling, which does extract them.
"""
import logging
import os
import re

from app.literature_ingest import ExtractedChunk, ExtractedDoc, _page_count, refine_chunks

log = logging.getLogger(__name__)

_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")


def _markdown_to_chunks(md: str) -> tuple[str, list[ExtractedChunk]]:
    """Split edgeparse Markdown into heading-scoped chunks.

    Returns (title, raw chunks). Title = first heading of any level (mirrors
    the docling path's first-section-header fallback); the caller falls back
    to the filename when empty. Heading paths join with " › " exactly like the
    docling HierarchicalChunker headings, so downstream consumers (outline,
    retrieval display) see one format."""
    title = ""
    stack: list[tuple[int, str]] = []  # (level, text) heading path
    chunks: list[ExtractedChunk] = []
    buf: list[str] = []

    def flush() -> None:
        nonlocal buf
        text = "\n\n".join(b for b in buf if b).strip()
        if text:
            chunks.append(
                ExtractedChunk(heading=" › ".join(h for _, h in stack), text=text)
            )
        buf = []

    for block in re.split(r"\n\s*\n", md):
        block = block.strip("\n")
        if not block.strip():
            continue
        m = _HEADING_RE.match(block)
        if m and "\n" not in block:  # a standalone heading line
            flush()
            level = len(m.group(1))
            text = m.group(2).strip().strip("#").strip()
            if not text:
                continue
            while stack and stack[-1][0] >= level:
                stack.pop()
            stack.append((level, text))
            if not title:
                title = text
        else:
            buf.append(block)
    flush()
    return title, chunks


def extract_fast(path: str, filename: str) -> ExtractedDoc:
    """Convert one born-digital PDF with edgeparse. Fast (~ms) and pure CPU;
    raises on unreadable/encrypted files — the caller falls back to docling.
    """
    import edgeparse

    md = edgeparse.convert(path, format="markdown") or ""
    title, raw = _markdown_to_chunks(md)
    if not title:
        title = os.path.splitext(os.path.basename(filename))[0]
    return ExtractedDoc(
        title=title[:300],
        page_count=_page_count(path) or 0,
        chunks=refine_chunks(raw),
        images=[],  # edgeparse Python SDK exposes no external image output
    )
