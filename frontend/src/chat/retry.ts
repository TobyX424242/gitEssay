/**
 * gitEssay — retry planning (pure, extracted from ChatSidebar for testability).
 *
 * A retry must first revert every patch that was accepted from the target
 * response onward — otherwise a later patch's text still overlays the region
 * and the new attempt's SEARCH won't match. The revert runs LIFO: latest
 * response first (it overlays the earlier ones); within a response, latest
 * edit first. `buildRetryPlan` decides WHAT to revert; `lifoRevertSteps`
 * flattens it into execution order; ChatSidebar supplies the side effects
 * (applyTextPatch, setEditState, checkpoint, regenerate).
 */
import type {ChatEdit, ChatMessage, ChatMode, MessageContext} from './types';

/** One response whose accepted edits will be reverted before a retry. */
export interface RetryRevertItem {
  msgId: string;
  /** Patch explanation (the version label) — shown in the confirm dialog. */
  label: string;
  count: number;
}

/** A planned retry: revert a LIFO batch of accepted patches, then regenerate. */
export interface RetryPlan {
  targetId: string;
  instruction: string;
  mode: ChatMode;
  selectionText?: string;
  /** Chronological (target → latest); lifoRevertSteps reverses this for LIFO. */
  items: RetryRevertItem[];
  totalEdits: number;
  priorMessages: ChatMessage[];
  /** Snapshot at click time — edits still carry the 'applied' state to revert. */
  messages: ChatMessage[];
}

/**
 * Build the retry plan for `assistantId`, or null if the target isn't retryable
 * (not found, no preceding user turn). Only edits still in 'applied' state are
 * slated for revert; assistant messages before the target are untouched.
 * Legacy (pre-streaming) messages carry edits but no action — they are reverted
 * too, with a generic label.
 */
export function buildRetryPlan(
  messages: ChatMessage[],
  assistantId: string,
): RetryPlan | null {
  const idx = messages.findIndex(m => m.id === assistantId);
  if (idx < 1) {
    return null;
  }
  const userMsg = messages[idx - 1];
  if (userMsg.role !== 'user') {
    return null;
  }
  const ctx: MessageContext = userMsg.context ?? {mode: 'document'};
  const items: RetryRevertItem[] = [];
  for (let k = idx; k < messages.length; k++) {
    const m = messages[k];
    if (m.role !== 'assistant') {
      continue;
    }
    const count = (m.edits ?? []).filter(e => e.state === 'applied').length;
    if (count > 0) {
      const label = m.action?.kind === 'patch' ? m.action.explanation : undefined;
      items.push({msgId: m.id, label: label || 'AI edit', count});
    }
  }
  return {
    targetId: assistantId,
    instruction: userMsg.text,
    mode: ctx.mode,
    selectionText: ctx.selectionText,
    items,
    totalEdits: items.reduce((n, it) => n + it.count, 0),
    priorMessages: messages.slice(0, idx - 1),
    messages,
  };
}

/** One revert step: undo this applied edit (reverse-swap replace→search). */
export interface RevertStep {
  msgId: string;
  /** Index of the edit within its message's edits array (for setEditState). */
  editIndex: number;
  edit: ChatEdit;
}

/**
 * Flatten a plan into LIFO execution order: latest response first (it overlays
 * the earlier ones); within a response, latest edit first. Items whose message
 * is missing from the snapshot are skipped.
 */
export function lifoRevertSteps(plan: RetryPlan): RevertStep[] {
  const steps: RevertStep[] = [];
  for (const it of [...plan.items].reverse()) {
    const msg = plan.messages.find(m => m.id === it.msgId);
    if (!msg) {
      continue;
    }
    const applied = (msg.edits ?? [])
      .map((e, i) => ({e, i}))
      .filter(({e}) => e.state === 'applied');
    for (const {e, i} of [...applied].reverse()) {
      steps.push({msgId: it.msgId, editIndex: i, edit: e});
    }
  }
  return steps;
}
