"""gitEssay backend — checkpoints router (owns the version DAG).

Mirrors the frontend's src/checkpoints/service.ts capture/restore rules:
  - AUTO checkpoints are a rolling singleton (one row per project, stable id
    `<projectId>::auto`), reparented to the latest durable checkpoint.
  - Durable (manual/init/ai-accept) checkpoints chain off the latest durable,
    then drop the auto slot; the project's current pointer advances.
  - RETENTION: durables are capped per project (MAX_DURABLE_CHECKPOINTS); the
    oldest are pruned when over the cap, always preserving the init baseline
    and the current pointer. (Auto is self-bounding — a singleton.) parent_id
    is not traversed anywhere, so pruning a mid-history node is safe.
"""
import json
import os
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, defer

from app import schemas
from app.db import get_db
from app.deps import get_project_or_404
from app.models import Checkpoint, auto_slot_id, new_id, now_ms

router = APIRouter(tags=["checkpoints"])

# Per-project cap on durable checkpoints (manual / init / ai-accept). Auto is a
# rolling singleton so it never counts. Env-overridable for testing.
MAX_DURABLE_CHECKPOINTS = int(os.environ.get("GE_MAX_DURABLE_CHECKPOINTS", "100"))


def to_meta(cp: Checkpoint) -> dict:
    """List view: metadata only, no state parse (keeps the list endpoint O(rows))."""
    return {
        "id": cp.id,
        "project_id": cp.project_id,
        "parent_id": cp.parent_id,
        "source": cp.source,
        "label": cp.label,
        "created_at": cp.created_at,
    }


def to_out(cp: Checkpoint) -> dict:
    return {
        "id": cp.id,
        "project_id": cp.project_id,
        "parent_id": cp.parent_id,
        "state": json.loads(cp.state),
        "source": cp.source,
        "label": cp.label,
        "created_at": cp.created_at,
    }


def _latest_durable_id(db: Session, pid: str) -> Optional[str]:
    # Tiebreak on id: created_at is millisecond-resolution, and a same-ms tie
    # must still resolve deterministically (which row becomes the DAG parent).
    row = (
        db.query(Checkpoint)
        .filter(Checkpoint.project_id == pid, Checkpoint.source != "auto")
        .order_by(Checkpoint.created_at.desc(), Checkpoint.id.desc())
        .first()
    )
    return row.id if row else None


def _enforce_retention(db: Session, pid: str, current_id: Optional[str]) -> None:
    """Prune oldest durable checkpoints beyond MAX_DURABLE_CHECKPOINTS. Never
    touches the init baseline or the current pointer. parent_id is not read
    anywhere, so deleting a node mid-chain (leaving a dangling parent ref on
    its children) is harmless."""
    # defer(Checkpoint.state): pruning only needs id/source/ordering — the state column
    # holds the full Lexical JSON (MBs per row for long documents).
    durables = (
        db.query(Checkpoint)
        .options(defer(Checkpoint.state))
        .filter(Checkpoint.project_id == pid, Checkpoint.source != "auto")
        .order_by(Checkpoint.created_at.asc(), Checkpoint.id.asc())
        .all()
    )
    excess = len(durables) - MAX_DURABLE_CHECKPOINTS
    for cp in durables:
        if excess <= 0:
            break
        if cp.id == current_id or cp.source == "init":
            continue
        db.delete(cp)
        excess -= 1


@router.get("/projects/{pid}/checkpoints", response_model=list[schemas.CheckpointMeta])
def list_checkpoints(pid: str, db: Session = Depends(get_db)):
    get_project_or_404(db, pid)
    # defer(Checkpoint.state): to_meta never reads state — skip loading MBs of Lexical
    # JSON per row just to render the metadata list.
    rows = (
        db.query(Checkpoint)
        .options(defer(Checkpoint.state))
        .filter_by(project_id=pid)
        .order_by(Checkpoint.created_at.desc(), Checkpoint.id.desc())
        .all()
    )
    return [to_meta(c) for c in rows]


@router.get("/projects/{pid}/checkpoints/{cid}", response_model=schemas.CheckpointOut)
def get_checkpoint(pid: str, cid: str, db: Session = Depends(get_db)):
    get_project_or_404(db, pid)
    cp = db.get(Checkpoint, cid)
    if cp is None or cp.project_id != pid:
        raise HTTPException(status_code=404, detail="checkpoint not found")
    return to_out(cp)


@router.get("/projects/{pid}/current", response_model=Optional[schemas.CheckpointOut])
def get_current(pid: str, db: Session = Depends(get_db)):
    project = get_project_or_404(db, pid)
    if not project.current_checkpoint_id:
        return None
    cp = db.get(Checkpoint, project.current_checkpoint_id)
    return to_out(cp) if cp else None


@router.post("/projects/{pid}/checkpoints", response_model=Optional[schemas.CheckpointOut])
def capture_checkpoint(
    pid: str, body: schemas.CheckpointCapture, db: Session = Depends(get_db)
):
    project = get_project_or_404(db, pid)
    current = (
        db.get(Checkpoint, project.current_checkpoint_id)
        if project.current_checkpoint_id
        else None
    )

    # Dedup auto-saves by comparing the serialized state directly (lossless,
    # unlike the old markdown proxy). Compute the canonical JSON string once.
    state_json = json.dumps(body.state)
    if body.skip_if_unchanged and current and current.state == state_json:
        return None  # no change since the current checkpoint

    now = now_ms()

    if body.source == "auto":
        slot_id = auto_slot_id(pid)
        parent_id = _latest_durable_id(db, pid)
        slot = db.get(Checkpoint, slot_id)
        if slot:
            slot.parent_id = parent_id
            slot.state = state_json
            slot.label = None
            slot.source = "auto"
            slot.created_at = now
        else:
            slot = Checkpoint(
                id=slot_id,
                project_id=pid,
                parent_id=parent_id,
                state=state_json,
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
        source=body.source,
        label=body.label,
        created_at=now,
    )
    db.add(cp)
    db.query(Checkpoint).filter_by(id=auto_slot_id(pid)).delete()
    project.current_checkpoint_id = cid
    db.flush()  # make the new durable visible to the retention count (autoflush is off)
    _enforce_retention(db, pid, cid)
    db.commit()
    db.refresh(cp)
    return to_out(cp)


@router.post(
    "/projects/{pid}/checkpoints/{cid}/restore", response_model=schemas.CheckpointOut
)
def restore_checkpoint(pid: str, cid: str, db: Session = Depends(get_db)):
    project = get_project_or_404(db, pid)
    cp = db.get(Checkpoint, cid)
    if cp is None or cp.project_id != pid:
        raise HTTPException(status_code=404, detail="checkpoint not found")
    project.current_checkpoint_id = cid
    if cp.source != "auto":
        db.query(Checkpoint).filter_by(id=auto_slot_id(pid)).delete()
    db.commit()
    return to_out(cp)
