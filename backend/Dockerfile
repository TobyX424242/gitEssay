# gitEssay backend — FastAPI + SQLite + docling literature parsing, deps via uv.
#
#   docker build -t gitessay-backend ./backend
#   docker run -p 8000:8000 -v gitessay-data:/app/data gitessay-backend
#
# The SQLite file lands at /app/data/gitessay.db (set via GITESSAY_DB) so it can
# be backed by a named volume and survive rebuilds; uploaded literature files
# and the docling model cache (HF_HOME) live under the same volume.
# NOTE: docling needs PyTorch — pinned to CPU-only wheels (see pyproject.toml),
# which keeps the image at ~3.8 GB instead of ~12+ GB with CUDA runtimes.
FROM python:3.12-slim

# uv binary, pinned to the version the lock was generated with (0.9.5).
COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /uvx /usr/local/bin/

# Project venv lives at /app/.venv; deps are copied into the image (no bind
# mounts). Put the venv on PATH so we can invoke `uvicorn` directly (no `uv run`
# re-sync at runtime). Unbuffered logs so `docker logs` streams live.
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1 \
    HF_HUB_OFFLINE=1
# HF_HUB_OFFLINE=1: docling's models are pre-downloaded at build time (below),
# so the runtime never phones HuggingFace — a blocked/slow HF endpoint would
# otherwise fail PDF parses with RemoteProtocolError on its etag checks.

WORKDIR /app

# Install dependencies first → this layer is cached unless pyproject/lock change.
# --no-install-project: only the locked deps are installed; the `app` package is
# imported from CWD at runtime, so the project is never built (no build-system
# needed).
COPY pyproject.toml uv.lock ./
# --no-cache: don't leave a full second copy of every wheel in /root/.cache/uv
# (UV_LINK_MODE=copy means the venv is already self-contained — the cache would
# duplicate ~5 GB into the image for zero runtime benefit).
RUN uv sync --frozen --no-install-project --no-dev --no-cache

# docling's table-structure model imports cv2 (full opencv-python, not
# headless), which needs these system libs that python:*-slim omits — without
# them every PDF fails with "ImportError: libxcb.so.1".
RUN apt-get update \
    && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 libxcb1 \
    && rm -rf /var/lib/apt/lists/*

# Bake ALL docling models into the image via a REAL warm-up conversion with the
# same pipeline options used at runtime. (`docling-tools models download` alone
# misses lazily-fetched snapshots; with HF_HUB_OFFLINE=1 above, anything not in
# the cache fails the parse.)
#
# The warm-up DOWNLOADS ~500 MB of models from HuggingFace at build time, so it
# must survive flaky networks: the script retries 3× with backoff (HF resumes
# partial downloads), and the RUN falls back to the hf-mirror.com endpoint if
# the default endpoint keeps failing. Override the primary endpoint with
#   docker compose build --build-arg HF_ENDPOINT=https://hf-mirror.com
# (NOTE: no default value on the ARG — Docker injects declared ARGs as env into
# RUN, and an EMPTY HF_ENDPOINT breaks huggingface_hub with UnsupportedProtocol.)
ARG HF_ENDPOINT
RUN cat > /tmp/warmup.py <<'PY'
import os
import time

# Sanitize: an empty HF_ENDPOINT (e.g. from a Docker ARG) is worse than none —
# huggingface_hub builds protocol-less URLs from it (UnsupportedProtocol).
if not os.environ.get("HF_ENDPOINT"):
    os.environ.pop("HF_ENDPOINT", None)

objs = [
    b"<</Type/Catalog/Pages 2 0 R>>",
    b"<</Type/Pages/Kids[3 0 R]/Count 1>>",
    b"<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>",
    b"<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>",
]
stream = b"BT /F1 14 Tf 72 720 Td (warmup) Tj ET"
objs.append(b"<</Length %d>>stream\n" % len(stream) + stream + b"\nendstream")
out = b"%PDF-1.4\n"
offsets = []
for i, o in enumerate(objs, 1):
    offsets.append(len(out))
    out += b"%d 0 obj\n" % i + o + b"\nendobj\n"
xref = len(out)
out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objs) + 1)
for off in offsets:
    out += b"%010d 00000 n \n" % off
out += b"trailer\n<</Size %d/Root 1 0 R>>\nstartxref\n%d\n%%%%EOF\n" % (len(objs) + 1, xref)
open("/tmp/warmup.pdf", "wb").write(out)

from docling.datamodel.base_models import InputFormat
from docling.datamodel.pipeline_options import PdfPipelineOptions
from docling.document_converter import DocumentConverter, PdfFormatOption

opts = PdfPipelineOptions()
opts.generate_picture_images = True
opts.images_scale = 2.0
converter = DocumentConverter(
    format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=opts)}
)
endpoint = os.environ.get("HF_ENDPOINT") or "https://huggingface.co"
for attempt in range(1, 4):
    try:
        converter.convert("/tmp/warmup.pdf")
        print(f"docling warm-up conversion complete — all models cached (via {endpoint})")
        break
    except Exception as e:  # noqa: BLE001
        print(f"warm-up attempt {attempt}/3 failed: {type(e).__name__}: {e}", flush=True)
        if attempt == 3:
            raise
        time.sleep(15)
PY
RUN HF_HUB_OFFLINE=0 HF_HUB_ETAG_TIMEOUT=30 HF_HUB_DOWNLOAD_TIMEOUT=60 \
      python /tmp/warmup.py \
    || { echo "warm-up failed on the default endpoint — retrying via hf-mirror.com"; \
         HF_HUB_OFFLINE=0 HF_ENDPOINT="https://hf-mirror.com" \
         HF_HUB_ETAG_TIMEOUT=30 HF_HUB_DOWNLOAD_TIMEOUT=60 \
         python /tmp/warmup.py; }

# Application source + the volume mount point for SQLite.
COPY app ./app
RUN mkdir -p /app/data

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
