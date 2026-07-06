/**
 * gitEssay — LangGraph agent client (the "langgraph" engine).
 *
 * The counterpart of `runAgent` (the frontend loop) for the backend LangGraph
 * agent. It has the SAME contract: take the run options + an onUpdate callback,
 * stream live deltas into the message bubble, and resolve to a finalized
 * ChatMessage. The produced ChatMessage is shape-identical to runAgent's, so
 * ChatSidebar / MessageBubble / acceptPatch / the ask card are unchanged — only
 * the producer differs.
 *
 * The backend owns the loop, tools, system prompt, and memories; the frontend
 * sends the live document snapshot (the backend has no editor) and renders the
 * SSE events: text / thinking / step / patch / ask / done / error.
 */
import {docParagraphs, type RunAgentOpts} from './providers';
import type {
  AgentStep,
  AssistantAction,
  ChatEditState,
  ChatMessage,
} from './types';

/** RunAgentOpts + the project id (needed server-side for memories). */
export interface AgentGraphOpts extends RunAgentOpts {
  projectId: string;
}

interface AgentEvent {
  type: 'text' | 'thinking' | 'step' | 'patch' | 'ask' | 'done' | 'error';
  delta?: string;
  step?: AgentStep;
  explanation?: string;
  edits?: {search: string; replace: string}[];
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

/**
 * Run the backend LangGraph agent to completion (or abort). Returns the finalized
 * assistant message. Throws on fatal non-abort errors (caller surfaces them),
 * matching runAgent.
 */
export async function runAgentGraph(opts: AgentGraphOpts): Promise<ChatMessage> {
  const body = {
    project_id: opts.projectId,
    instruction: opts.instruction,
    mode: opts.mode,
    selection_text: opts.selectionText ?? '',
    doc_paragraphs: docParagraphs(opts.editor),
    history: opts.history,
    memory_enabled: opts.memoryEnabled,
  };

  // Accumulate the run; onUpdate pushes live deltas to the streaming bubble.
  let text = '';
  let thinking = '';
  const steps: AgentStep[] = [];
  let action: AssistantAction | null = null;
  let edits: ChatMessage['edits'];
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
          if (cleaned.length === 0) {
            // All-no-op patch → downgrade to an advice turn (no empty card),
            // matching runAgent.finalize (which leaves edits undefined).
            action = null;
            edits = undefined;
            if (!text.trim()) {
              text = 'No changes to apply.';
              opts.onUpdate({text});
            }
          } else {
            action = {kind: 'patch', explanation: ev.explanation ?? ''};
            edits = cleaned;
          }
          opts.onUpdate({action: action ?? undefined, edits});
        } else if (ev.type === 'ask') {
          action = {
            kind: 'ask',
            question: ev.question ?? '',
            options: ev.options ?? [],
          };
          opts.onUpdate({action});
        } else if (ev.type === 'error') {
          // Keep what streamed; attach the error so the user doesn't lose the
          // partial answer (matches runAgent's non-abort-error behavior).
          errorMessage = ev.message ?? 'stream error';
        }
        // 'done' falls through; the reader will return done=true next.
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    if (isAbort(err)) {
      return finalize(opts, text, thinking, steps, action, edits, undefined);
    }
    throw err; // network drop / unexpected — let the caller surface it
  }

  return finalize(opts, text, thinking, steps, action, edits, errorMessage);
}

function finalize(
  opts: AgentGraphOpts,
  text: string,
  thinking: string,
  steps: AgentStep[],
  action: AssistantAction | null,
  edits: ChatMessage['edits'],
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
    streaming: false,
  };
  if (error) {
    msg.error = error;
  }
  return msg;
}
