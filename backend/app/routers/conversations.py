"""gitEssay backend — conversations router (per project).

Messages are stored as a JSON array. Granular ops mirror the frontend store:
append messages (send), replace one message (retry), and patch an edit's state.
"""
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app import schemas
from app.db import get_db
from app.deps import get_project_or_404
from app.models import Conversation, Project, new_id, now_ms

router = APIRouter(tags=["conversations"])


def to_out(c: Conversation) -> dict:
    return {
        "id": c.id,
        "project_id": c.project_id,
        "title": c.title,
        "messages": json.loads(c.messages),
        "created_at": c.created_at,
        "updated_at": c.updated_at,
    }


@router.get(
    "/projects/{pid}/conversations", response_model=list[schemas.ConversationOut]
)
def list_conversations(pid: str, db: Session = Depends(get_db)):
    get_project_or_404(db, pid)
    rows = (
        db.query(Conversation)
        .filter_by(project_id=pid)
        .order_by(Conversation.updated_at.desc())
        .all()
    )
    return [to_out(c) for c in rows]


@router.post(
    "/projects/{pid}/conversations", response_model=schemas.ConversationOut
)
def create_conversation(
    pid: str, body: schemas.ConversationCreate, db: Session = Depends(get_db)
):
    project = get_project_or_404(db, pid)
    cid = new_id()
    now = now_ms()
    conv = Conversation(
        id=cid,
        project_id=pid,
        title=body.title or "New conversation",
        messages="[]",
        created_at=now,
        updated_at=now,
    )
    db.add(conv)
    project.active_conversation_id = cid
    db.commit()
    db.refresh(conv)
    return to_out(conv)


@router.post(
    "/projects/{pid}/conversations/active", response_model=schemas.ProjectOut
)
def set_active_conversation(
    pid: str, body: schemas.SetActive, db: Session = Depends(get_db)
):
    project = get_project_or_404(db, pid)
    # Reject ids that don't belong to this project (foreign / deleted / garbage).
    conv = db.get(Conversation, body.id)
    if conv is None or conv.project_id != pid:
        raise HTTPException(status_code=404, detail="conversation not found")
    project.active_conversation_id = body.id
    db.commit()
    return project


@router.patch("/conversations/{cid}", response_model=schemas.ConversationOut)
def patch_conversation(
    cid: str, body: schemas.ConversationPatch, db: Session = Depends(get_db)
):
    conv = db.get(Conversation, cid)
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    if body.title is not None:
        conv.title = body.title
    if body.messages is not None:
        conv.messages = json.dumps(body.messages)
    conv.updated_at = now_ms()
    db.commit()
    return to_out(conv)


@router.post("/conversations/{cid}/messages", response_model=schemas.ConversationOut)
def append_messages(
    cid: str, body: schemas.MessageAppend, db: Session = Depends(get_db)
):
    conv = db.get(Conversation, cid)
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    msgs = json.loads(conv.messages)
    msgs.extend(body.messages)
    conv.messages = json.dumps(msgs)
    if body.title is not None:
        conv.title = body.title
    conv.updated_at = now_ms()
    db.commit()
    return to_out(conv)


@router.put(
    "/conversations/{cid}/messages/{mid}", response_model=schemas.ConversationOut
)
def replace_message(
    cid: str,
    mid: str,
    body: schemas.MessageReplace,
    db: Session = Depends(get_db),
):
    conv = db.get(Conversation, cid)
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    msgs = json.loads(conv.messages)
    if not any(isinstance(m, dict) and m.get("id") == mid for m in msgs):
        raise HTTPException(status_code=404, detail="message not found")
    msgs = [body.message if (isinstance(m, dict) and m.get("id") == mid) else m for m in msgs]
    conv.messages = json.dumps(msgs)
    conv.updated_at = now_ms()
    db.commit()
    return to_out(conv)


@router.patch(
    "/conversations/{cid}/messages/{mid}/edits/{idx}",
    response_model=schemas.ConversationOut,
)
def set_edit_state(
    cid: str, mid: str, idx: int, body: schemas.EditStatePatch, db: Session = Depends(get_db)
):
    conv = db.get(Conversation, cid)
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    msgs = json.loads(conv.messages)
    applied = False
    for m in msgs:
        if isinstance(m, dict) and m.get("id") == mid and isinstance(m.get("edits"), list):
            if 0 <= idx < len(m["edits"]):
                m["edits"][idx]["state"] = body.state
                applied = True
    if not applied:
        raise HTTPException(status_code=404, detail="edit not found")
    conv.messages = json.dumps(msgs)
    conv.updated_at = now_ms()
    db.commit()
    return to_out(conv)


@router.delete("/conversations/{cid}")
def delete_conversation(cid: str, db: Session = Depends(get_db)):
    conv = db.get(Conversation, cid)
    if conv is None:
        raise HTTPException(status_code=404, detail="conversation not found")
    pid = conv.project_id
    was_active = False
    project = db.get(Project, pid)
    if project and project.active_conversation_id == cid:
        was_active = True
    db.delete(conv)
    db.flush()
    new_active: Optional[str] = None
    if was_active and project is not None:
        remaining = (
            db.query(Conversation)
            .filter_by(project_id=pid)
            .order_by(Conversation.updated_at.desc())
            .first()
        )
        new_active = remaining.id if remaining else None
        project.active_conversation_id = new_active
    db.commit()
    return {"ok": True, "active_conversation_id": new_active}
