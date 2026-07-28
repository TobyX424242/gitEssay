"""gitEssay backend — server-side PDF export.

The frontend sends a fully self-contained HTML document (KaTeX CSS + fonts
and images inlined as data: URLs, @page rules for header/footer/page numbers
already composed from the user's settings) and gets back the rendered PDF.
WeasyPrint supports @page margin boxes (@top-center / counter(page) …), so
exactly — and only — what the user configured lands in the PDF, unlike the
browser print dialog which force-adds its own date/title/URL headers.

WeasyPrint needs system Pango/Fontconfig libs, which the Docker image has
but the frozen desktop build does not (excluded from desktop.spec — the
frontend falls back to the browser print flow on a 501 there). Import lazily
so the rest of the app is unaffected either way.
"""
import logging
import re
from urllib.parse import quote

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

log = logging.getLogger(__name__)

router = APIRouter(tags=["export"])

# Self-contained HTML with inlined fonts/images can be a few MB; cap it so a
# malformed request can't exhaust memory while WeasyPrint renders.
_MAX_HTML_BYTES = 64 * 1024 * 1024


class PdfExportRequest(BaseModel):
    html: str = Field(min_length=1, max_length=_MAX_HTML_BYTES)
    filename: str = Field(default="document.pdf", max_length=255)


def _data_only_url_fetcher():
    """SSRF/LFI guard: the frontend inlines every asset (fonts, images) as a
    data: URL, so every other scheme — http(s):, file:, ftp: — is rejected.
    WeasyPrint's default URLFetcher allows ALL protocols (incl. file://) and
    follows redirects, which would let a request to this unauthenticated
    endpoint fetch arbitrary URLs (SSRF, e.g. cloud metadata endpoints) or
    embed local files into the PDF. Blocked resources raise ValueError, which
    WeasyPrint catches internally — the resource is skipped with a warning
    instead of failing the render."""
    from weasyprint.urls import URLFetcher

    return URLFetcher(allowed_protocols=("data",))


@router.post("/export/pdf")
def export_pdf(body: PdfExportRequest) -> Response:
    try:
        from weasyprint import HTML
    except Exception as exc:  # noqa: BLE001 — ImportError or missing libpango (OSError)
        log.warning("server-side PDF export unavailable: %s", exc)
        raise HTTPException(
            status_code=501,
            detail="Server-side PDF rendering is not available on this installation.",
        ) from exc
    try:
        pdf = HTML(string=body.html, url_fetcher=_data_only_url_fetcher()).write_pdf()
    except Exception as exc:  # noqa: BLE001 — surface a clean error, not a traceback page
        log.exception("PDF rendering failed")
        raise HTTPException(status_code=500, detail=f"PDF rendering failed: {exc}") from exc

    name = body.filename if body.filename.lower().endswith(".pdf") else body.filename + ".pdf"
    # ASCII fallback for old clients + RFC 5987 UTF-8 name for CJK titles.
    safe = re.sub(r"[^A-Za-z0-9\-. ()]+", "_", name).strip() or "document.pdf"
    disposition = f"attachment; filename=\"{safe}\"; filename*=UTF-8''{quote(name)}"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": disposition},
    )
