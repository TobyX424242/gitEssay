/**
 * gitEssay — chat provider contract (the sidebar AI surface).
 *
 * The sidebar turns (the user's instruction + the current context: a selection
 * or the whole document) into an assistant turn: some prose plus zero or more
 * proposed edits, each a coding-agent-style SEARCH/REPLACE pair. Edits are
 * rendered as reviewable diff cards and applied only on Accept (never silently).
 */
export type ChatMode = 'selection' | 'document';

/**
 * Context captured at send time and stored on the user message (drives Retry).
 * The full document text is read fresh by the agent — only the edit
 * target (a selection, if any) is captured here.
 */
export interface MessageContext {
  mode: ChatMode;
  /** Plain text of the selection (mode 'selection'). */
  selectionText?: string;
}

export interface ChatEdit {
  /** Verbatim passage to locate in the document (within a single block). */
  search: string;
  /** Replacement text for that passage. */
  replace: string;
}

/**
 * A LaTeX equation content edit — the ONLY way a patch may change an
 * equation's LaTeX. `nonce` addresses the equation (its [[EQ:nonce]] token);
 * `latex` is the complete new LaTeX source, validated with KaTeX before it is
 * applied. Text patches never carry equation content (equations stay opaque
 * sentinels there), so the text/equation boundary survives every AI edit.
 */
export interface ChatEqEdit {
  nonce: string;
  latex: string;
}

/**
 * An append edit — the ONLY way a patch may add brand-new content: the text is
 * appended to the END of the document as new paragraph(s) (blank-line separated).
 * Append content is plain prose: it must NOT contain [[CITE:…]]/[[EQ:…]]
 * sentinels (the AI cannot invent or clone atomic nodes).
 */
export interface ChatAppendEdit {
  text: string;
}

/** Lifecycle of a proposed edit in the UI. */
export type ChatEditState =
  | 'pending'
  | 'applied'
  | 'rejected'
  | 'unlocatable' // search text couldn't be located (generic)
  | 'stale' // the passage existed when the AI proposed it but the doc changed since
  | 'reverted';

export interface ChatResponse {
  /** Assistant prose shown to the user (may be empty). */
  text: string;
  /** Proposed edits (search → replace). Empty for a pure-advice reply. */
  edits: ChatEdit[];
}

/**
 * The terminal action of an assistant turn (the agent's "what to do"). Exactly
 * one per turn (or null for a pure-advice reply). Drives the action card UI and
 * the agent loop's stop/continue decision.
 *
 * For `patch`, the edits themselves live on `ChatMessage.edits` (with per-edit
 * accept/reject state) so the existing edit-state persistence keeps working;
 * the action carries only the commit-style `explanation`.
 */
export type AssistantAction =
  | {kind: 'patch'; explanation: string}
  | {kind: 'ask'; question: string; options: string[]}
  | {kind: 'finish'; summary?: string};

/**
 * A non-terminal agent step — the AI inspected the document (read all of it, or
 * searched for a term), consulted the literature library, saved a long-term
 * memory note, or dispatched a subagent. Shown as a chip in the message. These
 * do NOT stop the loop; only an AssistantAction (or no action) does.
 */
export interface AgentStep {
  kind:
    | 'read'
    | 'search'
    | 'remember'
    | 'literature_list'
    | 'literature_search'
    | 'literature_read'
    | 'figure'
    | 'notes'
    | 'delegate';
  /** search/literature_search query, figure `#seq`, or undefined for a full read */
  query?: string;
  /** remember: the note the AI saved. */
  note?: string;
  /** literature_read/figure: the literature title involved. */
  literature?: string;
  /** delegate: the delegated task briefing (truncated). */
  task?: string;
  /** delegate/sub-step: nesting depth (1..3) — the main agent is depth 0. */
  depth?: number;
  /** read/search: how many characters/snippets came back (for the chip label). */
  hits?: number;
  at: number;
}

/** A single rendered conversation turn (UI state). */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** For 'user': the instruction; for 'assistant': prose (may be empty). */
  text: string;
  /** User only: the exact request context captured at send time (drives Retry). */
  context?: MessageContext;
  /** Assistant only: context mode captured when the turn was sent. */
  mode?: ChatMode;
  /** Assistant only: reasoning text shown in the collapsible Thoughts pane. */
  thinking?: string;
  /** Assistant only: non-terminal document-inspection steps (read/search). */
  steps?: AgentStep[];
  /** Assistant only: the terminal action (patch / ask / finish), else advice. */
  action?: AssistantAction | null;
  /** Assistant only: proposed edits (LEGACY — superseded by action.patch; kept
   *  so previously-persisted messages still render their diff cards). */
  edits?: Array<ChatEdit & {state: ChatEditState}>;
  /** Assistant only: proposed LaTeX equation edits. `prevLatex` is recorded
   *  when an edit applies (drives Retry's LIFO revert); `failReason` carries
   *  the KaTeX error when an edit is rejected for invalid LaTeX after the
   *  re-prompt budget is exhausted. */
  eqEdits?: Array<
    ChatEqEdit & {state: ChatEditState; prevLatex?: string; failReason?: string}
  >;
  /** Assistant only: proposed content appends (new paragraphs at the end of
   *  the document; may contain NEW display equations as $$…$$ blocks).
   *  Appends are never auto-reverted by Retry (they don't overlay existing
   *  text, so they can't block a regenerated patch). */
  appendEdits?: Array<ChatAppendEdit & {state: ChatEditState; failReason?: string}>;
  /** Assistant only: error message if the call failed. */
  error?: string;
  /** Assistant only: true while this turn is still streaming (UI hint). */
  streaming?: boolean;
  /** Assistant patch only: the document text the AI was given for this run
   *  (sentinel-laden). Used to classify a failing edit as a mis-copy (search
   *  never in the snapshot) vs a stale doc (search was in the snapshot but the
   *  live doc changed). Per-turn because context varies even within a chat. */
  snapshot?: string;
  /** Assistant patch only: a patch-level failure that supersedes the patch card.
   *  'ignored' = mis-copied past the retry budget (dropped); 'stale' = the
   *  underlying text changed while the AI worked (can't complete); 'invalid' =
   *  structurally un-applicable (references a citation/equation not in the search
   *  passage, or spans nested formatting around a decorator). */
  patchFailure?: 'ignored' | 'stale' | 'invalid';
  /** When `patchFailure === 'invalid'`, the specific reason (from applyTextPatch). */
  patchFailureReason?: string;
}
