# AI-Agent Academic Writing Assistant — Implementation Plan (v2: Playground-first)

> **What changed from v1.** v1 planned to build the Lexical rich-text frontend **from
> scratch** (hand-written `CitationNode`/`MathNode`, a custom editor shell). That path means
> reimplementing dozens of plugins/nodes and racing upstream — the complexity you flagged.
> **v2 instead forks Meta's official `packages/lexical-playground`** as the editor base and
> inherits, for free: complete rich-text editing, Markdown/HTML/JSON import–export, special-content
> insertion (equations, images, tables…), Lexical's signature **state tree**, and — crucially — a
> **working checkpoint + diff prototype** (`VersionsPlugin`). On that base we build the two things
> this project actually differentiates on: a **tree-based diff comparison system** and a
> **checkpoint/version system**. The v1 "heavy machinery" (LangGraph orchestrator, MCP gateway,
> browser automation, RAG, deep-parse) is pushed to **post-MVP, purely additive** phases.


---

## 1. Vision & Core Problem

Build a **Human-AI collaborative academic-writing surface** that solves the "black-box AI" problem:
AI edits are never silently applied — they appear as **inspectable, per-hunk accept/reject diffs**,
and the full document history is a **branchable, comparable, restorable set of checkpoints**.

Three guiding goals (refocused from v1):

1. **Never lose control** — every AI edit is a visible diff; the doc only changes when you accept.
2. **Versioning is first-class** — checkpoints are not "undo history", they are a version DAG you
   can name, branch, compare, and restore (like git for prose).
3. **Academic content is protected** — citations and math survive AI edits byte-for-byte; they are
   atomic, indivisible nodes.

The editor is the product. Everything else (agents, retrieval, browser) feeds edits *through* the
editor's diff + checkpoint machinery.

## 2. Why fork the playground (the core architectural decision)

The official `lexical-playground` (lexical **0.45.0**) is a production-grade Lexical application that
already implements ~90% of the editing surface this project needs:

- **Full rich text**: headings, paragraphs, quotes, lists, check-lists, tables (+ resize/hover/nested),
  code blocks w/ syntax highlighting, horizontal rule, collapsible sections, page break, images,
  draggable block handles, floating text-format & link toolbars, context menu, table-of-contents.
- **Special content insertion**: inline/block **LaTeX equations** (KaTeX, `$…$` / `$$…$$`), images,
  embeds.
- **Import / Export**: Markdown, HTML, JSON editor-state, shareable URL hash (gzip+base64); paste
  from Word/Google Docs via the DOM importer.
- **Lexical's signature tree**: a live `TreeView` debug pane + canonical
  `editor.getEditorState().toJSON()`.
- **A checkpoint + diff prototype**: `VersionsPlugin` (Yjs snapshots + an inline green/red diff view
  with compare/restore) — the direct ancestor of our checkpoint system.
- **Collaboration** (present in playground, **stripped** — single-user app): `@lexical/yjs` +
  `y-websocket` wiring is removed wholesale (§10).

Crucially, the playground uses the **modern, stable `@lexical/extension` API** —
`defineExtension` / `LexicalExtensionComposer` / `configExtension` — which has been
**formally stable since lexical v0.36.1 (Sep 2025)** and is on npm. Under this API the editor is
composed from two short **dependency arrays**, one **node array**, and one **theme object**. That
means **stripping, adding, and adapting features is surgical** — you edit lists, you do not rewrite
engines. This is precisely the "reuse reliable complete code and build on top" property the project
needs, and it de-risks v1's single biggest fear (building the editor from scratch).

**The fork thesis:** own a trimmed copy of the playground source; inherit battle-tested editor code;
merge upstream fixes by tracking lexical release tags; spend our effort on diff + checkpoint, not on
reimplementing rich text.

## 3. Reuse strategy — what we fork, strip, and adapt

### 3.1 The three surgical edit points

Everything in the playground's editor is reachable through three lists (plus the theme). Our
customization is confined to them:

