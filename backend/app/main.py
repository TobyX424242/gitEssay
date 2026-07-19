"""gitEssay backend — FastAPI app entrypoint.

Run:  uv run uvicorn app.main:app --reload --port 8000
"""
import json
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import Base, SessionLocal, engine
from app.literature_search import ensure_fts_table
from app.models import EMPTY_STATE, AISettings, Checkpoint, Project, new_id, now_ms
from app.routers import ai as ai_router
from app.routers import checkpoints, conversations, literature, memories, projects


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


def _migrate() -> None:
    """create_all only creates NEW tables; existing DBs need their new columns
    added by hand. SQLite supports ADD COLUMN with a constant default — check
    PRAGMA table_info and add what's missing."""
    wanted = {
        "memories": {"literature_id": "VARCHAR"},
        "ai_settings": {
            "vision_capable": "BOOLEAN NOT NULL DEFAULT 0",
            "embedding_model": "VARCHAR NOT NULL DEFAULT ''",
        },
        "literature": {
            "summary": "TEXT",
            "summary_status": "VARCHAR NOT NULL DEFAULT 'none'",
            "progress": "REAL",
        },
    }
    with engine.connect() as conn:
        for table, cols in wanted.items():
            existing = {
                row[1] for row in conn.exec_driver_sql(f"PRAGMA table_info({table})").all()
            }
            for col, ddl in cols.items():
                if col not in existing:
                    conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {col} {ddl}")
        conn.commit()


Base.metadata.create_all(bind=engine)
_migrate()
ensure_fts_table()
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
app.include_router(literature.router, prefix="/api")
app.include_router(ai_router.router, prefix="/api")


@app.get("/")
def root():
    return {"name": "gitEssay backend", "status": "ok"}
