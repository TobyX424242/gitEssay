"""gitEssay backend — literature library (uploaded PDF/DOCX references).

Upload is a two-phase affair: the file is saved and a `processing` row appears
immediately, then a background thread parses it with docling (chunks + FTS
index + extracted images) and flips the row to `ready` (or `error`). The
frontend polls the list while anything is `processing`.

The agent reaches the content through its tools (list/search/read/read_figure)
— these endpoints are for the library UI.
"""
import glob
import os
import shutil

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import FileResponse
from sqlalchemy import func
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.deps import get_project_or_404
from app.literature_ingest import ALLOWED_EXTENSIONS, MAX_UPLOAD_BYTES, start_ingest
from app.literature_search import delete_literature_fts, read_section
from app.literature_summary import ai_configured, start_summary
from app.models import (
    Literature,
    LiteratureChunk,
    LiteratureImage,
    Memory,
    new_id,
    now_ms,
)
from app.storage import abs_path, literature_dir

router = APIRouter(tags=["literature"])

_ALLOWED_CONTENT_TYPES = {
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/octet-stream",  # generic binary — some browsers send this
}


def _note_count(db: Session, literature_id: str) -> int:
    return db.query(Memory).filter_by(literature_id=literature_id).count()


def _note_counts(db: Session, literature_ids: list[str]) -> dict[str, int]:
    """Batch note counts for a list page — one GROUP BY query instead of one
    COUNT per row (N+1)."""
    if not literature_ids:
        return {}
    rows = (
        db.query(Memory.literature_id, func.count(Memory.id))
        .filter(Memory.literature_id.in_(literature_ids))
        .group_by(Memory.literature_id)
        .all()
    )
    return {lid: n for lid, n in rows}


def _to_out(db: Session, lit: Literature, note_count: int | None = None) -> dict:
    return {
        "id": lit.id,
        "project_id": lit.project_id,
        "filename": lit.filename,
        "title": lit.title or lit.filename,
        "status": lit.status,
        "error": lit.error,
        "page_count": lit.page_count,
        "char_count": lit.char_count,
        "chunk_count": lit.chunk_count,
        "image_count": lit.image_count,
        "note_count": _note_count(db, lit.id) if note_count is None else note_count,
        "summary_status": lit.summary_status or "none",
        "embed_status": lit.embed_status or "none",
        "progress": lit.progress,
        "parse_engine": lit.parse_engine,
        "parse_confidence": lit.parse_confidence or "none",
        "parse_phase": lit.parse_phase,
        "parse_eval_note": lit.parse_eval_note,
        "created_at": lit.created_at,
    }


def _get_literature_or_404(db: Session, lid: str) -> Literature:
    lit = db.get(Literature, lid)
    if lit is None:
        raise HTTPException(status_code=404, detail="literature not found")
    return lit


@router.post("/projects/{pid}/literature", response_model=schemas.LiteratureOut)
def upload_literature(
    pid: str, file: UploadFile = File(...), db: Session = Depends(get_db)
):
    get_project_or_404(db, pid)
    filename = os.path.basename(file.filename or "upload")
    ext = os.path.splitext(filename)[1].lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415, detail=f"unsupported file type {ext or '(none)'} — PDF or DOCX only"
        )
    # Content-type whitelist (defense in depth alongside the extension gate).
    # Some browsers send application/octet-stream or an empty type for DOCX,
    # so those stay allowed; anything explicitly wrong is rejected.
    ct = (file.content_type or "").lower()
    if ct and ct not in _ALLOWED_CONTENT_TYPES:
        raise HTTPException(
            status_code=415, detail=f"unexpected content-type {ct} — PDF or DOCX only"
        )
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="file too large (50 MB max)")
    if not data:
        raise HTTPException(status_code=400, detail="empty file")

    lid = new_id()
    os.makedirs(literature_dir(lid), exist_ok=True)
    with open(os.path.join(literature_dir(lid), f"original{ext}"), "wb") as fh:
        fh.write(data)

    lit = Literature(
        id=lid,
        project_id=pid,
        filename=filename,
        title=filename,
        status="processing",
        created_at=now_ms(),
    )
    db.add(lit)
    db.commit()
    start_ingest(lid)
    return _to_out(db, lit)


@router.get("/projects/{pid}/literature", response_model=list[schemas.LiteratureOut])
def list_literature(pid: str, db: Session = Depends(get_db)):
    get_project_or_404(db, pid)
    rows = (
        db.query(Literature)
        .filter_by(project_id=pid)
        .order_by(Literature.created_at.desc())
        .all()
    )
    counts = _note_counts(db, [lit.id for lit in rows])
    return [_to_out(db, lit, counts.get(lit.id, 0)) for lit in rows]