| Edit point | File (in forked playground) | What it controls |
|---|---|---|
| **Always-on extensions** | `src/App.tsx` → `AppExtension.dependencies` | History, links, hashtags, selection, import pipeline, DOM-render overrides, … |
| **Rich-text extensions** | `src/App.tsx` → `PlaygroundRichTextExtension.dependencies` | Tables, images, equations, lists, code, collapsible, page-break, markdown shortcuts, … |
| **Registered nodes** | `src/nodes/PlaygroundNodes.ts` | The `Klass<LexicalNode>[]` array fed to `AppExtension.nodes` |
| **Theme** | `src/themes/PlaygroundEditorTheme.ts` (+ `.css`) | Class-name map → CSS |

Adding `CitationNode` = append one entry to `PlaygroundNodes`, add one extension to
`PlaygroundRichTextExtension.dependencies`. Removing polls/tweets = delete three deps and three node
entries. The composition model is the asset.

> Note: in upstream only `isCollab`, `emptyEditor`, `isRichText` rebuild the editor (the
> `DynamicSettings` memo in `App.tsx`); everything else (table behavior, link attrs, char limits…) is
> applied **reactively** via `useSyncExtensionSignal` in `Editor.tsx`. In our fork we **delete
> `isCollab`** (no collab — §10), so only `emptyEditor`/`isRichText` remain. Keep this discipline — do
> not add new editor-rebuild settings.

### 3.2 Vendoring decision — **confirmed: Option A** *(2026-06-23)*

**Fork `packages/lexical-playground/src`** into `frontend/src/editor/`, and pin the lexical monorepo to
a **single released npm tag** (0.45.x), installing `lexical` + the needed `@lexical/*` packages from
npm. Retarget the playground's `workspace:*` dependency specifiers to that pinned version. This gives
us full ownership of the editor source while inheriting upstream releases.

| Option | Pros | Cons |
|---|---|---|
| **A. Fork playground `src` + npm lexical (recommended)** | Owns editor code; clean upgrade path; small footprint | Must resolve a few `workspace:*`-only internal deps (e.g. `@lexical/internal`) — verify each `@lexical/*` import resolves on npm at the pinned tag |
| B. Subtree the entire lexical monorepo at a tag | Zero resolution surprises; can patch lexical itself | Large repo; heavier upgrades; temptation to fork lexical core |
| C. Copy plugins piecemeal into a fresh app | Smallest diff | Fragile; defeats "reuse complete reliable code"; hard to upgrade — **not recommended** |

### 3.3 Keep / Strip / Adapt catalog

Condensed from a full audit of every plugin/extension in `lexical-playground/src/`.

**KEEP (core academic surface — inherit verbatim):**
RichText, History(undo/redo), List, CheckList, Table (+ TableActionMenu, TableCellResizer,
TableScrollShadow, TableHoverActions, TableFitNested), Images, **Equations (KaTeX)**, PageBreak,
HorizontalRule, Collapsible, CodeHighlight, MarkdownShortcuts, TabFocus, Link + AutoLink +
ClickableLink, FloatingLinkEditor, FloatingTextFormatToolbar, DraggableBlock, CodeActionMenu,
ContextMenu, TableOfContents, TabIndentation, Shortcuts, ComponentPicker (filtered), ToolbarPlugin
(trimmed), TreeView (dev-only, gated).

**STRIP (demo / gimmick / dev-only — delete deps + nodes + UI):**
Poll, Tweet, YouTube, Figma, Excalidraw, Sticky, Emoji(+picker), Mentions (Star-Wars demo data),
SpeechToText, TestRecorder, TypingPerf, PasteLog, DocsPlugin (sample loader), MaxLength/
CharacterLimit (5-char demo), Keyword, DateTime, SpecialText, VisibleNonPrinting, Autocomplete,
PullQuote, Review, Card/Slot, Layout (columns), Pages (multi-page split), Hashtag (social), the
`split/` two-iframe collab harness, and — **because this is a single-user app with no realtime
collaboration (§10)** — the **entire Yjs/collab cluster**: `@lexical/yjs`, `yjs`, `y-websocket`,
`collaboration.ts`, `LexicalCollaboration` / `CollaborationPlugin` (+V2), `CommentPlugin`
(collab-backed), `VersionsPlugin` (Yjs-coupled — **deleted**, kept only as a *design reference* for
§5/§6), and the `isCollab`/`useCollabV2` settings. Removing this cluster deletes a whole dependency
tree and the entire T1 risk class (§9).

