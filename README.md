# gitEssay

A single-user, local-first **AI academic-writing surface** built on a forked
Lexical playground editor. AI edits are never silently applied — the agent
produces **per-hunk accept/reject patches**, and the full document history is a
branchable DAG of named **checkpoints** you can compare and restore. Citations
and equations are atomic nodes: the AI addresses them through opaque sentinel
tokens (`[[CITE:…]]` / `[[EQ:…]]`) that are validated on apply, so they survive
AI edits byte-for-byte.

No accounts, no auth, no collaboration — by design (see `PLAN.md §10`).

## Architecture

```
┌──────────────────────────────┐         ┌───────────────────────────────┐
│ frontend (React 19 + Lexical)│  /api   │ backend (FastAPI + SQLite)    │
│                              ├────────►│                               │
│  forked lexical-playground   │  (Vite/ │  projects · checkpoints (DAG) │
│  editor (rich text, tables,  │  nginx  │  conversations · memories     │
│  equations, citations)       │  proxy) │  LLM gateway (OpenAI/Anthropic│
│  chat sidebar + patch apply  │         │  + LangGraph agent, SSE)      │
│  checkpoint compare / diff   │         │  API key lives server-side    │
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
  backend LangGraph loop behind `/api/agent/run`, switchable in the UI.

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

SQLite data (including the AI key) lives in the `gitessay-data` named volume.
The backend is internal-only; nginx proxies `/api` to it.

## Tests

```bash
cd frontend && npm test                  # vitest — patch/sentinel/agent-loop/retry suites
cd frontend && npm run typecheck:chat    # strict-mode tsc over src/chat/ (see REVIEW.md L1)
cd backend && uv run pytest              # checkpoint DAG/retention, conversations, validation
```

## Docs

- `README.md` (this file) — current state, quick start.
- `PLAN.md` — the original v2 design plan (historical; a banner at the top
  records where the implementation diverged).
- `REVIEW.md` — 2026-07 code review: findings, fixes applied, tech-debt list.
- `backend/README.md` — backend API reference.
- `docker-compose.yml` — one-command local stack.
