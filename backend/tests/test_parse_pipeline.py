"""gitEssay backend — two-tier PDF parse tests (edgeparse fast path + audit + OCR fallback).

All tiers are stubbed: `app.pdf_fast.extract_fast` (edgeparse),
`literature_ingest._extract` (docling), and either `app.parse_eval.evaluate_parse`
or `app.parse_eval.ai.call_model` (the LLM auditor). No real models, no network.
"""
import pytest

from app import literature_ingest, parse_eval
from app.literature_ingest import ExtractedChunk, ExtractedDoc, ingest
from app.models import AISettings, Literature
from app.parse_eval import EvalResult


def _good_doc(title: str = "A Good Paper") -> ExtractedDoc:
    """Extraction that passes the density/garbage heuristics (~500 chars/page)."""
    body = "Transformers dominate sequence transduction modeling. " * 20
    return ExtractedDoc(
        title=title,
        page_count=2,
        chunks=[
            ExtractedChunk("1 Introduction", body),
            ExtractedChunk("2 Methods", body),
        ],
        images=[],
    )


def _sparse_doc() -> ExtractedDoc:
    """Extraction that fails the density heuristic (scanned-PDF symptom)."""
    return ExtractedDoc(
        title="Scan",
        page_count=10,
        chunks=[ExtractedChunk("", "page 1")],
        images=[],
    )


@pytest.fixture()
def ai_on(db):
    """Configure the (shared) AISettings row so the LLM audit runs; restore after."""
    s = db.get(AISettings, 1)
    old = (s.provider_format, s.base_url, s.api_key, s.model)
    s.provider_format, s.base_url, s.api_key, s.model = "openai", "http://x", "k", "m"
    db.commit()
    try:
        yield s
    finally:
        s.provider_format, s.base_url, s.api_key, s.model = old
        db.commit()


def _upload(client, project, monkeypatch, name="paper.pdf", data=b"%PDF-1.4 fake"):
    monkeypatch.setattr("app.routers.literature.start_ingest", lambda lid: None)
    r = client.post(
        f"/api/projects/{project['id']}/literature",
        files={"file": (name, data, "application/pdf")},
    )
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _docling_guard(monkeypatch, doc=None):
    """Stub the docling tier; returns the calls list. Raises if doc is None."""
    calls = []

    def stub(path, filename, on_progress=None, **_):
        calls.append(path)
        if doc is None:
            raise AssertionError("docling fallback must not run")
        return doc

    monkeypatch.setattr(literature_ingest, "_extract", stub)
    return calls


# --- fast path accepted -----------------------------------------------------------
def test_fast_path_reliable_no_fallback(client, project, db, monkeypatch):
    """AI unconfigured → heuristics only; a clean extraction is accepted as-is."""
    monkeypatch.setattr("app.pdf_fast.extract_fast", lambda p, f: _good_doc())
    calls = _docling_guard(monkeypatch)  # raises if the fallback runs
    lid = _upload(client, project, monkeypatch)
    ingest(db, lid)
    lit = db.get(Literature, lid)
    assert lit.status == "ready"
    assert lit.parse_engine == "edgeparse"
    assert lit.parse_confidence == "reliable"
    assert lit.parse_phase is None
    assert calls == []


def test_fast_path_llm_reliable(client, project, db, monkeypatch, ai_on):
    monkeypatch.setattr("app.pdf_fast.extract_fast", lambda p, f: _good_doc())
    monkeypatch.setattr(
        parse_eval.ai, "call_model",
        lambda s, sys, user: '{"verdict": "reliable", "reason": "clean text throughout"}',
    )
    _docling_guard(monkeypatch)
    lid = _upload(client, project, monkeypatch)
    ingest(db, lid)
    lit = db.get(Literature, lid)
    assert lit.parse_engine == "edgeparse"
    assert lit.parse_confidence == "reliable"
    assert lit.parse_eval_note == "clean text throughout"


def test_fast_path_llm_partial_accepted(client, project, db, monkeypatch, ai_on):
    monkeypatch.setattr("app.pdf_fast.extract_fast", lambda p, f: _good_doc())
    monkeypatch.setattr(
        parse_eval.ai, "call_model",
        lambda s, sys, user: 'Sure! {"verdict": "partial", "reason": "one broken table"} — hope this helps',
    )
    _docling_guard(monkeypatch)
    lid = _upload(client, project, monkeypatch)
    ingest(db, lid)
    lit = db.get(Literature, lid)
    assert lit.status == "ready"
    assert lit.parse_engine == "edgeparse"
    assert lit.parse_confidence == "partial"
    assert "broken table" in lit.parse_eval_note


