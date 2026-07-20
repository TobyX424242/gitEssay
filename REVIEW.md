# gitEssay — Code Review (2026-07-19)

Scope: full review of `backend/` (FastAPI + SQLite + LangGraph agent) and the
self-built layers of `frontend/` (chat, checkpoints, diff, patch, sentinels).
Forked lexical-playground code was reviewed only at its integration points.

Legend: ✅ fixed in this pass · 📌 tracked as tech debt (not fixed) · ⚖️ known
design trade-off (documented, no action).

## What is done well

- The fork boundary is explicit: every self-built file carries a provenance
  header; the STRIP/KEEP/ADAPT catalog in `PLAN.md §3.3` matches reality.
- Checkpoint DAG rules are documented in the `checkpoints.py` docstring and the
  implementation matches it (auto = rolling singleton, manual chains off latest
  durable, `db.flush()` before retention counting).
- Patch machinery (`patch.ts`) separates the read-only decision (`locateEdit`)
  from the mutation (`applyTextPatch`), with validating sentinel reconciliation
  (T4: consume-once pool forbids invented/cloned citations).
- The chat retry lifecycle (LIFO revert, in-place stream, awaited persistence,
  re-entrancy guard) is carefully reasoned and commented.
- SSE generators degrade every failure into an `error` event — a stream never
  dies silently. API keys are masked on read (`has_key` boolean) and never
  logged.
- Tool function bodies `raise NotImplementedError` so they can't be invoked by
  accident outside the tools node.

## 🔴 Critical

| # | Status | Location | Issue |
|---|---|---|---|
| C1 | ✅ | `frontend/src/chat/__tests__/patchValidate.spec.ts` | Working-branch changes made `classifyPatch` return `PatchClassification` but the spec still asserted plain strings → 5 failing tests. Synced to the new API and added coverage for the `invalid` branch and `withPatchFailure`'s `reason` (68 tests green). |
| C2 | ✅ | `backend/app/main.py` (CORS) | `allow_origins=["*"]` with no auth let any website the user visits drive the local backend (read conversations, change settings, burn LLM quota). Now defaults to the local dev origins, overridable via `GITESSAY_CORS_ORIGINS`. (Browser traffic is same-origin anyway: Vite dev proxy / nginx both proxy `/api`.) |

## 🟡 Medium

