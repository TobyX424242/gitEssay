"""gitEssay backend — literature pipeline tests (upload → parse → search → delete).

docling is monkeypatched out via `literature_ingest._extract`, so the suite never
downloads models. A real-docling smoke test runs only with GE_TEST_DOCLING=1.
"""
import os

import pytest
from PIL import Image

from app import literature_ingest, literature_search
from app.literature_ingest import ExtractedChunk, ExtractedDoc, ExtractedImage, ingest, refine_chunks
from app.literature_search import read_section, search_chunks
from app.models import AISettings, Literature, LiteratureChunk, Memory


def _tiny_image() -> Image.Image:
    return Image.new("RGB", (32, 16), color=(200, 30, 30))


def _fake_doc(title: str = "Attention Is All You Need") -> ExtractedDoc:
    return ExtractedDoc(
        title=title,
        page_count=7,
        chunks=[
            ExtractedChunk("1 Introduction", "Transformers dominate sequence modeling. Attention mechanisms are central."),
            ExtractedChunk("2 Methods", "We use multi-head self-attention with scaled dot-product."),
            ExtractedChunk("3 Results", "BLEU scores improve on WMT translation benchmarks."),
        ],
        images=[ExtractedImage(caption="Figure 1: model architecture", pil_image=_tiny_image())],
    )


