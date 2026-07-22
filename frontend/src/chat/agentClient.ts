/**
 * gitEssay — LangGraph agent client (the ONLY agent engine).
 *
 * The backend LangGraph agent owns the loop, tools, system prompt, and
 * memories; the frontend sends the live document snapshot (the backend has no
 * editor) and renders the SSE events: text / thinking / step / patch / ask /
 * done / error. The produced ChatMessage feeds ChatSidebar / MessageBubble /
 * acceptPatch / the ask card.
 *
 * This module also hosts the shared run plumbing: docParagraphs (live editor →
 * sentinel-laden paragraphs), messagesToHistory (stored messages → model
 * turns), and the RunAgentOpts contract consumed by ChatSidebar.
 */
import {$getRoot, type LexicalEditor} from 'lexical';

import type {ChatTurn} from '../rewrite/llmClient';
import {blockInlineItems, itemsToText} from './sentinels';
import type {
  AgentStep,
  AssistantAction,
  ChatEditState,
  ChatMessage,
  ChatMode,
} from './types';

export interface RunAgentOpts {
  editor: LexicalEditor;
  instruction: string;
  mode: ChatMode;
  /** selection text captured at send time (mode === 'selection'). */
  selectionText?: string;
  /** prior conversation turns (already mapped via messagesToHistory). */
  history: ChatTurn[];
  signal: AbortSignal;
  /** live deltas for the streaming message bubble. */
  onUpdate: (patch: Partial<ChatMessage>) => void;
  /** Long-term memory toggle (forwarded to the backend, which owns memories). */
  memoryEnabled: boolean;
}

/** RunAgentOpts + the project id (needed server-side for memories). */
export interface AgentGraphOpts extends RunAgentOpts {
  projectId: string;
}

/**
 * Flatten the live editor to a list of sentinel-laden paragraphs (citations /
 * equations become opaque [[CITE:..]]/[[EQ:..]] tokens so the model treats them
 * as atomic). Shipped to the backend with each run — the backend has no live
 * editor, so the frontend must send the current document state.
 */
export function docParagraphs(editor: LexicalEditor): string[] {
  let paragraphs: string[] = [];
  editor.getEditorState().read(() => {
    paragraphs = $getRoot()
      .getChildren()
      .map(b => {
        const items = blockInlineItems(b);
        return items.length > 0 ? itemsToText(items) : b.getTextContent();
      });
  });
  return paragraphs;
}

/**
 * The document's LaTeX equations as an explicit list for the agent: each
 * [[EQ:nonce]] token in the paragraphs maps to one entry here carrying its
 * raw LaTeX source, so the model can READ equations as LaTeX and address them
 * in equation patches. Non-LaTeX equations stay fully opaque (legacy
 * behaviour) and are not listed.
 */
export function docEquations(
  editor: LexicalEditor,
): Array<{nonce: string; inline: boolean; latex: string}> {
  const out: Array<{nonce: string; inline: boolean; latex: string}> = [];
  editor.getEditorState().read(() => {
    for (const block of $getRoot().getChildren()) {
      for (const it of blockInlineItems(block)) {
        if (it.kind === 'eq' && it.node.isLatex()) {
          out.push({
            nonce: it.nonce,
            inline: it.node.isInline(),
            latex: it.node.getEquation(),
          });
        }
      }
    }
  });
  return out;
}

/**
 * Prior stored messages → the {role, content} turns sent to the model. Assistant
 * turns carry a compact note of the action taken so the model has context across
 * a multi-message conversation (e.g. resuming after it asked a question).
 */
export function messagesToHistory(messages: ChatMessage[]): ChatTurn[] {
  return messages.map(m => {
    if (m.role === 'user') {
      return {role: 'user', content: m.text};
    }
    const parts: string[] = [];
    if (m.text?.trim()) {
      parts.push(m.text.trim());
    }
    const a = m.action;
    if (a?.kind === 'patch') {
      const n = (m.edits ?? []).length + (m.eqEdits ?? []).length;
      parts.push(`[Proposed ${n} edit(s): "${a.explanation}"]`);
    } else if (a?.kind === 'ask') {
      parts.push(`[Asked the user: "${a.question}"]`);
    } else if (a?.kind === 'finish') {
      parts.push(`[Finished: ${a.summary ?? ''}]`);
    }
    if (m.error) {
      parts.push(`[Error: ${m.error}]`);
    }
    return {role: 'assistant', content: parts.join('\n\n') || '(no content)'};
  });
}

interface AgentEvent {
  type: 'text' | 'thinking' | 'step' | 'patch' | 'ask' | 'done' | 'error';
  delta?: string;
  step?: AgentStep;
  explanation?: string;
  edits?: {search: string; replace: string}[];
  eq_edits?: {nonce: string; latex: string}[];
  question?: string;
  options?: string[];
  message?: string;
}

function isAbort(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}

