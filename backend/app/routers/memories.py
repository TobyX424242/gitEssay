"""gitEssay backend — per-project AI long-term memory.

The AI keeps free-form notes about a project (its understanding, conventions,
decisions, open questions) so it can carry context across conversations. The
frontend injects these into the agent's system prompt when the user has
long-term memory enabled, and the agent can append new notes via its `remember`
action. The backend just stores/serves them; the enable/disable toggle lives in
the frontend (it gates injection + the remember action there).
"""
from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.deps import get_project_or_404
from app.models import Memory, new_id, now_ms

router = APIRouter(tags=["memories"])


def to_out(m: Memory) -> dict:
    return {
        "id": m.id,
        "project_id": m.project_id,
        "content": m.content,
        "created_at": m.created_at,
    }


@router.get("/projects/{pid}/memories", response_model=list[schemas.MemoryOut])
def list_memories(pid: str, db: Session = Depends(get_db)):
    get_project_or_404(db, pid)
    rows = (
        db.query(Memory)
        .filter_by(project_id=pid)
        .order_by(Memory.created_at.desc())
        .all()
    )
    return [to_out(m) for m in rows]


@router.post("/projects/{pid}/memories", response_model=schemas.MemoryOut)
def create_memory(pid: str, body: schemas.MemoryCreate, db: Session = Depends(get_db)):
    get_project_or_404(db, pid)
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="memory content is empty")
    m = Memory(id=new_id(), project_id=pid, content=content, created_at=now_ms())
    db.add(m)
    db.commit()
    db.refresh(m)
    return to_out(m)


@router.delete("/memories/{mid}")
def delete_memory(mid: str, db: Session = Depends(get_db)):
    m = db.get(Memory, mid)
    if m is None:
        raise HTTPException(status_code=404, detail="memory not found")
    db.delete(m)
    db.commit()
    return {"ok": True}