def test_eval_garbage_reply_keeps_partial(client, project, db, monkeypatch, ai_on):
    """An unusable auditor reply must not cost an OCR run: keep, mark partial."""
    monkeypatch.setattr("app.pdf_fast.extract_fast", lambda p, f: _good_doc())
    monkeypatch.setattr(parse_eval.ai, "call_model", lambda s, sys, user: "I cannot judge this.")
    _docling_guard(monkeypatch)
    lid = _upload(client, project, monkeypatch)
    ingest(db, lid)
    lit = db.get(Literature, lid)
    assert lit.parse_engine == "edgeparse"
    assert lit.parse_confidence == "partial"
    assert "evaluation unavailable" in lit.parse_eval_note


# --- fallback ----------------------------------------------------------------------
def test_unreliable_triggers_fallback_then_reliable(client, project, db, monkeypatch):
    monkeypatch.setattr("app.pdf_fast.extract_fast", lambda p, f: _good_doc())
    verdicts = iter([
        EvalResult("unreliable", "columns interleaved"),
        EvalResult("reliable", "OCR text is coherent"),
    ])
    # _extract_pdf_tiered imports evaluate_parse lazily — patch the source module.
    monkeypatch.setattr("app.parse_eval.evaluate_parse", lambda db_, c, pc, fn="": next(verdicts))
    calls = _docling_guard(monkeypatch, doc=_good_doc("Recovered Paper"))
    lid = _upload(client, project, monkeypatch)
    ingest(db, lid)
    lit = db.get(Literature, lid)
    assert lit.status == "ready"
    assert len(calls) == 1
    assert lit.parse_engine == "docling"
    assert lit.parse_confidence == "reliable"
    assert lit.parse_eval_note.startswith("OCR fallback")
    assert lit.progress == 1.0


def test_fallback_still_unreliable_is_accepted(client, project, db, monkeypatch):
    """No fallback loop: a second unreliable verdict is kept and labeled."""
    monkeypatch.setattr("app.pdf_fast.extract_fast", lambda p, f: _good_doc())
    monkeypatch.setattr(
        "app.parse_eval.evaluate_parse",
        lambda db_, c, pc, fn="": EvalResult("unreliable", "severely garbled"),
    )
    calls = _docling_guard(monkeypatch, doc=_good_doc())
    lid = _upload(client, project, monkeypatch)
    ingest(db, lid)
    lit = db.get(Literature, lid)
    assert lit.status == "ready"
    assert len(calls) == 1  # exactly one fallback, no loop
    assert lit.parse_engine == "docling"
    assert lit.parse_confidence == "unreliable"


def test_low_density_skips_llm_and_goes_to_fallback(client, project, db, monkeypatch, ai_on):
    """Scanned-PDF symptom: heuristics alone send it to OCR (no LLM call spent
    on the fast result); the fallback result IS audited once."""
    monkeypatch.setattr("app.pdf_fast.extract_fast", lambda p, f: _sparse_doc())
    # ingest() kicks off summary generation on a background thread on success;
    # with AI configured it would call the same (module-globally patched)
    # call_model and race the count assertion below. The summary is not what
    # this test asserts — disable it.
    monkeypatch.setattr("app.literature_ingest.start_summary", lambda lid: None)
    llm_calls = []

    def fake_call(s, sys, user):
        llm_calls.append(user)
        return '{"verdict": "reliable", "reason": "OCR recovered the text"}'

    monkeypatch.setattr(parse_eval.ai, "call_model", fake_call)
    calls = _docling_guard(monkeypatch, doc=_good_doc())
    lid = _upload(client, project, monkeypatch)
    ingest(db, lid)
    lit = db.get(Literature, lid)
    assert len(calls) == 1
    assert len(llm_calls) == 1  # only the post-fallback audit
    assert lit.parse_engine == "docling"
    assert lit.parse_confidence == "reliable"


