"""gitEssay backend — projects router."""
import json

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.deps import get_project_or_404
from app.models import EMPTY_STATE, Checkpoint, Conversation, Project, new_id, now_ms

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
        markdown="",
        created_at=now,
    )
    db.add(project)
    db.flush()  # insert the parent row before its FK child
    db.add(init)
    db.commit()
    db.refresh(project)
    return project


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
    db.delete(project)
    db.commit()
    return {"ok": True}
