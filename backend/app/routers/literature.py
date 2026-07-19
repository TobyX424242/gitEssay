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


def _note_count(db: Session, literature_id: str) -> int:
    return db.query(Memory).filter_by(literature_id=literature_id).count()


def _to_out(db: Session, lit: Literature) -> dict:
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
        "note_count": _note_count(db, lit.id),
        "summary_status": lit.summary_status or "none",
        "progress": lit.progress,
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
    return [_to_out(db, lit) for lit in rows]


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