@pytest.fixture()
def ready_lit(client, project, db, monkeypatch):
    """Upload a PDF (ingest stubbed) and drive it to `ready` synchronously."""
    monkeypatch.setattr(literature_ingest, "_extract", lambda path, filename, **_: _fake_doc())
    captured = []
    monkeypatch.setattr("app.routers.literature.start_ingest", lambda lid: captured.append(lid))
    r = client.post(
        f"/api/projects/{project['id']}/literature",
        files={"file": ("attention.pdf", b"%PDF-1.4 fake bytes", "application/pdf")},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "processing"
    assert captured == [body["id"]]
    ingest(db, body["id"])
    return body


# --- upload validation ---------------------------------------------------------
def test_upload_rejects_bad_extension(client, project):
    r = client.post(
        f"/api/projects/{project['id']}/literature",
        files={"file": ("notes.txt", b"hello", "text/plain")},
    )
    assert r.status_code == 415


def test_upload_rejects_empty(client, project):
    r = client.post(
        f"/api/projects/{project['id']}/literature",
        files={"file": ("empty.pdf", b"", "application/pdf")},
    )
    assert r.status_code == 400


def test_upload_rejects_oversize(client, project, monkeypatch):
    monkeypatch.setattr("app.routers.literature.MAX_UPLOAD_BYTES", 10)
    r = client.post(
        f"/api/projects/{project['id']}/literature",
        files={"file": ("big.pdf", b"x" * 11, "application/pdf")},
    )
    assert r.status_code == 413


# --- ingest → ready ------------------------------------------------------------
def test_ingest_populates_chunks_images_counts(client, project, db, ready_lit):
    detail = client.get(f"/api/literature/{ready_lit['id']}").json()
    assert detail["status"] == "ready"
    assert detail["title"] == "Attention Is All You Need"
    assert detail["page_count"] == 7
    assert detail["chunk_count"] == 3
    assert detail["image_count"] == 1
    assert detail["outline"] == ["1 Introduction", "2 Methods", "3 Results"]
    assert detail["images"][0]["caption"].startswith("Figure 1")
    rows = db.query(LiteratureChunk).filter_by(literature_id=ready_lit["id"]).all()
    assert len(rows) == 3


def test_ingest_error_marks_row(client, project, db, monkeypatch):
    def boom(path, filename, **_):
        raise RuntimeError("corrupt pdf")

    monkeypatch.setattr(literature_ingest, "_extract", boom)
    monkeypatch.setattr("app.routers.literature.start_ingest", lambda lid: None)
    r = client.post(
        f"/api/projects/{project['id']}/literature",
        files={"file": ("broken.pdf", b"%PDF junk", "application/pdf")},
    )
    assert r.status_code == 200
    lid = r.json()["id"]
    with pytest.raises(RuntimeError):
        ingest(db, lid)
    # mirror the thread wrapper's failure handling
    lit = db.get(Literature, lid)
    lit.status = "error"
    lit.error = "RuntimeError: corrupt pdf"
    db.commit()
    detail = client.get(f"/api/literature/{lid}").json()
    assert detail["status"] == "error"
    assert "corrupt" in detail["error"]


# --- search ---------------------------------------------------------------------
def test_fts_search_ranks_relevant_chunk(db, project, ready_lit):
    hits = search_chunks(db, project["id"], "multi-head self-attention")
    assert hits, "expected at least one hit"
    assert "multi-head" in hits[0].text
    assert hits[0].title == "Attention Is All You Need"
    assert hits[0].heading == "2 Methods"


def test_search_scoped_to_one_literature(db, project, ready_lit):
    hits = search_chunks(db, project["id"], "attention", literature_id=ready_lit["id"])
    assert hits
    assert all(h.literature_id == ready_lit["id"] for h in hits)
    missing = search_chunks(db, project["id"], "attention", literature_id="nope")
    assert missing == []


def test_vector_rrf_fusion(db, project, ready_lit, monkeypatch):
    # Pretend an embedding model is configured: query embeds to [1, 0], chunks
    # carry fixed embeddings — the semantically-closest chunk must win.
    chunks = db.query(LiteratureChunk).filter_by(literature_id=ready_lit["id"]).order_by(LiteratureChunk.seq).all()
    vecs = [[0.0, 1.0], [0.0, 1.0], [0.9, 0.1]]
    for c, v in zip(chunks, vecs):
        import json

        c.embedding = json.dumps(v)
    db.commit()
    monkeypatch.setattr(
        literature_search, "embed_texts", lambda texts, settings: [[1.0, 0.0]] * len(texts)
    )
    settings = db.get(AISettings, 1)
    hits = search_chunks(db, project["id"], "zzzz-no-keyword-match", settings=settings)
    assert hits
    assert hits[0].chunk_id == chunks[2].id  # cosine winner [0.9, 0.1]


def test_read_section_navigation(db, project, ready_lit):
    outline, opening = read_section(db, ready_lit["id"])
    assert outline == ["1 Introduction", "2 Methods", "3 Results"]
    assert "Transformers dominate" in opening
    _, methods = read_section(db, ready_lit["id"], "methods")
    assert "multi-head" in methods
    assert "BLEU" not in methods


# --- per-literature notes ---------------------------------------------------------
def test_literature_notes_scoped_and_cascade(client, project, db, ready_lit):
    pid, lid = project["id"], ready_lit["id"]
    r = client.post(f"/api/projects/{pid}/memories", json={"content": "project-wide fact"})
    assert r.status_code == 200
    r = client.post(
        f"/api/projects/{pid}/memories",
        json={"content": "great baseline to cite", "literature_id": lid},
    )
    assert r.status_code == 200, r.text
    assert r.json()["literature_title"] == "Attention Is All You Need"

    all_notes = client.get(f"/api/projects/{pid}/memories").json()
    assert len(all_notes) == 2
    scoped = client.get(f"/api/projects/{pid}/memories?literature_id={lid}").json()
    assert [n["content"] for n in scoped] == ["great baseline to cite"]

    # deleting the paper takes its notes (and chunks/images/FTS rows) with it
    r = client.delete(f"/api/literature/{lid}")
    assert r.status_code == 200
    assert db.query(Memory).filter_by(literature_id=lid).count() == 0
    assert db.query(LiteratureChunk).filter_by(literature_id=lid).count() == 0
    assert client.get(f"/api/literature/{lid}").status_code == 404
    remaining = client.get(f"/api/projects/{pid}/memories").json()
    assert [n["content"] for n in remaining] == ["project-wide fact"]


def test_note_rejects_foreign_literature(client, project, ready_lit):
    other = client.post("/api/projects", json={"name": "Other"}).json()
    r = client.post(
        f"/api/projects/{other['id']}/memories",
        json={"content": "nope", "literature_id": ready_lit["id"]},
    )
    assert r.status_code == 404


# --- deletion removes files -------------------------------------------------------
def test_delete_removes_disk_files(client, project, db, ready_lit):
    from app.storage import literature_dir

    lid = ready_lit["id"]
    assert os.path.isdir(literature_dir(lid))
    client.delete(f"/api/literature/{lid}")
    assert not os.path.exists(literature_dir(lid))


# --- chunk refinement (pure) -------------------------------------------------------
def test_refine_chunks_splits_and_merges():
    big = ExtractedChunk("A", "\n\n".join(f"para {i} " + "x" * 700 for i in range(5)))
    tiny = ExtractedChunk("B", "short note")
    tiny2 = ExtractedChunk("B", "another short")
    out = refine_chunks([big, tiny, tiny2])
    assert all(len(c.text) <= 2400 for c in out)
    assert any("short note" in c.text and "another short" in c.text for c in out)
    joined = "\n\n".join(c.text for c in out)
    for i in range(5):  # no content lost in the split
        assert f"para {i}" in joined


# --- parse progress ----------------------------------------------------------------
def test_ingest_writes_progress_to_db(client, project, db, monkeypatch):
    """A segmented parse reports real page progress into the literature row."""
    seen = []

    def fake_extract(path, filename, on_progress=None, **_):
        if on_progress:
            on_progress(5, 10)
            seen.append(db.get(Literature, lid_ref[0]).progress)
            on_progress(10, 10)
        return _fake_doc()

    monkeypatch.setattr(literature_ingest, "_extract", fake_extract)
    monkeypatch.setattr("app.routers.literature.start_ingest", lambda lid: None)
    r = client.post(
        f"/api/projects/{project['id']}/literature",
        files={"file": ("p.pdf", b"%PDF x", "application/pdf")},
    )
    lid_ref = [r.json()["id"]]
    ingest(db, lid_ref[0])
    assert seen == [0.5]  # mid-parse progress was committed and visible
    assert db.get(Literature, lid_ref[0]).progress == 1.0


def test_page_count_reads_pdf(tmp_path):
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas

    path = tmp_path / "n.pdf"
    c = canvas.Canvas(str(path), pagesize=letter)
    for _ in range(7):
        c.drawString(72, 720, "x")
        c.showPage()
    c.save()
    assert literature_ingest._page_count(str(path)) == 7
    assert literature_ingest._page_count(str(tmp_path / "missing.pdf")) is None


# --- real docling smoke (opt-in) ----------------------------------------------------
@pytest.mark.skipif(os.environ.get("GE_TEST_DOCLING") != "1", reason="docling smoke is opt-in (GE_TEST_DOCLING=1)")
def test_real_docling_parses_pdf(client, project, db, tmp_path):
    from reportlab.lib.pagesizes import letter
    from reportlab.pdfgen import canvas

    pdf_path = tmp_path / "sample.pdf"
    c = canvas.Canvas(str(pdf_path), pagesize=letter)
    c.drawString(72, 720, "A Study of Nothing in Particular")
    c.drawString(72, 700, "Introduction")
    c.drawString(72, 680, "This paper studies nothing, with surprising results.")
    c.save()

    captured = []
    monkeypatch_target = "app.routers.literature.start_ingest"
    import app.routers.literature as lit_router

    orig = lit_router.start_ingest
    setattr(lit_router, "start_ingest", lambda lid: captured.append(lid))
    try:
        r = client.post(
            f"/api/projects/{project['id']}/literature",
            files={"file": ("sample.pdf", pdf_path.read_bytes(), "application/pdf")},
        )
        assert r.status_code == 200, r.text
        lid = r.json()["id"]
        assert captured == [lid]
        ingest(db, lid)
    finally:
        setattr(lit_router, "start_ingest", orig)
    detail = client.get(f"/api/literature/{lid}").json()
    assert detail["status"] == "ready"
    assert detail["chunk_count"] > 0