**ADAPT (keep the engine, replace the demo UI/behavior):**
- `ToolbarPlugin` — keep formatting controls; **strip Insert-menu gimmicks** (GIF, Excalidraw, Poll,
  Columns, Sticky, Date, Tweet/YouTube/Figma); keep HR, PageBreak, Image, Table, Equation,
  Collapsible.
- `ActionsPlugin` — replace demo buttons (Import/Export/Share/Markdown-mode) with our actions
  (**Save checkpoint · Compare · AI edit · Export**), reusing its import/export *functions*.
- `ComponentPickerPlugin` — keep the slash menu, remove social/embed items.
- `Settings.tsx` / `appSettings.ts` — replace the demo settings panel with a minimal prefs surface
  (or remove); collapse most `DEFAULT_SETTINGS` flags to fixed values.
- `$prepopulatedRichText` (the "Welcome to the playground" doc) — replace with an academic template or
  empty doc.
- Header / GitHub-corner / logo — replace with our app chrome.
- `PlaygroundEditorTheme` — rebrand (see §3.4).

### 3.4 Rebranding the theme

`PlaygroundEditorTheme.ts` is a plain class-name map; `PlaygroundEditorTheme.css` (~1k lines) holds
the styles. **Keep the `PlaygroundEditorTheme__` class prefix** — `TerseExportExtension` strips
exactly that prefix for clean exports, so changing it would break LLM-friendly export. Rebrand by
introducing `:root` CSS custom properties (colors, fonts) and replacing the hardcoded `rgb()`/
`font-family` literals, or a one-time `sed` pass. Decorator nodes (image/equation/our citation) own
their own DOM and are styled in `src/index.css` next to `.editor-equation`.

## 4. The Tree as canonical state (foundation for diff + checkpoint)

This section is the linchpin: **the lexical JSON state is the single source of truth** that both
diff and checkpoint are built on.

- **Canonical serialization:** `editor.getEditorState().toJSON()` → a `SerializedEditorState` (a
  `root` node tree + `selection`). Round-trips losslessly via `editor.parseEditorState(json)` +
  `setEditorState`. **This — not the pretty tree string the `TreeView` shows — is our diff/checkpoint
  basis.** The `TreeView` pane stays as a dev/debug affordance only.
- **Commit hook:** `editor.registerUpdateListener(({editorState, dirtyLeaves, dirtyElements}) => …)`
  is the canonical "a transaction just committed" signal — this is where auto-checkpointing and
  diff-basis snapshotting attach.
- **Import/export surface we inherit:**
  - Markdown: `$convertToMarkdownString(PLAYGROUND_TRANSFORMERS)` /
    `$convertFromMarkdownString(…)` (`@lexical/markdown`; transformers in
    `src/plugins/MarkdownTransformers/`).
  - HTML: `$generateHtmlFromNodes(editor)` / `$generateNodesFromDOMViaExtension(dom)` (`@lexical/html`).
  - JSON/file: `importFile` / `exportFile` / `serializedDocumentFromEditorState` /
    `editorStateFromSerializedDocument` (`@lexical/file`); share-hash in `src/utils/docSerialization.ts`.
  - Clean-HTML-for-LLM: `TerseExportExtension` + `RenderContextTerse` + `$withRenderContext` — the
    template for a future plain-text/LLM export path.
- **Per-node import/export rules (the extension pattern to copy for new nodes):**
  - Import: `defineImportRule({$import, match: sel.tag(...).attr(...), name})` +
    `configExtension(DOMImportExtension, {rules})` (see `EquationsExtension`).
  - Export override: `domOverride([NodeClass], {$exportDOM})` +
    `configExtension(DOMRenderExtension, {overrides})` (see `TerseExportExtension`).

### 4.1 ⚠️ Critical constraint: NodeKeys are NOT a cross-snapshot identity

The base `SerializedLexicalNode` carries only `{type, version, …state}` — **it does not serialize the
runtime `NodeKey`** (verified in `lexical/src/LexicalNode.ts`). `parseEditorState` therefore
**regenerates keys**. Consequence: **you cannot diff two independently stored snapshots by NodeKey** —
the "same" paragraph has different keys in two snapshots. Diffing must be **content/position based**
(flatten to text/Markdown and diff that) or **structural** (match by type + content + tree position).
This single fact shapes the entire diff design (§6) and is easy to get wrong.