def test_edgeparse_exception_falls_back(client, project, db, monkeypatch):
    def boom(path, filename):
        raise RuntimeError("invalid PDF object stream")

    monkeypatch.setattr("app.pdf_fast.extract_fast", boom)
    calls = _docling_guard(monkeypatch, doc=_good_doc())
    lid = _upload(client, project, monkeypatch)
    ingest(db, lid)
    lit = db.get(Literature, lid)
    assert lit.status == "ready"
    assert len(calls) == 1
    assert lit.parse_engine == "docling"


def test_fallback_progress_window(client, project, db, monkeypatch):
    """Fallback progress maps into [0.4, 1.0] — the bar never jumps backward."""
    monkeypatch.setattr("app.pdf_fast.extract_fast", lambda p, f: _sparse_doc())
    seen = []

    def fake_extract(path, filename, on_progress=None, **_):
        if on_progress:
            on_progress(1, 2)
            seen.append(db.get(Literature, lid).progress)
            on_progress(2, 2)
        return _good_doc()

    monkeypatch.setattr(literature_ingest, "_extract", fake_extract)
    lid = _upload(client, project, monkeypatch)
    ingest(db, lid)
    assert seen == [0.7]
    assert db.get(Literature, lid).progress == 1.0


# --- DOCX / reparse ------------------------------------------------------------------
def test_docx_skips_tiers(client, project, db, monkeypatch):
    monkeypatch.setattr(
        "app.pdf_fast.extract_fast",
        lambda *a, **_: (_ for _ in ()).throw(AssertionError("docx must not hit edgeparse")),
    )
    calls = _docling_guard(monkeypatch, doc=_good_doc())
    monkeypatch.setattr("app.routers.literature.start_ingest", lambda lid: None)
    r = client.post(
        f"/api/projects/{project['id']}/literature",
        files={"file": ("notes.docx", b"PK fake docx", "application/octet-stream")},
    )
    assert r.status_code == 200, r.text
    lid = r.json()["id"]
    ingest(db, lid)
    lit = db.get(Literature, lid)
    assert lit.status == "ready"
    assert len(calls) == 1
    assert lit.parse_engine is None
    assert lit.parse_confidence == "none"
    assert lit.parse_phase is None


def test_reparse_resets_parse_fields(client, project, db, monkeypatch):
    monkeypatch.setattr("app.pdf_fast.extract_fast", lambda p, f: _good_doc())
    _docling_guard(monkeypatch)
    lid = _upload(client, project, monkeypatch)
    ingest(db, lid)
    lit = db.get(Literature, lid)
    assert lit.parse_engine == "edgeparse"
    r = client.post(f"/api/literature/{lid}/reparse")
    assert r.status_code == 200, r.text
    db.refresh(lit)
    assert lit.status == "processing"
    assert lit.parse_engine is None
    assert lit.parse_confidence == "none"
    assert lit.parse_phase is None
    assert lit.parse_eval_note is None
    assert lit.parse_force_ocr is False


# --- forced OCR reparse -------------------------------------------------------------
def test_force_ocr_skips_fast_tier(client, project, db, monkeypatch):
    """reparse?force=true: the next ingest goes straight to docling OCR, the
    one-shot flag is consumed, and the evaluation still runs."""
    monkeypatch.setattr("app.pdf_fast.extract_fast", lambda p, f: _good_doc())
    _docling_guard(monkeypatch)
    lid = _upload(client, project, monkeypatch)
    ingest(db, lid)
    assert db.get(Literature, lid).parse_engine == "edgeparse"

    r = client.post(f"/api/literature/{lid}/reparse?force=true")
    assert r.status_code == 200, r.text
    lit = db.get(Literature, lid)
    assert lit.parse_force_ocr is True

    # The forced ingest must NOT touch edgeparse.
    monkeypatch.setattr(
        "app.pdf_fast.extract_fast",
        lambda *a, **_: (_ for _ in ()).throw(AssertionError("forced OCR must skip edgeparse")),
    )
    calls = _docling_guard(monkeypatch, doc=_good_doc("OCR Paper"))
    ingest(db, lid)
    lit = db.get(Literature, lid)
    assert lit.status == "ready"
    assert len(calls) == 1
    assert lit.parse_engine == "docling"
    assert lit.parse_confidence == "reliable"  # evaluation re-ran (heuristics, AI off)
    assert lit.parse_eval_note.startswith("Forced OCR")
    assert lit.parse_force_ocr is False  # one-shot flag consumed


