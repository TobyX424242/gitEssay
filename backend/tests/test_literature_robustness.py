"""gitEssay backend — literature robustness tests.

Covers the failure paths the happy-path suite (test_literature.py) doesn't:
failure atomicity in _ingest_safe, the reparse endpoint, startup resume of
interrupted work, orphan-dir sweeping, delete-during-parse, and embedding
status surfacing. docling stays monkeypatched out (no model downloads).
"""
import glob
import os

import pytest
from PIL import Image

from app import literature_ingest, main
from app.db import SessionLocal
from app.literature_ingest import ExtractedChunk, ExtractedDoc, ExtractedImage, ingest
from app.models import AISettings, Literature, LiteratureChunk, LiteratureImage
from app.storage import literature_dir, sweep_orphan_dirs


def _tiny_image() -> Image.Image:
    return Image.new("RGB", (32, 16), color=(200, 30, 30))


def _fake_doc(chunks=None, images=None) -> ExtractedDoc:
    return ExtractedDoc(
        title="Paper",
        page_count=3,
        chunks=chunks
        if chunks is not None
        else [ExtractedChunk("1 Intro", "Some text content here.")],
        images=images if images is not None else [ExtractedImage(caption="Fig 1", pil_image=_tiny_image())],
    )


def _upload(client, project, monkeypatch, doc=None, extract=None):
    """Upload a file with start_ingest captured (never auto-started)."""
    if extract is not None:
        monkeypatch.setattr(literature_ingest, "_extract", extract)
    elif doc is not None:
        monkeypatch.setattr(literature_ingest, "_extract", lambda path, filename, **_: doc)
    captured = []
    monkeypatch.setattr("app.routers.literature.start_ingest", lambda lid: captured.append(lid))
    r = client.post(
        f"/api/projects/{project['id']}/literature",
        files={"file": ("paper.pdf", b"%PDF-1.4 fake", "application/pdf")},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"], captured


# --- _ingest_safe atomicity ----------------------------------------------------
def test_ingest_safe_failure_leaves_no_partial_state(client, project, db, monkeypatch):
    """A failure AFTER images hit disk and rows are pending must commit nothing:
    no half-written chunks/images/FTS rows, no leftover image files."""
    monkeypatch.setattr(literature_ingest, "_extract", lambda p, f, **_: _fake_doc())
    monkeypatch.setattr(literature_ingest, "fts_enabled", lambda: True)

    def boom(*_a, **_k):
        raise RuntimeError("fts exploded")

    monkeypatch.setattr(literature_ingest, "index_chunk_fts", boom)
    lid, _ = _upload(client, project, monkeypatch)
    literature_ingest._ingest_safe(lid)

    db.expire_all()
    lit = db.get(Literature, lid)
    assert lit.status == "error"
    assert "fts exploded" in lit.error
    assert lit.progress is None
    assert db.query(LiteratureChunk).filter_by(literature_id=lid).count() == 0
    assert db.query(LiteratureImage).filter_by(literature_id=lid).count() == 0
    assert not os.path.isdir(os.path.join(literature_dir(lid), "images"))


def test_zero_chunks_is_an_error_not_ready(client, project, db, monkeypatch):
    monkeypatch.setattr(
        literature_ingest, "_extract", lambda p, f, **_: _fake_doc(chunks=[], images=[])
    )
    lid, _ = _upload(client, project, monkeypatch)
    literature_ingest._ingest_safe(lid)

    db.expire_all()
    lit = db.get(Literature, lid)
    assert lit.status == "error"
    assert "no extractable text" in lit.error


# --- reparse endpoint -----------------------------------------------------------
def test_reparse_guards(client, project, db, monkeypatch):
    assert client.post("/api/literature/nope/reparse").status_code == 404

    lid, _ = _upload(client, project, monkeypatch, doc=_fake_doc())
    # still processing → 409
    assert client.post(f"/api/literature/{lid}/reparse").status_code == 409

    # original gone + not processing → 404 (re-upload is the only way)
    for p in glob.glob(os.path.join(literature_dir(lid), "original.*")):
        os.remove(p)
    lit = db.get(Literature, lid)
    lit.status = "error"
    db.commit()
    r = client.post(f"/api/literature/{lid}/reparse")
    assert r.status_code == 404
    assert "re-upload" in r.json()["detail"]


def test_reparse_full_cycle(client, project, db, monkeypatch):
    # First parse fails…
    def boom(path, filename, **_):
        raise RuntimeError("corrupt pdf")

    lid, _ = _upload(client, project, monkeypatch, extract=boom)
    literature_ingest._ingest_safe(lid)
    db.expire_all()
    assert db.get(Literature, lid).status == "error"

    # …then reparse with a working extractor, driven synchronously.
    monkeypatch.setattr(literature_ingest, "_extract", lambda p, f, **_: _fake_doc())
    monkeypatch.setattr(
        "app.routers.literature.start_ingest",
        lambda lid2: literature_ingest._ingest_safe(lid2),
    )
    monkeypatch.setattr(literature_ingest, "start_summary", lambda lid2: None)
    r = client.post(f"/api/literature/{lid}/reparse")
    assert r.status_code == 200, r.text

    detail = client.get(f"/api/literature/{lid}").json()
    assert detail["status"] == "ready"
    assert detail["chunk_count"] == 1
    assert detail["image_count"] == 1
    assert detail["error"] is None


# --- startup resume ---------------------------------------------------------------
def test_resume_requeues_interrupted_parse(client, project, db, monkeypatch):
    lid, _ = _upload(client, project, monkeypatch, doc=_fake_doc())
    lit = db.get(Literature, lid)
    lit.progress = 0.6  # died mid-parse
    db.commit()

    started = []
    monkeypatch.setattr(main, "start_ingest", lambda x: started.append(x))
    monkeypatch.setattr(main, "start_summary", lambda x: None)
    main._resume_interrupted()

    assert lid in started
    db.expire_all()
    lit = db.get(Literature, lid)
    assert lit.status == "processing"  # re-queued, not failed
    assert lit.progress is None
    assert lit.error is None


def test_resume_gives_up_after_repeated_crashes(client, project, db, monkeypatch):
    lid, _ = _upload(client, project, monkeypatch, doc=_fake_doc())
    lit = db.get(Literature, lid)
    lit.parse_attempts = main._MAX_AUTO_RESUME_ATTEMPTS
    db.commit()

    started = []
    monkeypatch.setattr(main, "start_ingest", lambda x: started.append(x))
    monkeypatch.setattr(main, "start_summary", lambda x: None)
    main._resume_interrupted()

    assert lid not in started
    db.expire_all()
    lit = db.get(Literature, lid)
    assert lit.status == "error"
    assert "Retry" in lit.error


def test_resume_errors_when_original_missing(client, project, db, monkeypatch):
    lid, _ = _upload(client, project, monkeypatch, doc=_fake_doc())
    for p in glob.glob(os.path.join(literature_dir(lid), "original.*")):
        os.remove(p)
    db.commit()

    started = []
    monkeypatch.setattr(main, "start_ingest", lambda x: started.append(x))
    monkeypatch.setattr(main, "start_summary", lambda x: None)
    main._resume_interrupted()

    assert lid not in started
    db.expire_all()
    assert db.get(Literature, lid).status == "error"


def test_resume_requeues_interrupted_summary(client, project, db, monkeypatch):
    monkeypatch.setattr(literature_ingest, "start_summary", lambda lid2: None)
    lid, _ = _upload(client, project, monkeypatch, doc=_fake_doc())
    ingest(db, lid)
    lit = db.get(Literature, lid)
    assert lit.status == "ready"
    lit.summary_status = "generating"  # died mid-summary
    db.commit()

    summarized = []
    monkeypatch.setattr(main, "start_ingest", lambda x: None)
    monkeypatch.setattr(main, "start_summary", lambda x: summarized.append(x))
    main._resume_interrupted()

    assert lid in summarized


# --- orphan sweep ------------------------------------------------------------------
def test_sweep_orphan_dirs(db):
    orphan = literature_dir("orphan-id")
    os.makedirs(orphan, exist_ok=True)
    open(os.path.join(orphan, "stale.png"), "w").close()
    keep = literature_dir("keep-id")
    os.makedirs(keep, exist_ok=True)

    valid = {row[0] for row in db.query(Literature.id).all()} | {"keep-id"}
    removed = sweep_orphan_dirs(valid)

    assert "orphan-id" in removed
    assert not os.path.exists(orphan)
    assert os.path.isdir(keep)
    assert "keep-id" not in removed


# --- delete during parse -------------------------------------------------------------
def test_ingest_bails_quietly_when_deleted_mid_parse(client, project, db, monkeypatch):
    holder = {}

    def extract(path, filename, **_):
        # The user deletes the document while docling is busy converting.
        with SessionLocal() as s:
            lit = s.get(Literature, holder["lid"])
            s.delete(lit)
            s.commit()
        return _fake_doc()

    monkeypatch.setattr(literature_ingest, "start_summary", lambda lid2: None)
    lid, _ = _upload(client, project, monkeypatch, extract=extract)
    holder["lid"] = lid
    literature_ingest._ingest_safe(lid)  # must not raise

    assert db.get(Literature, lid) is None
    assert not os.path.isdir(os.path.join(literature_dir(lid), "images"))


# --- embedding status ------------------------------------------------------------------
def _configure_embedding(db):
    s = db.get(AISettings, 1)
    s.provider_format = "openai"
    s.base_url = "https://example.test/v1"
    s.api_key = "k"
    s.embedding_model = "emb-model"
    db.commit()


def _reset_ai_settings(db):
    s = db.get(AISettings, 1)
    s.base_url = ""
    s.api_key = ""
    s.model = ""
    s.embedding_model = ""
    db.commit()


def test_embed_status_disabled_without_model(client, project, db, monkeypatch):
    monkeypatch.setattr(literature_ingest, "start_summary", lambda lid2: None)
    lid, _ = _upload(client, project, monkeypatch, doc=_fake_doc())
    ingest(db, lid)
    assert db.get(Literature, lid).embed_status == "disabled"


def test_embed_status_failed_when_embedding_errors(client, project, db, monkeypatch):
    monkeypatch.setattr(literature_ingest, "start_summary", lambda lid2: None)
    _configure_embedding(db)
    try:
        monkeypatch.setattr(literature_ingest, "embed_texts", lambda texts, settings: None)
        lid, _ = _upload(client, project, monkeypatch, doc=_fake_doc())
        ingest(db, lid)
        lit = db.get(Literature, lid)
        assert lit.embed_status == "failed"
        # no vectors stored → keyword search only
        chunk = db.query(LiteratureChunk).filter_by(literature_id=lid).one()
        assert chunk.embedding is None
    finally:
        _reset_ai_settings(db)


def test_embed_status_ok(client, project, db, monkeypatch):
    monkeypatch.setattr(literature_ingest, "start_summary", lambda lid2: None)
    _configure_embedding(db)
    try:
        monkeypatch.setattr(
            literature_ingest,
            "embed_texts",
            lambda texts, settings: [[0.1, 0.2] for _ in texts],
        )
        lid, _ = _upload(client, project, monkeypatch, doc=_fake_doc())
        ingest(db, lid)
        lit = db.get(Literature, lid)
        assert lit.embed_status == "ok"
        chunk = db.query(LiteratureChunk).filter_by(literature_id=lid).one()
        assert chunk.embedding is not None
    finally:
        _reset_ai_settings(db)
