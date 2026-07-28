"""Tests for POST /api/export/pdf (WeasyPrint server-side rendering).

Skipped wholesale when WeasyPrint (or its system pango libs) is unavailable —
e.g. the frozen desktop build excludes it on purpose and the frontend falls
back to the browser print flow there.
"""
import pytest

pytest.importorskip("weasyprint", reason="WeasyPrint not installed (desktop build)")

import pypdfium2 as pdfium  # docling's PDF engine — already a project dep

_HTML = """<!DOCTYPE html><html><head><meta charset="utf-8"><style>
@page { size: A4; margin: 2.2cm 2cm;
  @bottom-center { content: counter(page) " / " counter(pages); } }
hr[data-lexical-page-break] { border: none; margin: 0; visibility: hidden;
  break-after: page; page-break-after: always; }
</style></head><body><p>one</p>
<hr style="page-break-after: always" data-lexical-page-break="true">
<p>two</p></body></html>"""


def test_export_pdf_renders_document(client):
    r = client.post("/api/export/pdf", json={"html": _HTML, "filename": "论文.pdf"})
    assert r.status_code == 200, r.text
    assert r.headers["content-type"] == "application/pdf"
    assert r.content.startswith(b"%PDF-")
    # Page break must actually paginate into two pages.
    assert len(pdfium.PdfDocument(r.content)) == 2
    # UTF-8 filename survives via RFC 5987 filename*.
    disposition = r.headers["content-disposition"]
    assert "attachment" in disposition
    assert "filename*=UTF-8''" in disposition


def test_export_pdf_appends_pdf_extension(client):
    r = client.post("/api/export/pdf", json={"html": _HTML, "filename": "notes"})
    assert r.status_code == 200, r.text
    assert "notes.pdf" in r.headers["content-disposition"]


def test_export_pdf_rejects_empty_html(client):
    r = client.post("/api/export/pdf", json={"html": "", "filename": "x.pdf"})
    assert r.status_code == 422


def test_export_pdf_with_inlined_data_urls(client):
    """The frontend sends self-contained HTML: images and KaTeX woff2 fonts
    inlined as data: URLs — WeasyPrint must resolve them with no base_url."""
    import base64
    from pathlib import Path

    # 1x1 red PNG.
    png = base64.b64encode(
        bytes.fromhex(
            "89504e470d0a1a0a0000000d4948445200000001000000010806000"
            "0001f15c4890000000d49444154789c626000010000050001a5f645"
            "400000000049454e44ae426082"
        )
    ).decode()
    woff2 = Path("../frontend/node_modules/katex/dist/fonts/KaTeX_Main-Regular.woff2")
    font_css = ""
    if woff2.exists():
        font_css = (
            "@font-face { font-family: KaTeX_Main_Inlined; src: url(data:font/woff2;base64,"
            + base64.b64encode(woff2.read_bytes()).decode()
            + ') format("woff2"); } body { font-family: KaTeX_Main_Inlined, serif; }'
        )
    html = (
        '<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
        + font_css
        + '</style></head><body><p>inlined assets</p>'
        + '<img src="data:image/png;base64,'
        + png
        + '" width="10" height="10"></body></html>'
    )
    r = client.post("/api/export/pdf", json={"html": html, "filename": "x.pdf"})
    assert r.status_code == 200, r.text
    assert r.content.startswith(b"%PDF-")