## 5. Core system A — Checkpoint / version system

A checkpoint is a named, restorable point in the document's history, stored as the canonical JSON
tree, organized as a **DAG** (each checkpoint records its parent) so history can branch and any two
points can be compared.

- **Data model:**
  ```
  Checkpoint {
    id, docId, parentId,              // parentId → version DAG
    schemaVersion, lexicalVersion,    // migration guard — see T9
    state: SerializedEditorState,     // the canonical JSON tree
    markdown: string,                 // precomputed flat snapshot (diff basis + cheap restore preview)
    createdAt, label?, source         // source ∈ {manual, auto, ai-accept, restore}
  }
  ```
- **Triggers:** (a) **manual** — user action; (b) **on AI-accept** — an accepted diff becomes a
  checkpoint automatically; (c) **auto** — `registerUpdateListener` debounced/throttled (e.g. on idle
  or every N commits / every M seconds; prune aggressively — see D2).
- **Storage:** **IndexedDB** (e.g. Dexie) — the long-term home for a single-user local app; no
  backend required. A later phase may add an optional sync/backup target (exportable archive or an
  optional server) **behind the same `CheckpointStore` interface** — but never for multi-user/auth,
  which the app does not need.
- **Restore:** `editor.parseEditorState(checkpoint.state)` + `editor.setEditorState(…)`. Restoring
  creates a *new* child checkpoint (branch), preserving history — never overwrites.
- **What we reuse / what we replace:** `VersionsPlugin`'s *UX* (snapshot-list modal, "show changes
  since selected version") is our design template, but the plugin itself is **deleted** (Yjs-coupled;
  won't build once `@lexical/yjs` is stripped) — we rebuild the checkpoint list/compare UI on the JSON
  model. `@lexical/file`'s `serializedDocumentFromEditorState` envelope is our serialization wrapper.
  No CRDT, no shared doc → the v1 T1 three-way fight does not exist.

## 6. Core system B — Diff comparison system (two modes)

Two related but distinct diff needs, sharing infrastructure.

### Shared infrastructure
- **Tree↔text flatten** with **placeholder tokenization** (v1 T4): serialize atomic nodes
  (citations, equations) to opaque, collision-resistant sentinels before diffing; **validating
  reconciliation** on restore (every input sentinel appears exactly once unless an authorized delete;
  unknown sentinels → hard reject). This is the safety mechanism for academic content.
- **Myers/word-level diff core** (start in-process TS; promote to Rust only when profiled — v1 T8).
- **Diff-render primitive**: borrow `VersionsPlugin`'s proven technique —
  `editor.registerMutationListener(TextNode, …)` + per-node style (green bg for added,
  strikethrough for removed) — rebased onto our own diff markers instead of Yjs `$getYChangeState`.

### Mode A — AI-suggestion diff (inline accept/reject) — the headline feature
- **Contract (v1 T2, settled):** the LLM returns **new plain text for a bounded, identified region**
  (with restored placeholders) — *not* a JSON patch. We compute the diff **deterministically,
  client-side**.
- **Flow:** identify the region (selection / block) → flatten its text with placeholders → diff old
  vs new → render added/removed via the diff-render primitive **over a cloned subtree** (v1 T1
  mitigation: the pending suggestion never touches the live doc) → on **accept**, commit the merged
  subtree into the real editor (and auto-checkpoint); on **reject**, discard the clone.
- **Tree legality (v1 T3):** constrain the diff to a **single region** so hunks never cross node
  boundaries. Structural AI edits (merge/split paragraphs) are a separate, coarser "replace whole
  block" operation, never a char-diff.

### Mode B — Checkpoint / version compare
- **Compare any two checkpoints** A and B.
- **Basis (confirmed: Markdown diff):** flatten both states to **Markdown**
  (`$convertToMarkdownString` with `PLAYGROUND_TRANSFORMERS`) and char/word-diff — robust to NodeKey
  churn (§4.1) and reuses the playground's existing serializer. Then **map hunks back to tree
  positions** for navigation (best-effort by text-match; structural info is for navigation only, never
  the diff basis).
- **UX:** split or unified view; click a hunk → scroll-to & highlight the node in the editor. Reuse
  `VersionsPlugin`'s compare-mode toggle (`editor.setEditable(false)` during compare) as a pattern.
