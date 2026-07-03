# gitEssay backend — FastAPI + SQLite, dependencies managed with uv.
#
#   docker build -t gitessay-backend ./backend
#   docker run -p 8000:8000 -v gitessay-data:/app/data gitessay-backend
#
# The SQLite file lands at /app/data/gitessay.db (set via GITESSAY_DB) so it can
# be backed by a named volume and survive rebuilds.
FROM python:3.12-slim

# uv binary, pinned to the version the lock was generated with (0.9.5).
COPY --from=ghcr.io/astral-sh/uv:0.9.5 /uv /uvx /usr/local/bin/

# Project venv lives at /app/.venv; deps are copied into the image (no bind
# mounts). Put the venv on PATH so we can invoke `uvicorn` directly (no `uv run`
# re-sync at runtime). Unbuffered logs so `docker logs` streams live.
ENV UV_PROJECT_ENVIRONMENT=/app/.venv \
    UV_LINK_MODE=copy \
    PATH="/app/.venv/bin:$PATH" \
    PYTHONUNBUFFERED=1

WORKDIR /app

# Install dependencies first → this layer is cached unless pyproject/lock change.
# --no-install-project: only the locked deps are installed; the `app` package is
# imported from CWD at runtime, so the project is never built (no build-system
# needed).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

# Application source + the volume mount point for SQLite.
COPY app ./app
RUN mkdir -p /app/data

EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
