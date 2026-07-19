# gitEssay backend

FastAPI + SQLite backend that owns persistence (projects / checkpoints /
conversations) and acts as the LLM gateway (keys server-side). Single-user,
no auth (PLAN §10).

## Run

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload --port 8000
```

The DB file is `backend/gitessay.db` (override with `GITESSAY_DB=path.db`).
On first start it creates the tables and seeds a **Default** project (with an
empty-doc `init` checkpoint) and a default AI-settings row. Lightweight
column migrations run at startup (`app/main._migrate`), as does the FTS5
table for literature search. Uploaded literature files live under
`<GITESSAY_DATA_DIR or DB dir>/literature/{id}/`.

> If you edit Python and see stale behaviour on this bind-mount, run with
> `PYTHONDONTWRITEBYTECODE=1 uv run uvicorn ...` (the mount's mtime can leave
> stale `.pyc` files).

## API (all under `/api`)

- **Projects**: `GET/POST /projects`, `GET/PATCH/DELETE /projects/{id}`
- **Checkpoints**: `GET /projects/{pid}/checkpoints`, `POST` (capture — owns the
  DAG: auto = rolling singleton `<pid>::auto`, manual = chains off latest durable
  + clears the auto slot), `POST /projects/{pid}/checkpoints/{cid}/restore`,
  `GET /projects/{pid}/current`
- **Conversations**: `GET /projects/{pid}/conversations`, `POST` (create), `PATCH
  /conversations/{id}`, `DELETE`, `POST /projects/{pid}/conversations/active`;
  granular message ops `POST /conversations/{id}/messages` (append),
  `PUT /conversations/{id}/messages/{mid}` (replace — retry),
  `PATCH /conversations/{id}/messages/{mid}/edits/{idx}` (accept/reject state)
- **Memories** (agent notes; optionally scoped to one literature item):
  `GET/POST /projects/{pid}/memories` (GET filters with `?literature_id=`),
  `DELETE /memories/{mid}`
- **Literature** (uploaded references; docling-parsed in the background):
  `POST /projects/{pid}/literature` (multipart upload, PDF/DOCX ≤ 50 MB →
  `processing` row), `GET /projects/{pid}/literature` (list + status/counts —
  poll while parsing), `GET /literature/{lid}` (detail: outline + images +
  summary), `GET /literature/{lid}/download` (original file),
  `POST /literature/{lid}/summary` (regenerate the AI summary),
  `GET /literature/{lid}/images/{seq}` (PNG), `DELETE /literature/{lid}`
  (removes chunks/FTS rows/images/files/attached notes). Parse pipeline:
  docling → structure-aware chunks (+ FTS5 rows; + embeddings when an
  `embedding_model` is set on an OpenAI-format provider) + figure images;
  then a bounded map-reduce summarizer (`literature_summary.py`) auto-writes
  the paper summary (head+tail+even-sample selection, ~5 LLM calls,
  book-length safe; `skipped` when AI is unconfigured).
- **AI**: `POST /chat` `{system,user}`→`{content}` (blocking, uses server
  settings), `POST /chat/stream` (SSE; normalized
  `{type: thinking|text|done|error}` events), `GET/PUT /ai/settings` (key masked
  on read; `api_key=null` keeps existing; capability flags `vision_capable`
  and `embedding_model` live here), `POST /ai/test`,
  `POST /agent/run` (SSE; LangGraph ReAct agent — the backend owns the
  tool loop: read/search the document, list/search/read literature +
  read_figure (multimodal when vision is on), remember/read_notes,
  delegate_task (nested subagents, ≤4 layers, shared budgets), and the
  terminal ask_user/propose_patch (main agent only))

The Lexical `SerializedEditorState` is stored as opaque JSON (the backend never
parses it). The Vite dev server proxies `/api` → `http://localhost:8000`
(`frontend/vite.config.ts`).

## Tests

```bash
uv run pytest                        # checkpoints, conversations, literature, agent tools/subagents/vision
GE_TEST_DOCLING=1 uv run pytest      # + real-docling parse smoke (downloads ~500 MB of models once)
```
