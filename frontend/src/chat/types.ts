/**
 * gitEssay — chat provider contract (the sidebar AI surface).
 *
 * The sidebar turns (the user's instruction + the current context: a selection
 * or the whole document) into an assistant turn: some prose plus zero or more
 * proposed edits, each a coding-agent-style SEARCH/REPLACE pair. Edits are
 * rendered as reviewable diff cards and applied only on Accept (never silently).
 */
export type ChatMode = 'selection' | 'document';

export interface ChatContext {
  mode: ChatMode;
  /** Plain text of the selection (mode 'selection'). */
  selectionText?: string;
  /** Full document text, blocks joined by blank lines (mode 'document'). */
  documentText: string;
  /** The user's instruction / message. */
  instruction: string;
}

export interface ChatEdit {
  /** Verbatim passage to locate in the document (within a single block). */
  search: string;
  /** Replacement text for that passage. */
  replace: string;
}

/** Lifecycle of a proposed edit in the UI. */
export type ChatEditState = 'pending' | 'applied' | 'rejected' | 'unlocatable';

export interface ChatResponse {
  /** Assistant prose shown to the user (may be empty). */
  text: string;
  /** Proposed edits (search → replace). Empty for a pure-advice reply. */
  edits: ChatEdit[];
}

export interface ChatProvider {
  id: string;
  label: string;
  chat(ctx: ChatContext): Promise<ChatResponse>;
}

/** A single rendered conversation turn (UI state). */
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** For 'user': the instruction; for 'assistant': prose (may be empty). */
  text: string;
  /** Assistant only: context mode captured when the turn was sent. */
  mode?: ChatMode;
  /** Assistant only: proposed edits, each with its own accept/reject state. */
  edits?: Array<ChatEdit & {state: ChatEditState}>;
  /** Assistant only: error message if the call failed. */
  error?: string;
}