| # | Status | Location | Issue |
|---|---|---|---|
| M1 | ✅ | `backend/app/ai.py` (`_openai_stream`, `_anthropic_stream`) | `httpx.AsyncClient(timeout=None)` — a hung upstream left the SSE response dangling forever. Now `connect=15s, read=600s` (read window sized for slow reasoning models). |
| M2 | ✅ | `backend/app/routers/conversations.py` | `append_messages` / `replace_message` / `set_edit_state` are read-modify-write over a whole JSON column; concurrent requests (streaming persist racing a retry) lost updates. Wrapped in a process-local lock (proportionate for single-user, single-process). |
| M3 | ✅ | `frontend/src/chat/ChatSidebar.tsx` | `acceptPatch` / `planRetry` didn't check compare mode: `setEditable(false)` doesn't stop programmatic `editor.update`, so a patch could be applied/reverted under the frozen diff view. Both now bail with a notice. |
| M4 | ✅ | `backend/app/routers/projects.py` (`delete_project`) | Deleted Checkpoints/Conversations explicitly but not Memories — relied on the FK-cascade PRAGMA for one child table. Now deletes Memories explicitly too. |
| M5 | ✅ | `backend/app/routers/checkpoints.py` | `created_at` is millisecond-resolution with no tiebreaker — same-ms durable checkpoints made DAG parentage / retention order nondeterministic. Added `id` as secondary sort key. |
| M6 | ✅ | `backend/` (whole) | ~~Zero tests.~~ Added `backend/tests/` (21 tests, pytest + TestClient): checkpoint DAG rules (auto singleton, durable chaining, dedup, retention pruning, restore, cross-project guard), conversation message ops, project cascade (incl. Memory), input whitelists. Run: `uv run pytest`. |
| M7 | 📌 | `backend/app/routers/ai.py:99,121,153`; `backend/app/ai.py:98,124` | Upstream HTTP error bodies (500 chars) are passed through to the browser in 502 details / SSE error events. Usually harmless, but an information-leak surface — consider summarizing status codes only. |
| M8 | ✅ | `backend/app/ai.py:152`, `backend/app/llm.py:45` | ~~`provider_format` is unvalidated~~ Now `Literal["openai", "anthropic"]` in `AISettingsIn` — a typo is a 422 instead of silently speaking the wrong protocol. |
| M9 | 📌 | `backend/app/ai.py:89` | OpenAI path sends `max_tokens` + custom `temperature`; native o-series/gpt-5 endpoints require `max_completion_tokens` and reject custom temperature (400). Compatible gateways are unaffected. |
| M10 | 📌 | `backend/app/agent_graph.py:104-105,141-142` | `agent_node` uses synchronous `invoke`; the SQLAlchemy Session created on the event-loop thread is used from the executor thread (remember tool's commit). Works because nodes run serially, but fragile — prefer `ainvoke` + `async def`. |
| M11 | 📌 | `backend/app/agent_graph.py:161,165` | If the model emits multiple terminal tool calls in one turn, the later one silently overwrites the earlier in `state.terminal`. |
| M12 | 📌 | `backend/app/ai.py:46-57` (`fit_input`) | len/4 token heuristic can truncate the document silently mid-turn; acceptable MVP behavior, but the agent should be told when its input was cut. |
| M13 | ✅ | `frontend/src/chat/ChatSidebar.tsx:227-419` | ~~The finalize/recursive-retry/persist chain has no test.~~ The retry core (what to revert + LIFO order) is extracted to pure functions in `src/chat/retry.ts` (`buildRetryPlan` / `lifoRevertSteps`) with 10 unit tests in `__tests__/retry.spec.ts`. Remaining 📌: the streaming lifecycle (finalize recursion, abort/error ordering) is still only covered indirectly. |
| M14 | 📌 | `frontend/src/utils/api.ts` | No timeout/AbortSignal passthrough; non-204 responses are always `res.json()`-parsed (a 200 with empty body would throw); `post/put/patch` bodies are triplicated. |
| M15 | 📌 | `frontend/src/chat/conversations.ts:171-185`, `useCheckpoints.ts:42`, `App.tsx:122` | Several promise chains have no `.catch` → unhandled rejections (the dev overlay pops) when the backend is down. `memories.ts` does it right — align the rest. |

## 🔵 Low / hygiene

| # | Status | Location | Issue |
|---|---|---|---|
| L1 | ✅ | `frontend/tsconfig.json:17` | ~~`strict: false`~~ `src/chat/` now compiles under **strict mode** via `tsconfig.chat-strict.json` (`npm run typecheck:chat`, 0 errors) — the two violations it surfaced are fixed. Remaining 📌: repo-wide strict still blocked by 6 pre-existing errors in fork files + `llmClient.spec.ts`; extend the strict config per-directory from here. |
| L2 | ✅ | dead code | ~~`parsePatches`~~, ~~`searchInEditor`~~, ~~`callModel`~~, ~~`SYSTEM_PROMPT`/`ACTION_INSTRUCTIONS`~~, ~~`hooks/useReport.ts`~~ all deleted; `@types/diff` removed. Backend unused imports (`agent_graph.py:18`, `models.py:2`) dropped. |
| L3 | 📌 | `frontend/package.json` | `@types/diff` is redundant (`diff@9` ships its own types). Lexical is pinned to a **nightly** (`0.45.1-nightly.20260623.0`) rather than the released tag `PLAN.md §3.2` calls for. No lint config at all. |
| L4 | 📌 | `backend/app/agent_graph.py:18`, `backend/app/models.py:2` | Unused imports (`ai`, `json`). |
| L5 | 📌 | `frontend/src/chat/ChatSidebar.tsx:231-236` | `captureSelection`'s `instruction` param is unused (`void instruction`) — drop it. `:646` comment mentions "F1" (typo, meaning unclear). `:828` closed panel stays focusable under `aria-hidden`. |
| L6 | ✅ | `backend/app/routers/conversations.py` | ~~free strings~~ `set_edit_state`'s state and `CheckpointCapture.source` are now `Literal`-whitelisted (mirroring the frontend unions); `AgentRunRequest.mode` too. Bad values → 422. |
| L7 | 📌 | `frontend/src/ui/CompareMode.tsx` + `diff/tokenize.ts` | Compare basis is structural JSON tokenization, not the Markdown diff `PLAN.md §10.4` confirmed (arguably truer to §4.1). PLAN updated to reflect this. |
| L8 | 📌 | `backend/app/routers/ai.py:96-97` | `except HTTPException: raise` before the generic handler is dead code (`call_model` never raises it). |
| L9 | ⚖️ | `backend/app/agent_tools.py:15` | Full-document reads cap at 24k chars — the agent can't see very long docs whole (search mitigates). Known trade-off. |
| L10 | ⚖️ | `backend/app/models.py:99` | API key stored as plaintext in SQLite — accepted per `PLAN.md §10` (single-user, no auth); masked on all reads. |

## Doc drift (fixed in this pass)

- `PLAN.md` predates the implementation: it says IndexedDB/Dexie (§5/§10.5) but
  a FastAPI + SQLite backend owns persistence; it says "no backend in the MVP"
  but a LangGraph agent already exists; Mode-B diff is structural-JSON, not
  Markdown (§10.4); CitationNode exports `data-citation*` attributes, not
  base64 (§7); lexical is a nightly pin, not a released tag (§3.2). A status
  banner at the top of `PLAN.md` now records this; the body is kept as the
  historical design record.
- `backend/README.md` claimed `POST /agent/run` was a 501 stub and omitted
  `/chat/stream` and the memories endpoints — updated.
- No root `README.md` existed — added (architecture, quick start, testing).

## Suggested next steps (priority order)

1. M7 — stop passing upstream HTTP error bodies through to the browser.
2. M10 — make the agent node async (`ainvoke`) instead of sharing a Session across threads.
3. L1 (remaining) — extend the strict tsconfig to more directories; fix the 6 pre-existing errors.
4. M9 — send `max_completion_tokens` for native OpenAI reasoning models.
5. M13 (remaining) — a component-level test for the streaming finalize lifecycle.

*(2026-07-19 second pass: M6, M8, M13-core, L1-chat, L2, L6 completed above.)*

---

## Addendum — literature/RAG feature pass (2026-07-19)

The literature library (docling ingest, hybrid retrieval, nested subagents,
vision, per-paper notes) landed after this review. Its known trade-offs,
recorded in the same spirit:

| # | Status | Location | Issue |
|---|---|---|---|
| N1 | ⚖️ | `backend/app/literature_search.py` (`_vector_ranking`) | Vector search loads ALL embedded chunks of a project into memory and computes cosine in Python — fine for a personal library (hundreds of papers), not for tens of thousands. Swap in sqlite-vec if it ever shows. |
| N2 | ⚖️ | `backend/app/literature_ingest.py` | Embeddings are computed at ingest only: changing `embedding_model` does not re-embed existing papers (mixed spaces would silently blend). Re-upload to re-embed. |
| N3 | ⚖️ | `backend/app/agent_graph.py` | M10 deepened: nested subagents share the request-scoped SQLAlchemy Session (serial execution makes it safe today); the async-node rewrite (M10) should move each run to its own session. |
| N4 | ⚖️ | `backend/app/agent_graph.py` | Subagent reports are plain text capped at 6k chars — no structured citations back to chunk ids; the parent cites by paper title only. |
| N5 | ⚖️ | `backend/app/literature_ingest.py` | docling parsing is serialized process-wide (one lock) — uploads queue rather than parallelize. Deliberate (torch thread-safety + single-user), but a batch upload parses N× sequentially. |
| N6 | ✅ | `frontend` | ~~The legacy frontend agent loop has no literature tools~~ — resolved: the frontend loop was removed; LangGraph is now the only agent engine. |
