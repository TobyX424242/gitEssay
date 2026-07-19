"""gitEssay backend — per-project AI long-term memory.

The AI keeps free-form notes about a project (its understanding, conventions,
decisions, open questions) so it can carry context across conversations. The
frontend injects these into the agent's system prompt when the user has
long-term memory enabled, and the agent can append new notes via its `remember`
action. The backend just stores/serves them; the enable/disable toggle lives in
the frontend (it gates injection + the remember action there).

Notes are optionally scoped to one literature item (`literature_id`): the
agent's per-paper reading notes. Those are NOT injected into the main prompt —
they're read on demand (`read_notes`) and injected into subagents analyzing
that paper.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.deps import get_project_or_404
from app.models import Literature, Memory, new_id, now_ms

router = APIRouter(tags=["memories"])


def to_out(m: Memory, lit_title: Optional[str] = None) -> dict:
    return {
        "id": m.id,
        "project_id": m.project_id,
        "literature_id": m.literature_id,
        "literature_title": lit_title,
        "content": m.content,
        "created_at": m.created_at,
    }


def _titles(db: Session, rows: list[Memory]) -> dict[str, str]:
    """literature_id → title map for the notes that have one."""
    ids = {m.literature_id for m in rows if m.literature_id}
    if not ids:
        return {}
    return {
        lit.id: lit.title
        for lit in db.query(Literature).filter(Literature.id.in_(ids)).all()
    }


@router.get("/projects/{pid}/memories", response_model=list[schemas.MemoryOut])
def list_memories(
    pid: str, literature_id: Optional[str] = None, db: Session = Depends(get_db)
):
    get_project_or_404(db, pid)
    q = db.query(Memory).filter_by(project_id=pid)
    if literature_id is not None:
        q = q.filter(Memory.literature_id == literature_id)
    rows = q.order_by(Memory.created_at.desc()).all()
    titles = _titles(db, rows)
    return [to_out(m, titles.get(m.literature_id or "")) for m in rows]


@router.post("/projects/{pid}/memories", response_model=schemas.MemoryOut)
def create_memory(pid: str, body: schemas.MemoryCreate, db: Session = Depends(get_db)):
    get_project_or_404(db, pid)
    content = body.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="memory content is empty")
    lit = None
    if body.literature_id:
        lit = db.get(Literature, body.literature_id)
        if lit is None or lit.project_id != pid:
            raise HTTPException(status_code=404, detail="literature not found")
    m = Memory(
        id=new_id(),
        project_id=pid,
        literature_id=lit.id if lit else None,
        content=content,
        created_at=now_ms(),
    )
    db.add(m)
    db.commit()
    db.refresh(m)
    return to_out(m, lit.title if lit else None)


@router.delete("/memories/{mid}")
def delete_memory(mid: str, db: Session = Depends(get_db)):
    m = db.get(Memory, mid)
    if m is None:
        raise HTTPException(status_code=404, detail="memory not found")
    db.delete(m)
    db.commit()
    return {"ok": True}