def test_force_ocr_progress_uses_full_window(client, project, db, monkeypatch):
    """A forced OCR parse owns the [0.05, 1.0] window (no fast-tier prefix)."""
    monkeypatch.setattr("app.pdf_fast.extract_fast", lambda p, f: _good_doc())
    _docling_guard(monkeypatch)
    lid = _upload(client, project, monkeypatch)
    ingest(db, lid)
    client.post(f"/api/literature/{lid}/reparse?force=true")

    seen = []

    def fake_extract(path, filename, on_progress=None, **_):
        if on_progress:
            on_progress(1, 2)
            seen.append(db.get(Literature, lid).progress)
        return _good_doc()

    monkeypatch.setattr(literature_ingest, "_extract", fake_extract)
    ingest(db, lid)
    assert seen == [0.525]  # 0.05 + 0.95 * (1/2)


# --- evaluator units -------------------------------------------------------------------
def test_heuristic_failure_detects_scan_and_garbage():
    assert parse_eval.heuristic_failure([ExtractedChunk("", "  ")], 5) is not None
    assert parse_eval.heuristic_failure([ExtractedChunk("", "tiny")], 100) is not None
    garbled = ExtractedChunk("", "ok" + "\ufffd" * 30 + "x" * 100)
    assert parse_eval.heuristic_failure([garbled], 1) is not None
    good = [ExtractedChunk("", "clean prose " * 100)]
    assert parse_eval.heuristic_failure(good, 2) is None


def test_parse_verdict_tolerates_prose_around_json():
    r = parse_eval._parse_verdict('Looking at it… {"verdict": "partial", "reason": "ok-ish"} done')
    assert r.verdict == "partial" and r.note == "ok-ish"
    with pytest.raises(ValueError):
        parse_eval._parse_verdict('{"verdict": "great", "reason": "x"}')
    with pytest.raises(ValueError):
        parse_eval._parse_verdict("no json at all")


def test_evaluate_parse_ai_unconfigured_is_heuristic_only(db):
    good = [ExtractedChunk("", "clean prose " * 100)]
    res = parse_eval.evaluate_parse(db, good, 2)
    assert res.verdict == "reliable"
    bad = [ExtractedChunk("", "x")]
    res = parse_eval.evaluate_parse(db, bad, 50)
    assert res.verdict == "unreliable"


def test_sample_chunks_is_bounded():
    chunks = [ExtractedChunk(f"h{i}", "y" * 3000) for i in range(40)]
    sample = parse_eval._sample_chunks(chunks)
    assert len(sample) <= 8
    assert sum(len(c.text) for c in sample) <= parse_eval._SAMPLE_CHAR_CAP


# --- docling model-cache self-heal --------------------------------------------------
def test_extract_repairs_missing_model_files_once(monkeypatch):
    """A FileNotFoundError from model loading (broken HF snapshot pointers)
    triggers one cache repair + retry, then succeeds."""
    calls = {"extract": 0, "repair": 0}

    def flaky(path, filename, on_progress=None, on_models_ready=None, **_):
        calls["extract"] += 1
        if calls["extract"] == 1:
            raise FileNotFoundError("Missing safe tensors file: /x/model.safetensors")
        return ExtractedDoc(
            title="Healed", page_count=1, chunks=[ExtractedChunk("h", "body text")]
        )

    monkeypatch.setattr(literature_ingest, "_extract_once", flaky)
    monkeypatch.setattr(
        literature_ingest,
        "_repair_hf_snapshots",
        lambda: calls.__setitem__("repair", calls["repair"] + 1),
    )

    doc = literature_ingest._extract("x.pdf", "x.pdf")
    assert doc.title == "Healed"
    assert calls == {"extract": 2, "repair": 1}


def test_extract_repair_failure_still_propagates(monkeypatch):
    """If the post-repair retry ALSO hits a missing file, the error surfaces
    instead of looping."""
    monkeypatch.setattr(
        literature_ingest,
        "_extract_once",
        lambda *a, **_: (_ for _ in ()).throw(FileNotFoundError("still missing")),
    )
    monkeypatch.setattr(literature_ingest, "_repair_hf_snapshots", lambda: None)
    with pytest.raises(FileNotFoundError):
        literature_ingest._extract("x.pdf", "x.pdf")