@router.get("/literature/{lid}", response_model=schemas.LiteratureDetail)
def get_literature(lid: str, db: Session = Depends(get_db)):
    lit = _get_literature_or_404(db, lid)
    outline, _ = read_section(db, lid)  # body discarded — outline only
    images = (
        db.query(LiteratureImage)
        .filter_by(literature_id=lid)
        .order_by(LiteratureImage.seq)
        .all()
    )
    return {
        **_to_out(db, lit),
        "images": [
            {"id": im.id, "seq": im.seq, "caption": im.caption, "width": im.width, "height": im.height}
            for im in images
        ],
        "outline": outline,
        "summary": lit.summary,
    }


@router.get("/literature/{lid}/download")
def download_literature(lid: str, db: Session = Depends(get_db)):
    """Serve the originally uploaded file (PDF/DOCX) with its real filename."""
    lit = _get_literature_or_404(db, lid)
    originals = glob.glob(os.path.join(literature_dir(lid), "original.*"))
    if not originals or not os.path.isfile(originals[0]):
        raise HTTPException(status_code=404, detail="original file missing")
    ext = os.path.splitext(originals[0])[1].lower()
    media = "application/pdf" if ext == ".pdf" else (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    )
    return FileResponse(originals[0], media_type=media, filename=lit.filename)


@router.post("/literature/{lid}/summary", response_model=schemas.LiteratureOut)
def regenerate_summary(lid: str, db: Session = Depends(get_db)):
    """(Re)generate the AI summary — e.g. after it failed, or after the AI
    settings became configured (initial attempt was skipped)."""
    lit = _get_literature_or_404(db, lid)
    if lit.status != "ready":
        raise HTTPException(status_code=409, detail="document is not parsed yet")
    if not ai_configured(db):
        raise HTTPException(status_code=400, detail="AI is not configured")
    if lit.summary_status == "generating":
        return _to_out(db, lit)  # already running — don't stack threads
    start_summary(lid)
    db.refresh(lit)
    return _to_out(db, lit)


@router.post("/literature/{lid}/reparse", response_model=schemas.LiteratureOut)
def reparse_literature(lid: str, force: bool = False, db: Session = Depends(get_db)):
    """Re-run parsing from the still-on-disk original — after a failure, an
    interrupted run, or a docling upgrade. Clears all derived artifacts (chunks,
    FTS rows, images, summary) first; a parse is all-or-nothing.

    `?force=true` (PDFs): skip the edgeparse fast tier and parse directly with
    the heavy docling OCR pipeline (the quality evaluation still runs, and the
    summary regenerates automatically on success)."""
    lit = _get_literature_or_404(db, lid)
    if lit.status == "processing":
        raise HTTPException(status_code=409, detail="already parsing")
    if not glob.glob(os.path.join(literature_dir(lid), "original.*")):
        raise HTTPException(
            status_code=404, detail="original file missing — re-upload instead"
        )
    db.query(LiteratureChunk).filter_by(literature_id=lid).delete()
    db.query(LiteratureImage).filter_by(literature_id=lid).delete()
    delete_literature_fts(db, lid)
    shutil.rmtree(os.path.join(literature_dir(lid), "images"), ignore_errors=True)
    lit.status = "processing"
    lit.error = None
    lit.progress = None
    lit.title = lit.filename
    lit.page_count = 0
    lit.char_count = 0
    lit.chunk_count = 0
    lit.image_count = 0
    lit.summary = None
    lit.summary_status = "none"
    lit.embed_status = "none"
    lit.parse_attempts = 0
    lit.parse_engine = None
    lit.parse_confidence = "none"
    lit.parse_phase = None
    lit.parse_eval_note = None
    lit.parse_force_ocr = force
    db.commit()
    start_ingest(lid)
    return _to_out(db, lit)


@router.get("/literature/{lid}/images/{seq}")
def get_literature_image(lid: str, seq: int, db: Session = Depends(get_db)):
    _get_literature_or_404(db, lid)
    img = (
        db.query(LiteratureImage)
        .filter_by(literature_id=lid, seq=seq)
        .first()
    )
    if img is None:
        raise HTTPException(status_code=404, detail="image not found")
    path = abs_path(img.path)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="image file missing")
    return FileResponse(path, media_type="image/png")


@router.delete("/literature/{lid}")
def delete_literature(lid: str, db: Session = Depends(get_db)):
    lit = _get_literature_or_404(db, lid)
    # Explicit child deletes (repo convention: don't rely on the FK PRAGMA) —
    # including the per-paper notes, which are meaningless without the paper.
    db.query(Memory).filter_by(literature_id=lid).delete()
    db.query(LiteratureChunk).filter_by(literature_id=lid).delete()
    db.query(LiteratureImage).filter_by(literature_id=lid).delete()
    delete_literature_fts(db, lid)
    db.delete(lit)
    db.commit()
    shutil.rmtree(literature_dir(lid), ignore_errors=True)
    return {"ok": True}
