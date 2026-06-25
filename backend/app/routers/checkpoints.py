"""gitEssay backend — checkpoints router (owns the version DAG).

Mirrors the frontend's src/checkpoints/service.ts capture/restore rules:
  - AUTO checkpoints are a rolling singleton (one row per project, stable id
    `<projectId>::auto`), reparented to the latest durable checkpoint.
  - Durable (manual/init/ai-accept) checkpoints chain off the latest durable,
    then drop the auto slot; the project's current pointer advances.
"""
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.models import Checkpoint, Project, auto_slot_id, new_id, now_ms

router = APIRouter(tags=["checkpoints"])


def _get_project(db: Session, pid: str) -> Project:
    p = db.get(Project, pid)
    if p is None:
        raise HTTPException(status_code=404, detail="project not found")
    return p


def to_out(cp: Checkpoint) -> dict:
    return {
        "id": cp.id,
        "project_id": cp.project_id,
        "parent_id": cp.parent_id,
        "schema_version": cp.schema_version,
        "lexical_version": cp.lexical_version,
        "state": json.loads(cp.state),
        "markdown": cp.markdown,
        "source": cp.source,
        "label": cp.label,
        "created_at": cp.created_at,
    }


def _latest_durable_id(db: Session, pid: str) -> Optional[str]:
    row = (
        db.query(Checkpoint)
        .filter(Checkpoint.project_id == pid, Checkpoint.source != "auto")
        .order_by(Checkpoint.created_at.desc())
        .first()
    )
    return row.id if row else None


@router.get("/projects/{pid}/checkpoints", response_model=list[schemas.CheckpointOut])
def list_checkpoints(pid: str, db: Session = Depends(get_db)):
    _get_project(db, pid)
    rows = (
        db.query(Checkpoint)
        .filter_by(project_id=pid)
        .order_by(Checkpoint.created_at.desc())
        .all()
    )
    return [to_out(c) for c in rows]


@router.get("/projects/{pid}/current", response_model=Optional[schemas.CheckpointOut])
def get_current(pid: str, db: Session = Depends(get_db)):
    project = _get_project(db, pid)
    if not project.current_checkpoint_id:
        return None
    cp = db.get(Checkpoint, project.current_checkpoint_id)
    return to_out(cp) if cp else None


@router.post("/projects/{pid}/checkpoints", response_model=Optional[schemas.CheckpointOut])
def capture_checkpoint(
    pid: str, body: schemas.CheckpointCapture, db: Session = Depends(get_db)
):
    project = _get_project(db, pid)
    current = (
        db.get(Checkpoint, project.current_checkpoint_id)
        if project.current_checkpoint_id
        else None
    )

    if body.skip_if_unchanged and current and current.markdown == body.markdown:
        return None  # no change since the current checkpoint

    now = now_ms()
    state_json = json.dumps(body.state)

    if body.source == "auto":
        slot_id = auto_slot_id(pid)
        parent_id = _latest_durable_id(db, pid)
        slot = db.get(Checkpoint, slot_id)
        if slot:
            slot.parent_id = parent_id
            slot.state = state_json
            slot.markdown = body.markdown
            slot.label = None
            slot.source = "auto"
            slot.created_at = now
        else:
            slot = Checkpoint(
                id=slot_id,
                project_id=pid,
                parent_id=parent_id,
                state=state_json,
                markdown=body.markdown,
                source="auto",
                created_at=now,
            )
            db.add(slot)
        project.current_checkpoint_id = slot_id
        db.commit()
        db.refresh(slot)
        return to_out(slot)

    # durable
    parent_id = (
        current.parent_id if (current and current.source == "auto") else project.current_checkpoint_id
    )
    cid = new_id()
    cp = Checkpoint(
        id=cid,
        project_id=pid,
        parent_id=parent_id,
        state=state_json,
        markdown=body.markdown,
        source=body.source,
        label=body.label,
        created_at=now,
    )
    db.add(cp)
    db.query(Checkpoint).filter_by(id=auto_slot_id(pid)).delete()
    project.current_checkpoint_id = cid
    db.commit()
    db.refresh(cp)
    return to_out(cp)


@router.post(
    "/projects/{pid}/checkpoints/{cid}/restore", response_model=schemas.CheckpointOut
)
def restore_checkpoint(pid: str, cid: str, db: Session = Depends(get_db)):
    project = _get_project(db, pid)
    cp = db.get(Checkpoint, cid)
    if cp is None or cp.project_id != pid:
        raise HTTPException(status_code=404, detail="checkpoint not found")
    project.current_checkpoint_id = cid
    if cp.source != "auto":
        db.query(Checkpoint).filter_by(id=auto_slot_id(pid)).delete()
    db.commit()
    return to_out(cp)