- **Backend path (later):** `@lexical/headless` lets a server parse/operate on JSON states with no
  DOM — run the heavy diff server-side for large docs.

### Relation to the playground's `VersionsPlugin`
It ships a working snapshot+diff, but it is **Yjs-coupled** (opaque Yjs snapshots) and uses
**experimental** commands (`DIFF_VERSIONS_COMMAND__EXPERIMENTAL`, `CollaborationPluginV2__EXPERIMENTAL`).
Since we strip all Yjs, the plugin is **deleted from our fork** and used only as a *design reference*:
we borrow its UX (snapshot list + compare toggle, `editor.setEditable(false)` during compare) and its
diff-rendering technique (`registerMutationListener(TextNode)` + per-node style) and **rebase them onto
JSON checkpoints** — clean DAG, no CRDT, no experimental APIs in our critical path.

## 7. Special content nodes (academic)

- **EquationNode (math) — KEEP as-is.** One node with an `__inline` flag; KaTeX; `INSERT_EQUATION_COMMAND`;
  inline `$…$` / block `$$…$$` via markdown transformers; **byte-for-byte HTML survival** via base64
  `data-lexical-equation`. This is exactly the academic-math primitive we need, already complete.
- **CitationNode (NEW) — build, mirroring EquationNode.** A `DecoratorNode` that is **atomic and
  indivisible** (`isIsolated(): true`, no internal editable text, `isInline()`), rendering a citation
  marker (e.g. `[1]`). Implementation checklist:
  - `getType()='citation'`, `static clone`, `exportJSON`/`importJSON` round-trip `citationId`;
  - `exportDOM()` base64-encodes into `data-lexical-citation` (byte-for-byte survival, EquationNode
    pattern) + a `CitationImportRule` (`defineImportRule`, `sel.tag('span').attr('data-lexical-citation')`);
  - `INSERT_CITATION_COMMAND` + `CitationsExtension` added to `PlaygroundRichTextExtension.dependencies`;
  - a Markdown transformer emitting/re-consuming a placeholder;
  - placeholder tokenization so the LLM sees `[CITE_7f3a]`-style opaque sentinels, not guessable
    `[1]` (v1 T4).
- A bibliography/reference manager is **post-MVP**; the node is designed to hold a stable reference
  id now so a manager can attach later without a schema break.

## 8. Revised phased roadmap (MVP-first)

> **MVP = Phase 0 → 4.** It is deliberately **almost entirely frontend** — a forked, de-demo'd
> playground editor + JSON checkpoints + tree diff + one real AI edit. No orchestrator, no MCP, no
> backend in the MVP. This is v1's "thinner first slice" (T11), now actually achievable because we
> don't have to build the editor.

**Phase 0 — Vendor & de-demo the playground.** Fork `src/`, pin lexical, retarget deps, get it
building as `frontend/`. Delete STRIP plugins/nodes, trim ADAPT UI, rebrand theme, replace welcome
doc + chrome. *Deliverable:* a clean, branded rich-text editor that imports/exports
Markdown/HTML/JSON. **De-risk:** validates the vendoring decision (§3.2) before any feature work.

**Phase 1 — Tree plumbing + checkpoint MVP.** `registerUpdateListener` commit hook → JSON snapshot →
IndexedDB `CheckpointStore` → `VersionsPlugin`-style list UI → restore (creates a child checkpoint).
*Deliverable:* save/restore named checkpoints locally; the tree is the source of truth.

**Phase 2 — CitationNode + atomic-node hardening.** Add `CitationNode` per §7; adversarially test
that cursor/delete/merge operations cannot split it or equations; implement placeholder
flatten/restore with validating reconciliation (T4). *Deliverable:* protected academic elements +
correct plain-text export for the LLM.

**Phase 3 — Diff system.** Build shared infra (flatten+placeholders, Myers, render primitive). Ship
**Mode B (checkpoint compare) first** (no live typing → lowest risk), then **Mode A (AI suggestion
accept/reject)** via the cloned-subtree approach. *Deliverable:* compare any two checkpoints;
accept/reject an inline AI diff.

**Phase 4 — AI integration (thin).** Wire one action ("rewrite this paragraph") → region plain text
→ LLM → Mode A diff. A **single hardcoded call**, no orchestrator/gateway (T11). *Deliverable:*
end-to-end AI-edit-with-accept/reject.