function noOpEdits(
  edits: {search: string; replace: string}[],
): Array<{search: string; replace: string; state: ChatEditState}> {
  return edits
    .map(e => ({...e, state: 'pending' as ChatEditState}))
    .filter(e => e.replace.trim() !== e.search.trim()); // drop unchanged text
}

/** Drop equation edits missing a nonce or with empty LaTeX (can't apply). */
function noOpEqEdits(
  edits: {nonce: string; latex: string}[],
): NonNullable<ChatMessage['eqEdits']> {
  return edits
    .filter(e => typeof e.nonce === 'string' && e.nonce.trim().length > 0)
    .filter(e => typeof e.latex === 'string' && e.latex.trim().length > 0)
    .map(e => ({...e, state: 'pending' as ChatEditState}));
}

/**
 * Run the backend LangGraph agent to completion (or abort). Returns the finalized
 * assistant message. Throws on fatal non-abort errors (caller surfaces them).
 */
export async function runAgentGraph(opts: AgentGraphOpts): Promise<ChatMessage> {
  const body = {
    project_id: opts.projectId,
    instruction: opts.instruction,
    mode: opts.mode,
    selection_text: opts.selectionText ?? '',
    doc_paragraphs: docParagraphs(opts.editor),
    doc_equations: docEquations(opts.editor),
    history: opts.history,
    memory_enabled: opts.memoryEnabled,
  };

  // Accumulate the run; onUpdate pushes live deltas to the streaming bubble.
  let text = '';
  let thinking = '';
  const steps: AgentStep[] = [];
  let action: AssistantAction | null = null;
  let edits: ChatMessage['edits'];
  let eqEdits: ChatMessage['eqEdits'];
  let errorMessage: string | undefined;

  const res = await fetch('/api/agent/run', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      message = data.detail || data.message || message;
    } catch {
      // non-JSON error body
    }
    throw new Error(message);
  }
  if (!res.body) {
    throw new Error('streaming is not supported by this transport');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Cancel the reader on any throw so it isn't left locking the connection.
  try {
    for (;;) {
      const {done, value} = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, {stream: true});
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) >= 0) {
        const chunk = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = chunk.split('\n').find(l => l.startsWith('data:'));
        if (!dataLine) {
          continue;
        }
        const payload = dataLine.slice('data:'.length).trim();
        if (!payload) {
          continue;
        }
        let ev: AgentEvent;
        try {
          ev = JSON.parse(payload);
        } catch {
          continue;
        }
        if (ev.type === 'text' && ev.delta) {
          text += ev.delta;
          opts.onUpdate({text});
        } else if (ev.type === 'thinking' && ev.delta) {
          thinking += ev.delta;
          opts.onUpdate({thinking});
        } else if (ev.type === 'step' && ev.step) {
          steps.push(ev.step);
          opts.onUpdate({steps: [...steps]});
        } else if (ev.type === 'patch') {
          const cleaned = noOpEdits(ev.edits ?? []);
          const cleanedEq = noOpEqEdits(ev.eq_edits ?? []);
          if (cleaned.length === 0 && cleanedEq.length === 0) {
            // All-no-op patch → downgrade to an advice turn (no empty card).
            action = null;
            edits = undefined;
            eqEdits = undefined;
            if (!text.trim()) {
              text = 'No changes to apply.';
              opts.onUpdate({text});
            }
          } else {
            action = {kind: 'patch', explanation: ev.explanation ?? ''};
            edits = cleaned;
            eqEdits = cleanedEq;
          }
          opts.onUpdate({action: action ?? undefined, edits, eqEdits});
        } else if (ev.type === 'ask') {
          action = {
            kind: 'ask',
            question: ev.question ?? '',
            options: ev.options ?? [],
          };
          opts.onUpdate({action});
        } else if (ev.type === 'error') {
          // Keep what streamed; attach the error so the user doesn't lose the
          // partial answer.
          errorMessage = ev.message ?? 'stream error';
        }
        // 'done' falls through; the reader will return done=true next.
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (isAbort(err)) {
      return finalize(opts, text, thinking, steps, action, edits, eqEdits, undefined);
    }
    throw err; // network drop / unexpected — let the caller surface it
  }

  return finalize(opts, text, thinking, steps, action, edits, eqEdits, errorMessage);
}

function finalize(
  opts: AgentGraphOpts,
  text: string,
  thinking: string,
  steps: AgentStep[],
  action: AssistantAction | null,
  edits: ChatMessage['edits'],
  eqEdits: ChatMessage['eqEdits'],
  error: string | undefined,
): ChatMessage {
  const msg: ChatMessage = {
    id: '',
    role: 'assistant',
    text,
    mode: opts.mode,
    thinking: thinking || undefined,
    steps: steps.length > 0 ? steps : undefined,
    action,
    edits,
    eqEdits,
    streaming: false,
  };
  if (error) {
    msg.error = error;
  }
  return msg;
}
