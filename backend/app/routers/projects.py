"""gitEssay backend — projects router."""
import json
import re
import shutil

from fastapi import APIRouter, Depends, File, HTTPException, UploadFile
from fastapi.responses import Response
from sqlalchemy.orm import Session

from app import project_transfer, schemas
from app.db import get_db
from app.deps import get_project_or_404
from app.literature_search import delete_literature_fts
from app.models import (
    EMPTY_STATE,
    Checkpoint,
    Conversation,
    Literature,
    LiteratureChunk,
    LiteratureImage,
    Memory,
    Project,
    new_id,
    now_ms,
)
from app.storage import literature_dir

router = APIRouter(tags=["projects"])


@router.get("/projects", response_model=list[schemas.ProjectOut])
def list_projects(db: Session = Depends(get_db)):
    return db.query(Project).order_by(Project.updated_at.desc()).all()


@router.post("/projects", response_model=schemas.ProjectOut)
def create_project(body: schemas.ProjectCreate, db: Session = Depends(get_db)):
    pid = new_id()
    cid = new_id()
    now = now_ms()
    project = Project(
        id=pid,
        name=body.name or "Untitled",
        current_checkpoint_id=cid,
        created_at=now,
        updated_at=now,
    )
    init = Checkpoint(
        id=cid,
        project_id=pid,
        parent_id=None,
        source="init",
        label="Initial",
        state=json.dumps(EMPTY_STATE),
        created_at=now,
    )
    db.add(project)
    db.flush()  # insert the parent row before its FK child
    db.add(init)
    db.commit()
    db.refresh(project)
    return project


# NOTE: /projects/import and /projects/{pid}/export-style static segments
# must be declared BEFORE /projects/{pid} so FastAPI doesn't capture them as
# a project id.
@router.post("/projects/import", response_model=schemas.ProjectOut)
def import_project_archive(file: UploadFile = File(...), db: Session = Depends(get_db)):
    """Restore a project archive (.zip from /projects/{pid}/export) as a NEW
    project. Duplicate names are de-duplicated OS-style: Name, Name (2), ..."""
    data = file.file.read(project_transfer.MAX_ARCHIVE_BYTES + 1)
    try:
        return project_transfer.import_archive(db, data)
    except project_transfer.ArchiveError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


@router.get("/projects/{pid}/export")
def export_project_archive(pid: str, db: Session = Depends(get_db)):
    """Download the full project as a .zip archive (essay + checkpoints + AI
    chat history + memories + literature originals/summaries/chunks/images)."""
    project = get_project_or_404(db, pid)
    data = project_transfer.build_export_zip(db, project)
    safe = re.sub(r'[^\w\-. ()]+', '_', project.name).strip() or "project"
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{safe}.zip"'},
    )


@router.get("/projects/{pid}", response_model=schemas.ProjectOut)
def get_project(pid: str, db: Session = Depends(get_db)):
    return get_project_or_404(db, pid)


@router.patch("/projects/{pid}", response_model=schemas.ProjectOut)
def rename_project(
    pid: str, body: schemas.ProjectRename, db: Session = Depends(get_db)
):
    project = get_project_or_404(db, pid)
    project.name = body.name
    project.updated_at = now_ms()
    db.commit()
    return project


@router.delete("/projects/{pid}")
def delete_project(pid: str, db: Session = Depends(get_db)):
    project = get_project_or_404(db, pid)
    db.query(Checkpoint).filter_by(project_id=pid).delete()
    db.query(Conversation).filter_by(project_id=pid).delete()
    # Memory too — don't rely on the FK-cascade PRAGMA for one child table while
    # deleting the others explicitly (an orphan Memory row if the PRAGMA fails).
    db.query(Memory).filter_by(project_id=pid).delete()
    # Literature: child tables + FTS rows + on-disk files per item.
    for lit in db.query(Literature).filter_by(project_id=pid).all():
        db.query(LiteratureChunk).filter_by(literature_id=lit.id).delete()
        db.query(LiteratureImage).filter_by(literature_id=lit.id).delete()
        delete_literature_fts(db, lit.id)
        shutil.rmtree(literature_dir(lit.id), ignore_errors=True)
        db.delete(lit)
    db.delete(project)
    db.commit()
    return {"ok": True}