**Phase 5 — Optional backend / heavy compute (personal-use shape).** No accounts/auth (single-user).
Two optional additions, each behind the interfaces built in Phases 1–3: (a) an **optional
sync/backup** target for `CheckpointStore` (exportable archive, or an optional local/remote server);
(b) a **Rust diff core** (`@lexical/headless` server-side diff for very large docs) promoted from the
in-process TS diff only if profiling demands it. *(Reconciles with the project memory that referenced a
maturin/Rust `_diff_native` core — §11: current repo is greenfield; if that core is reintroduced, it
slots behind the in-process interface defined in Phase 3.)*

**Phase 6 — LangGraph orchestrator + Tool/MCP gateway.** Replace the Phase-4 hardcoded call with a
state machine (`think → retrieve → draft → edit → pause(HIL)`); MCP-ready gateway interface (v1
§3). Skills framework, Fast Path RAG, Deep Path subagent, browser automation (Playwright-MCP) follow
as v1 Phases 4–9, now built **on top of** a proven editor+diff+checkpoint core.

## 9. Key risks & engineering traps (revised for playground-first)

v1's trap analysis largely holds; the playground-first pivot **de-risks the biggest one (T1)** and
adds fork-specific traps.

**Carried forward (still load-bearing):**
- **T2 — Don't let the LLM author the patch.** LLM emits new text for a bounded region; diff is
  computed deterministically. *(settled — see §6 Mode A)*
- **T3 — Char-level diff vs tree legality.** Constrain diffs to a single region; structural edits are
  separate coarse ops. *(see §6 Mode A)*
- **T4 — Placeholder tokenization is validating reconciliation.** Opaque sentinels; count/identity
  mismatch = hard reject. *(see §6 shared infra, §7)*
- **T8 — Rust on the hot path.** In-process TS diff first; promote to Rust/WASM only when profiled;
  keep the contract stable. *(see §6, Phase 5)*
- **T9 — Document schema migration.** Wrap state in `{schemaVersion, lexicalVersion, state}`; write a
  migration before the first node-set change; keep a corpus of real saved docs in CI that must still
  open. *(see §5)*

**Eliminated by the pivot (single-user, no collab):**
- **T1 — The three-way fight (Yjs × pending diff × live typing).** This app is **single-user with no
  realtime collaboration ever** (§10), so **all Yjs/CRDT machinery is stripped** — no shared doc, no
  remote merges. The pending AI diff lives on a **cloned subtree** and never touches the live editor
  until accepted. T1 does not exist in this architecture.

**New traps (playground-first):**
- **U1 — Upstream drift.** We own a fork; Lexical ships often. *Mitigate:* keep forked code in a
  clearly bounded subtree; **prefer configuring extensions over editing them**; track upstream tags;
  periodic rebase; upstream changelog review each bump.
- **U2 — Experimental APIs in the playground.** Its `__EXPERIMENTAL` surfaces
  (`CollaborationPluginV2`, `DIFF_VERSIONS_COMMAND`) were all collab-related and are **deleted with
  the Yjs cluster**. *Principle:* keep our critical path on **stable** lexical APIs only; treat any
  other `__EXPERIMENTAL` surface as a reference, not a dependency.
- **U3 — `workspace:*` internal deps.** The playground declares workspace deps incl.
  `@lexical/internal`. *Mitigate:* at Phase 0, verify **every** `@lexical/*` import resolves on npm
  at the pinned tag before building; if any is not published, fall back to Option B (monorepo
  subtree).
- **D1 — Diffing trees by NodeKey (§4.1).** NodeKeys do not survive `toJSON`/`parseEditorState`.
  *Mitigate:* diff flattened text/Markdown for content; use structure only for navigation. (This is
  the single most important non-obvious rule in the diff design.)
- **D2 — Checkpoint storage growth.** Full JSON per auto-snapshot is unbounded. *Mitigate:* throttle
  auto-snapshots (idle/N-commits/timer), store periodic full + deltas, prune/collapse old checkpoints,
  cap per-doc retention.

**Deferred (belong to post-MVP phases; kept for continuity):** T5 (prompt injection from fetched
literature), T6 (HIL durability), T7 (WebSocket reconnect as resumable log), T10 (async deep-path
results arriving late). These re-enter scope at Phase 6+.

