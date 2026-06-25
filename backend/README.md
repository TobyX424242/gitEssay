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
empty-doc `init` checkpoint) and a default AI-settings row.

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
- **AI**: `POST /chat` `{system,user}`→`{content}` (uses server settings),
  `GET/PUT /ai/settings` (key masked on read; `api_key=null` keeps existing),
  `POST /ai/test`, `POST /agent/run` (501 stub — future LangGraph)

The Lexical `SerializedEditorState` is stored as opaque JSON (the backend never
parses it). The Vite dev server proxies `/api` → `http://localhost:8000`
(`frontend/vite.config.ts`).
