"""gitEssay backend — FastAPI app entrypoint.

Run:  uv run uvicorn app.main:app --reload --port 8000
"""
import json
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import Base, SessionLocal, engine
from app.models import EMPTY_STATE, AISettings, Checkpoint, Project, new_id, now_ms
from app.routers import ai as ai_router
from app.routers import checkpoints, conversations, memories, projects


def _seed() -> None:
    db = SessionLocal()
    try:
        if db.query(Project).count() == 0:
            pid = new_id()
            cid = new_id()
            now = now_ms()
            db.add(
                Project(
                    id=pid,
                    name="Default",
                    current_checkpoint_id=cid,
                    created_at=now,
                    updated_at=now,
                )
            )
            db.flush()  # insert the parent row before its FK child
            db.add(
                Checkpoint(
                    id=cid,
                    project_id=pid,
                    parent_id=None,
                    source="init",
                    label="Initial",
                    state=json.dumps(EMPTY_STATE),
                    created_at=now,
                )
            )
            db.commit()
        if db.query(AISettings).count() == 0:
            db.add(AISettings(id=1))
            db.commit()
    finally:
        db.close()


Base.metadata.create_all(bind=engine)
_seed()

app = FastAPI(title="gitEssay backend")
# Single-user local app with no auth and a server-side LLM key: an open CORS
# policy would let ANY website the user visits drive this backend (read data,
# burn LLM quota). In practice the browser never needs CORS at all — the Vite
# dev server and the docker nginx both proxy /api same-origin — so default to
# the local dev origins only; override with GITESSAY_CORS_ORIGINS (comma-sep).
_cors_origins = os.environ.get(
    "GITESSAY_CORS_ORIGINS",
    "http://localhost:5180,http://127.0.0.1:5180",
).split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _cors_origins if o.strip()],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
app.include_router(projects.router, prefix="/api")
app.include_router(checkpoints.router, prefix="/api")
app.include_router(conversations.router, prefix="/api")
app.include_router(memories.router, prefix="/api")
app.include_router(ai_router.router, prefix="/api")


@app.get("/")
def root():
    return {"name": "gitEssay backend", "status": "ok"}