## 10. Confirmed decisions (2026-06-23)

This is a **single-user, personal-use** app — that single fact settles most of v1's open questions.

1. **Vendoring strategy (§3.2)** → **Option A:** fork playground `src` + pinned lexical npm tag.
2. **Checkpoint basis (§5)** → **JSON snapshot DAG** (no Yjs).
3. **Realtime collaboration** → **Never.** Strip the entire Yjs/collab cluster; no accounts/auth; no
   multi-user. (Eliminates T1; settles v1 §7's multi-user question.)
4. **Diff Mode B basis (§6)** → **Markdown diff** (`$convertToMarkdownString` flatten + char/word-diff).
5. **MVP storage** → **IndexedDB** (the long-term local store; a backend is optional sync/backup only).
6. **LLM provider + key location** → *still open for Phase 4.* For a personal app, a **client-side call
   with the user's own key** (OpenAI / Anthropic / open-weights) is the natural default; a thin local
   server is the alternative if the key must not touch the browser.
7. *(post-MVP, when they matter)* Optional sync/backup target, the Rust diff core (Phase 5, if/when
   large docs need it), MCP servers / browser / RAG / Deep Path (Phase 6+). **Auth/multi-user is
   permanently out of scope.**

## 11. Repo-state note

At the time of this rewrite the repository contains only `LICENSE` and this `PLAN.md` (greenfield).
The project memory that referenced an existing maturin/Rust `_diff_native` backend and dev ports
5180/8010 does **not** match the current tree; treat that backend as not-yet-present. If/when a Rust
diff core is (re)introduced, it slots behind the in-process diff interface defined in Phase 3 and the
`@lexical/headless` server path in Phase 5 — no architectural rework.

---

### Appendix A — Playground reuse map (file-level, for implementers)

**Composition entry points** (`src/App.tsx`, `src/Editor.tsx`): `AppExtension`,
`PlaygroundRichTextExtension`, `buildExtensionFromSettings`, `LexicalExtensionComposer`,
`PlaygroundNodes`, `PlaygroundEditorTheme`, `$prepopulatedRichText`, `Settings.tsx`/`appSettings.ts`.

**Import/Export functions:** `$convertToMarkdownString` / `$convertFromMarkdownString`
(`@lexical/markdown`, transformers `src/plugins/MarkdownTransformers/`); `$generateHtmlFromNodes` /
`$generateNodesFromDOMViaExtension` (`@lexical/html`); `editor.getEditorState().toJSON()` /
`editor.parseEditorState`; `importFile` / `exportFile` / `serializedDocumentFromEditorState` /
`editorStateFromSerializedDocument` (`@lexical/file`); share-hash `src/utils/docSerialization.ts`;
UI in `src/plugins/ActionsPlugin/`.

**Per-node rules to copy for `CitationNode`:** `defineImportRule` + `configExtension(DOMImportExtension,{rules})`
(template: `src/plugins/EquationsExtension/`); export override `domOverride` +
`configExtension(DOMRenderExtension,{overrides})` (template: `src/plugins/TerseExportExtension.ts`);
node-level `exportDOM` base64 pattern: `src/nodes/EquationNode.tsx`.

**Tree / commit hook:** `editor.getEditorState().toJSON()` (canonical); `registerUpdateListener`
(commit signal, template: `src/plugins/TestRecorderPlugin/`); debug pane `src/plugins/TreeViewPlugin/`.

**Checkpoint/diff prototype (design reference only — deleted from fork):** `src/plugins/VersionsPlugin/`
— Yjs `snapshot()`, `DIFF/CLEAR_DIFF_VERSIONS_COMMAND__EXPERIMENTAL`, `$getYChangeState` +
`registerMutationListener(TextNode)`. Borrow the UX + render technique; do **not** import the plugin
(it is Yjs-coupled and is stripped — §10).

**Theme:** `src/themes/PlaygroundEditorTheme.{ts,css}` (keep `PlaygroundEditorTheme__` prefix); scoped
sub-themes by spread+override (`CommentEditorTheme`, `StickyEditorTheme`).

**Server-side ops:** `@lexical/headless` (parse/operate on JSON states without a DOM) for Phase 5
backend diff.
