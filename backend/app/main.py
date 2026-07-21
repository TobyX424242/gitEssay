"""gitEssay backend — FastAPI app entrypoint.

Run:  uv run uvicorn app.main:app --reload --port 8000
"""
import glob
import json
import logging
import os

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.db import Base, SessionLocal, engine
from app.literature_ingest import start_ingest
from app.literature_search import ensure_fts_table
from app.literature_summary import start_summary
from app.storage import literature_dir, sweep_orphan_dirs

log = logging.getLogger(__name__)
from app.models import (
    EMPTY_STATE,
    AISettings,
    Checkpoint,
    Literature,
    Project,
    new_id,
    now_ms,
)
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
            "parse_attempts": "INTEGER NOT NULL DEFAULT 0",
            "embed_status": "VARCHAR NOT NULL DEFAULT 'none'",
            "parse_engine": "VARCHAR",
            "parse_confidence": "VARCHAR NOT NULL DEFAULT 'none'",
            "parse_phase": "VARCHAR",
            "parse_eval_note": "TEXT",
            "parse_force_ocr": "BOOLEAN NOT NULL DEFAULT 0",
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


# A document whose parsing keeps killing the process (e.g. OOM in docling)
# must not crash-loop: auto-resume gives up after this many total attempts.
_MAX_AUTO_RESUME_ATTEMPTS = 2


def _resume_interrupted() -> None:
    """Background literature parsing/summarizing runs on daemon threads that
    die with the process. Resume interrupted work on startup: originals are
    still on disk, so re-queue parsing (bounded by parse_attempts) and re-run
    interrupted summaries of ready documents."""
    reparse_ids: list[str] = []
    resummary_ids: list[str] = []
    db = SessionLocal()
    try:
        stuck = db.query(Literature).filter(Literature.status == "processing").all()
        for lit in stuck:
            has_original = bool(
                glob.glob(os.path.join(literature_dir(lit.id), "original.*"))
            )
            if has_original and (lit.parse_attempts or 0) < _MAX_AUTO_RESUME_ATTEMPTS:
                lit.progress = None
                lit.error = None
                lit.parse_phase = None
                reparse_ids.append(lit.id)
            else:
                lit.status = "error"
                lit.progress = None
                lit.parse_phase = None
                lit.error = (
                    "Parsing was interrupted by app restart"
                    + (" and the original file is missing (re-upload)" if not has_original else "")
                    + " — use ↻ Retry to parse again."
                )
        for lit in db.query(Literature).filter(Literature.summary_status == "generating").all():
            if lit.status == "ready":
                lit.summary_status = "none"  # start_summary flips it to generating
                resummary_ids.append(lit.id)
            else:
                # Its document is being re-parsed above; a successful ingest
                # triggers the summary automatically.
                lit.summary_status = "failed"
        db.commit()
    finally:
        db.close()
    # Start threads only after the session is closed and init is done.
    for lid in reparse_ids:
        log.info("resuming interrupted literature parse: %s", lid)
        start_ingest(lid)
    for lid in resummary_ids:
        try:
            start_summary(lid)
        except Exception:  # noqa: BLE001
            log.exception("failed to resume summary: %s", lid)


def _sweep_orphan_literature_dirs() -> None:
    """Remove literature/<id> dirs with no DB row — leftovers from a crash
    between the delete endpoint's commit and its rmtree, or from deleting a
    document mid-parse."""
    db = SessionLocal()
    try:
        valid = {row[0] for row in db.query(Literature.id).all()}
    finally:
        db.close()
    removed = sweep_orphan_dirs(valid)
    if removed:
        log.info("swept %d orphan literature dirs", len(removed))


Base.metadata.create_all(bind=engine)
_migrate()
ensure_fts_table()
_seed()
_resume_interrupted()
_sweep_orphan_literature_dirs()

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


# Optionally serve the built frontend same-origin (desktop single-process
# mode, see app/desktop.py). Docker never sets this — nginx serves the
# frontend there and the JSON health route below stays at "/".
_frontend_build = os.environ.get("GITESSAY_FRONTEND_BUILD")
if _frontend_build and os.path.isdir(_frontend_build):
    from fastapi.staticfiles import StaticFiles

    # Mounted after the /api routers, so API routes still match first.
    app.mount("/", StaticFiles(directory=_frontend_build, html=True), name="frontend")
else:

    @app.get("/")
    def root():
        return {"name": "gitEssay backend", "status": "ok"}
