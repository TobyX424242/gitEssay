# gitEssay

A single-user, local-first **AI academic-writing surface** built on a forked
Lexical playground editor. AI edits are never silently applied — the agent
produces **per-hunk accept/reject patches**, and the full document history is a
branchable DAG of named **checkpoints** you can compare and restore. Citations
and equations are atomic nodes: the AI addresses them through opaque sentinel
tokens (`[[CITE:…]]` / `[[EQ:…]]`) that are validated on apply, so they survive
AI edits byte-for-byte.

Upload **reference literature** (PDF/DOCX) and the agent can search, read, and
cite it: documents are parsed by docling (structure-aware chunks + figure
images), indexed for **hybrid RAG** (FTS5 keywords + optional embeddings), and
explored by **nested analysis subagents** the main agent dispatches on demand.

No accounts, no auth, no collaboration — by design (see `PLAN.md §10`).

## Architecture

```
┌──────────────────────────────┐         ┌───────────────────────────────┐
│ frontend (React 19 + Lexical)│  /api   │ backend (FastAPI + SQLite)    │
│                              ├────────►│                               │
│  forked lexical-playground   │  (Vite/ │  projects · checkpoints (DAG) │
│  editor (rich text, tables,  │  nginx  │  conversations · memories     │
│  equations, citations)       │  proxy) │  literature (docling parse →  │
│  chat sidebar + patch apply  │         │  chunks/FTS/embeddings/figures)│
│  checkpoint compare / diff   │         │  LLM gateway (OpenAI/Anthropic│
│  literature library panel    │         │  + LangGraph agent, SSE)      │
└──────────────────────────────┘         └───────────────────────────────┘
```

- **`frontend/`** — a de-demo'd fork of `lexical-playground` (lexical
  `0.45.1-nightly.20260623.0`) plus the self-built layers:
  `src/chat/` (agent loop, patch parse/apply/validate, sentinels),
  `src/checkpoints/` + `src/plugins/CheckpointPlugin.tsx` (auto-save, restore),
  `src/diff/` (checkpoint compare), `src/ui/` (sidebars, compare mode).
- **`backend/`** — FastAPI + SQLite. Owns persistence (the Lexical
  `SerializedEditorState` is stored as opaque JSON — never parsed server-side)
  and acts as the LLM gateway. See `backend/README.md` for the API list.
- The chat sidebar has **two agent engines**: a frontend loop (default) and a
  backend LangGraph loop behind `/api/agent/run`, switchable in the UI. The
  literature tooling below (search/read/figures/subagents) is LangGraph-only.

## Literature & RAG (LangGraph agent)

- **Upload** PDF/DOCX in the left dock's **Literature** tab (picker or
  drag-drop, with a real per-file upload progress bar; the tab also has its
  own app-bar button and edge reopen tab). The backend parses in the
  background with [docling](https://github.com/docling-project/docling):
  structure-aware text chunks (with section headings) and extracted figure
  images. First-ever parse downloads ~500 MB of layout models; the panel
  polls until the item is `ready` (or shows the parse error).
- **Auto-summary**: right after parsing, a bounded map-reduce summarization
  subagent writes a summary of the paper (head + tail + even middle sample —
  bounded input even for book-length documents; ~5 LLM calls; skipped when AI
  is unconfigured, with a Regenerate button). Click a literature item to see
  its summary, the section outline, and a **Download original** button.
- **Hybrid retrieval**: chunks are always indexed in SQLite FTS5 (keyword
  search). Set an **Embedding model** in AI settings (Advanced) — any model on
  the same OpenAI-compatible base URL (`/embeddings`) — and new uploads also
  get vector embeddings; search then fuses both rankings (RRF). Blank =
  keyword-only. (Anthropic-format providers have no embeddings endpoint.)
- **Agent tools**: `list_literature`, `search_literature`, `read_literature`
  (leads with the AI summary, then outline-first navigation), `read_figure`.
  The agent sees paper titles by default (index in its system prompt) and
  digs deeper on demand; it cites sources by title.
- **Vision**: tick **"Model can see images (vision)"** in AI settings and
  `read_figure` attaches the figure image to the model (OpenAI and Anthropic
  formats both handled; images are downscaled). Off = caption/context only.
  Only enable it if your model truly accepts image input.
- **Subagents**: `delegate_task` lets the main agent dispatch nested analysis
  subagents (summarize a paper, compare across papers) — up to **4 layers**
  total (main + 3), with a shared dispatch budget (8/run), per-subagent step
  caps, and no user/document access for subagents. Their activity shows as
  indented chips in the chat.
- **Per-paper memory**: the agent can attach `remember` notes to a specific
  paper (`read_notes` reads them back); they appear grouped by paper in the
  Memory panel and are injected into subagents analyzing that paper. Deleting
  a paper deletes its notes.

### Environment variables

| Var | Default | Purpose |
|---|---|---|
| `GITESSAY_DB` | `gitessay.db` | SQLite path |
| `GITESSAY_DATA_DIR` | dir of the DB | literature originals/figures on disk |
| `GITESSAY_CORS_ORIGINS` | localhost:5180 | extra allowed origins (comma-sep) |
| `HF_HOME` | `~/.cache/huggingface` | docling layout-model cache (~500 MB) |

## Quick start (dev)

```bash
# backend → http://localhost:8000
cd backend && uv sync
uv run uvicorn app.main:app --reload --port 8000

# frontend → http://localhost:5180 (proxies /api → :8000)
cd frontend && npm ci && npm run dev
```

Then open http://localhost:5180 and configure your LLM provider in the chat
sidebar's settings panel (key is stored server-side, masked on read).

## Quick start (docker)

```bash
docker compose up --build     # → http://localhost:5180
```

SQLite data (including the AI key) lives in the `gitessay-data` named volume,
along with uploaded literature files. The backend is internal-only; nginx
proxies `/api` to it. Note the backend image is ~3.8 GB (CPU-only PyTorch for
docling + the pre-downloaded layout models, all warmed up at build time).

## Tests

```bash
cd frontend && npm test                  # vitest — patch/sentinel/agent-loop/retry suites
cd frontend && npm run typecheck:chat    # strict-mode tsc over src/chat/ (see REVIEW.md L1)
cd backend && uv run pytest              # checkpoints, conversations, literature, agent tools
GE_TEST_DOCLING=1 uv run pytest          # incl. the real-docling parse smoke test (downloads models)
```

## Docs

- `README.md` (this file) — current state, quick start.
- `PLAN.md` — the original v2 design plan (historical; a banner at the top
  records where the implementation diverged).
- `REVIEW.md` — 2026-07 code review: findings, fixes applied, tech-debt list.
- `backend/README.md` — backend API reference.
- `docker-compose.yml` — one-command local stack.
