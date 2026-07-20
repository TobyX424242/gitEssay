/**
 * gitEssay — AI chat sidebar (VS Code-style right dock).
 *
 * Always-available conversation surface. The send/retry path runs the STREAMING
 * LangGraph agent (runAgentGraph): the model's thinking streams into a collapsible Thoughts
 * pane (expanded live, auto-collapsed when the turn finishes), and each turn ends
 * in one terminal action — patch (reviewable diffs, checkpointed on accept with
 * the model's explanation as the label), ask (options + a free-text box), or
 * finish. read/search steps show as chips. A Stop button aborts mid-stream.
 */
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$getRoot, $getSelection, $isRangeSelection} from 'lexical';
import {createPortal} from 'react-dom';
import {
  type JSX,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import {captureCheckpoint} from '../checkpoints/service';
import {diffBlocks} from '../diff/diff';
import DiffView from '../diff/DiffView';
import {REWRITE_ACTIONS} from '../rewrite/actions';
import {isConfigured, useAISettings} from '../rewrite/aiSettings';
import AISettingsPanel from '../rewrite/AISettingsPanel';

import {
  appendMessages,
  bootstrapConversations,
  createConversation,
  deleteConversation,
  replaceMessage,
  setActiveConversation,
  setEditState,
  useConversations,
} from './conversations';
import Markdown from './Markdown';
import {applyTextPatch, plainTextToBlocks, textContains} from './patch';
import {
  classifyPatch,
  MAX_PATCH_ATTEMPTS,
  patchFeedback,
  withPatchFailure,
} from './patchValidate';
import {selectionToSentinelText} from './sentinels';
import {chatPanel, closePanel, openPanel, usePanelOpen, usePanelWidth} from './panelStore';
import {
  addMemory,
  deleteMemory,
  type Memory,
  setMemoryEnabled,
  useMemories,
  useMemoryEnabled,
} from './memories';
import {useActiveProjectId} from '../projects/projectStore';
import {useCompareMode} from '../ui/CompareMode';
import {docParagraphs, messagesToHistory, runAgentGraph} from './agentClient';
import {buildRetryPlan, lifoRevertSteps} from './retry';
import type {RetryPlan} from './retry';
import type {ChatTurn} from '../rewrite/llmClient';
import type {
  AgentStep,
  ChatEditState,
  ChatMessage,
  ChatMode,
  MessageContext,
} from './types';
import {SidePanelResizer} from '../ui/SidePanelResizer';
import {useScrollTrap} from '../ui/useScrollTrap';
import './chat.css';

function msgId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `m${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function deriveTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) {
    return 'New conversation';
  }
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Step-chip icon per AgentStep kind (LangGraph agent tool activity). */
const STEP_ICON: Record<string, string> = {
  read: '📖',
  search: '🔍',
  literature_list: '📚',
  literature_search: '📚',
  literature_read: '📄',
  figure: '🖼',
  notes: '🗒',
  delegate: '🤖',
};

/** Group memory notes for the Memory panel: project-wide first, then one
 *  section per literature item (per-paper notes the agent saved). */
function groupMemories(
  memories: Memory[],
): Array<{key: string; title: string | null; notes: Memory[]}> {
  const project = memories.filter(m => !m.literature_id);
  const byLit = new Map<string, {title: string; notes: Memory[]}>();
  for (const m of memories) {
    if (!m.literature_id) {
      continue;
    }
    const g = byLit.get(m.literature_id) ?? {
      title: m.literature_title ?? 'Literature',
      notes: [],
    };
    g.notes.push(m);
    byLit.set(m.literature_id, g);
  }
  const groups: Array<{key: string; title: string | null; notes: Memory[]}> = [];
  if (project.length > 0) {
    groups.push({key: '__project__', title: null, notes: project});
  }
  for (const [lid, g] of byLit) {
    groups.push({key: lid, title: g.title, notes: g.notes});
  }
  return groups;
}

/** Step-chip label per AgentStep kind. */
function stepLabel(s: AgentStep): string {
  switch (s.kind) {
    case 'search':
      return `searched “${s.query ?? ''}”`;
    case 'remember':
      return `remembered: ${s.note ?? ''}`;
    case 'literature_list':
      return 'listed the literature library';
    case 'literature_search':
      return `searched the literature for “${s.query ?? ''}”`;
    case 'literature_read':
      return `read 《${s.literature ?? 'literature'}》`;
    case 'figure':
      return `looked at figure ${s.query ?? ''} of 《${s.literature ?? 'literature'}》`;
    case 'notes':
      return 'consulted long-term notes';
    case 'delegate': {
      const layer = s.depth ? ` (layer ${s.depth + 1})` : '';
      return `dispatched a subagent${layer}: ${s.task ?? ''}`;
    }
    case 'read':
    default:
      return 'read the document';
  }
}

/** Context captured at send time and stored on the user message (drives Retry). */
type SendContext = MessageContext;

/** A retry plan plus the conversation it belongs to (dialog state). */
type PendingRetry = RetryPlan & {convId: string};

export default function ChatSidebar(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const open = usePanelOpen();
  const width = usePanelWidth();
  const settings = useAISettings();
  const configured = isConfigured(settings);
  const activeProjectId = useActiveProjectId();
  const {conversations, activeId, active} = useConversations();
  const messages = active?.messages ?? [];
  const memories = useMemories(activeProjectId);
  const memoryEnabled = useMemoryEnabled();
  // Compare mode only sets `editor.setEditable(false)` — programmatic
  // `editor.update` (accept / retry-revert) would still mutate the live doc
  // underneath the frozen diff view. Mutations must bail out while it's on.
  const {active: compareActive} = useCompareMode();

  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<ChatMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{text: string; key: number} | null>(null);
  const [pendingRetry, setPendingRetry] = useState<PendingRetry | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showList, setShowList] = useState(false);
  const [selInfo, setSelInfo] = useState<{mode: 'selection' | 'document'; chars: number}>(
    {mode: 'document', chars: 0},
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // The message id kept in view during/after a retry (its target), so the live
  // stream and the finalized patch card don't get scrolled off to the bottom.
  // Set on a retry, cleared on a fresh send or a conversation switch.
  const pinnedIdRef = useRef<string | null>(null);
  const trapRef = useScrollTrap();
  const abortRef = useRef<AbortController | null>(null);
  // Re-entrancy guard for the accept/revert paths. Applying edits + persisting
  // per-edit state is async, and the conversations store is NOT optimistic (each
  // write awaits HTTP then refetches), so retry() reading a snapshot mid-accept
  // would see stale 'pending' edits and skip the revert. Block retry (and a
  // second accept) while one is in flight.
  const acceptingRef = useRef(false);

  // Ensure at least one conversation exists for the active project.
  useEffect(() => {
    if (activeProjectId) {
      void bootstrapConversations();
    }
  }, [activeProjectId]);

  // Reserve editor space + drive the dock width via a CSS var (wide screens only).
  useEffect(() => {
    document.body.style.setProperty('--ge-chat-width', `${width}px`);
    if (open) {
      document.body.classList.add('ge-chat-open');
    } else {
      document.body.classList.remove('ge-chat-open');
    }
    return () => document.body.classList.remove('ge-chat-open');
  }, [open, width]);

  // Live context chip: selection vs full document.
  useEffect(() => {
    const probe = () => {
      editor.getEditorState().read(() => {
        const sel = $getSelection();
        const next =
          $isRangeSelection(sel) && !sel.isCollapsed()
            ? {mode: 'selection' as const, chars: sel.getTextContent().length}
            : {mode: 'document' as const, chars: 0};
        setSelInfo(prev =>
          prev.mode === next.mode && prev.chars === next.chars ? prev : next,
        );
      });
    };
    probe();
    return editor.registerUpdateListener(probe);
  }, [editor]);

  // A retry streams INTO an existing message's slot, so the live Thoughts pane and
  // patch card stay at the original position (not the conversation bottom). A
  // fresh send has a brand-new id and renders at the end as usual.
  const streamingInPlace = !!streaming && messages.some(m => m.id === streaming.id);

  // Clear the pin AND any pending retry plan when switching conversations so a
  // stale target doesn't pin and a stale plan doesn't revert/persist against the
  // wrong conversation.
  useEffect(() => {
    pinnedIdRef.current = null;
    setPendingRetry(null);
  }, [active?.id]);

  // Keep the newest content in view. A fresh send scrolls to the bottom; a retry
  // pins its target so the live stream AND the finalized patch card stay visible
  // at the original slot — not jumping to the bottom when the patch lands.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    const pin = pinnedIdRef.current;
    if (pin) {
      const node = el.querySelector(`[data-msg-id="${CSS.escape(pin)}"]`);
      if (node instanceof HTMLElement) {
        node.scrollIntoView({block: 'nearest'});
        return;
      }
    }
    el.scrollTop = el.scrollHeight;
  }, [messages, streaming, loading]);

  // Auto-dismiss the transient notice banner.
  useEffect(() => {
    if (!notice) {
      return;
    }
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const captureSelection = useCallback((instruction: string): SendContext => {
    // Sentinel-laden selection text (citations/equations → opaque tokens), so a
    // patch the model writes against the selection locates consistently in the
    // live document (whose decorator nodes flatten to the same tokens).
    const selectionText = selectionToSentinelText(editor);
    void instruction; // instruction is stored separately on the user message
    return selectionText && selectionText.length > 0
      ? {mode: 'selection', selectionText}
      : {mode: 'document'};
  }, [editor]);

  /**
   * Shared run path for send + retry. `replace` swaps an existing assistant
   * message (retry); otherwise the finalized message is appended. `streamingId`
   * is the id the live bubble uses (a fresh id for send, the target id for retry).
   */
  const startRun = useCallback(
    (args: {
      convId: string;
      instruction: string;
      mode: ChatMode;
      selectionText?: string;
      priorMessages: ChatMessage[];
      streamingId: string;
      replace: boolean;
    }) => {
      if (!configured) {
        const err: ChatMessage = {
          id: args.streamingId,
          role: 'assistant',
          text: '',
          mode: args.mode,
          error:
            'AI is not configured. Open the ⚙ settings to set your provider, API key, and model.',
        };
        void (args.replace
          ? replaceMessage(args.convId, args.streamingId, err)
          : appendMessages(args.convId, [err]));
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      // Pin a retry's target into view (live stream + finalized patch card); a
      // fresh send has no pin, so it scrolls to the bottom as usual.
      pinnedIdRef.current = args.replace ? args.streamingId : null;
      setLoading(true);
      setStreaming({
        id: args.streamingId,
        role: 'assistant',
        text: '',
        mode: args.mode,
        streaming: true,
        steps: [],
        action: null,
      });

      const history = messagesToHistory(args.priorMessages);
      // Snapshot of the document the AI is given for THIS run. Recorded per turn
      // (context varies even within one conversation) so a failing patch can be
      // classified: mis-copy (search never in the snapshot) vs stale (search was
      // in the snapshot but the live doc changed).
      const snapshot = docParagraphs(editor).join('\n\n');
      const runOptsBase = {
        editor,
        mode: args.mode,
        selectionText: args.selectionText,
        signal: controller.signal,
        // Long-term memory is owned by the backend (it runs the remember tool);
        // the frontend only forwards the on/off toggle.
        memoryEnabled,
        onUpdate: (patch: Partial<ChatMessage>) =>
          setStreaming(s => (s && s.id === args.streamingId ? {...s, ...patch} : s)),
      };
      // One engine run with a given history + instruction — used for the first
      // attempt and each mis-copy retry. Resets the streaming bubble each time so
      // the retry streams cleanly into the same slot.
      const runOnce = (h: ChatTurn[], instr: string): Promise<ChatMessage> => {
        setStreaming(s =>
          s && s.id === args.streamingId
            ? {...s, text: '', thinking: undefined, steps: [], action: null, edits: undefined}
            : s,
        );
        const opts = {...runOptsBase, history: h, instruction: instr};
        return runAgentGraph({...opts, projectId: activeProjectId ?? ''});
      };

      // Multi-layer fallback: validate the patch the AI produced; re-prompt on a
      // mis-copy (bounded), or mark it failed if the doc changed under the AI or
      // the edit is structurally invalid.
      let attempts = 0;
      const finalize = (
        msg: ChatMessage,
        accHistory: ChatTurn[],
        prevInstruction: string,
      ): Promise<ChatMessage> => {
        // A non-abort backend error already carries msg.error — preserve it and
        // don't classify/re-prompt (would waste calls at a failing backend and
        // surface a misleading 'ignored' card).
        if (msg.error) {
          return Promise.resolve(msg);
        }
        // User stopped mid-run: keep whatever streamed. Attach the snapshot for a
        // patch so a later Accept can still classify not-found→stale. Checked
        // before classifying so an aborted half-baked patch isn't mislabeled.
        if (controller.signal.aborted) {
          return Promise.resolve(
            msg.action?.kind === 'patch' ? {...msg, snapshot} : msg,
          );
        }
        if (msg.action?.kind === 'patch' && msg.edits && msg.edits.length > 0) {
          const {issue, reason} = classifyPatch(editor, msg.edits, snapshot);
          if (issue === 'stale') {
            // The passage the AI was editing is gone from the live doc — the doc
            // changed while it worked. The patch can't complete; tell the user.
            return Promise.resolve(withPatchFailure(msg, 'stale', snapshot));
          }
          if (issue === 'invalid') {
            // Structurally un-applicable (sentinel/structure). Re-prompting won't
            // reliably fix it; fail the patch with the specific reason.
            return Promise.resolve(withPatchFailure(msg, 'invalid', snapshot, reason));
          }
          if (issue === 'mis-copy') {
            attempts += 1;
            if (attempts > MAX_PATCH_ATTEMPTS) {
              return Promise.resolve(withPatchFailure(msg, 'ignored', snapshot));
            }
            // Re-prompt: hand the AI its failed attempt + a pointed reminder to
            // copy the SEARCH text verbatim, then re-validate the new patch.
            const failedText =
              msg.text?.trim() || '(proposed a patch that did not match the document)';
            const feedback = patchFeedback(msg.edits);
            // Accumulate every prior attempt so the model sees all failures (not
            // just the latest) and doesn't rotate back to a known-bad transcription.
            const nextHistory: ChatTurn[] = [
              ...accHistory,
              {role: 'user', content: prevInstruction},
              {role: 'assistant', content: failedText},
            ];
            return runOnce(nextHistory, feedback).then(m =>
              finalize(m, nextHistory, feedback),
            );
          }
        }
        // ok (or a non-patch reply): attach the snapshot for apply-time checks.
        return Promise.resolve(
          msg.action?.kind === 'patch' ? {...msg, snapshot} : msg,
        );
      };

      runOnce(history, args.instruction)
        .then(m => finalize(m, history, args.instruction))
        .then(async (finalMsg: ChatMessage) => {
          const persisted: ChatMessage = {...finalMsg, id: args.streamingId};
          // Await the persist so the store holds the new message BEFORE we drop
          // the live streaming bubble — otherwise the non-optimistic refetch
          // leaves the OLD (pre-retry) message visible for a frame (a flicker)
          // on an in-place retry.
          if (args.replace) {
            await replaceMessage(args.convId, args.streamingId, persisted);
          } else {
            await appendMessages(args.convId, [persisted]);
          }
        })
        .catch((err: unknown) => {
          const errMsg = err instanceof Error ? err.message : String(err);
          const errNode: ChatMessage = {
            id: args.streamingId,
            role: 'assistant',
            text: '',
            mode: args.mode,
            error: errMsg,
          };
          if (args.replace) {
            void replaceMessage(args.convId, args.streamingId, errNode);
          } else {
            void appendMessages(args.convId, [errNode]);
          }
        })
        .finally(() => {
          setLoading(false);
          setStreaming(null);
          abortRef.current = null;
        });
    },
    [activeProjectId, configured, editor, memories, memoryEnabled],
  );

  const send = useCallback(
    (instruction?: string) => {
      const text = (instruction ?? input).trim();
      if (!text || loading || !active || pendingRetry || acceptingRef.current) {
        return;
      }
      const convId = active.id;
      const priorMessages = active.messages;
      const ctx = captureSelection(text);
      const needsTitle =
        active.messages.length === 0 || active.title === 'New conversation';
      const title = needsTitle ? deriveTitle(text) : undefined;
      const userMsg: ChatMessage = {
        id: msgId(),
        role: 'user',
        text,
        context: ctx,
      };
      setInput('');
      void appendMessages(convId, [userMsg], title);
      startRun({
        convId,
        instruction: text,
        mode: ctx.mode,
        selectionText: ctx.selectionText,
        priorMessages,
        streamingId: msgId(),
        replace: false,
      });
    },
    [active, captureSelection, input, loading, pendingRetry, startRun],
  );

  /**
   * Build the retry plan: every applied patch from the target (inclusive) onward
   * must be reverted so the document rolls back to its state just before this
   * turn — otherwise a later patch's text still overlays the region and the new
   * attempt's SEARCH won't match. Returns null if the target isn't retryable.
   */
  const planRetry = useCallback(
    (assistantId: string): PendingRetry | null => {
      if (!active || loading || acceptingRef.current) {
        return null;
      }
      if (compareActive) {
        // Retry reverts applied patches — a live-doc mutation.
        setNotice({
          text: 'Exit the checkpoint comparison before retrying — retrying reverts edits in the live document.',
          key: Date.now(),
        });
        return null;
      }
      const plan = buildRetryPlan(active.messages, assistantId);
      return plan ? {convId: active.id, ...plan} : null;
    },
    [active, loading, compareActive],
  );

  /**
   * Execute a retry plan: revert the accepted patches LIFO (latest response
   * first — it overlays the earlier ones; within a response, latest edit first),
   * capture ONE checkpoint for the whole revert, then regenerate the target.
   */
  const doRetry = useCallback(
    async (plan: PendingRetry) => {
      acceptingRef.current = true;
      let undone = 0;
      let failed = 0;
      let nonRevertable = 0;
      let revertErrored = false;
      try {
        for (const step of lifoRevertSteps(plan)) {
          const e = step.edit;
          if (e.replace.trim() === '') {
            // Deletions can't be reverse-swapped (the swap searches for the
            // empty replace text). Re-inserting deleted text needs its original
            // position, which we don't track — skip and surface below.
            nonRevertable++;
            continue;
          }
          const res = await applyTextPatch(editor, e.replace, e.search); // reverse swap
          if (res.ok) {
            undone++;
            await setEditState(plan.convId, step.msgId, step.editIndex, 'reverted');
          } else {
            failed++;
          }
        }
        if (undone > 0) {
          const targetMsg = plan.messages.find(m => m.id === plan.targetId);
          const label =
            targetMsg?.action?.kind === 'patch' ? targetMsg.action.explanation : 'AI edit';
          await captureCheckpoint(editor, {
            source: 'manual',
            label: `Reverted ${undone} edit${undone === 1 ? '' : 's'} before retry: ${truncate(label, 60)}`,
          });
        }
      } catch (err) {
        // applyTextPatch / setEditState / captureCheckpoint can reject — don't let
        // it become an unhandled rejection (`void doRetry`). Retry against the
        // current doc either way.
        revertErrored = true;
        setNotice({
          text: `⚠ Revert failed: ${
            err instanceof Error ? err.message : String(err)
          }. Retrying against the current document.`,
          key: Date.now(),
        });
      } finally {
        acceptingRef.current = false;
      }

      if (!revertErrored && plan.totalEdits > 0) {
        const skippedDetail = [
          failed > 0 ? `${failed} couldn't be located (the document changed)` : '',
          nonRevertable > 0
            ? `${nonRevertable} deletion${nonRevertable === 1 ? '' : 's'} couldn't be auto-reverted (re-inserting deleted text isn't supported)`
            : '',
        ]
          .filter(Boolean)
          .join('; ');
        if (skippedDetail === '') {
          setNotice({
            text: `↩ Reverted ${undone} accepted edit${
              undone === 1 ? '' : 's'
            } across ${plan.items.length} response${
              plan.items.length === 1 ? '' : 's'
            } (newest first) so the new attempt can apply cleanly. Accepted versions stay in History.`,
            key: Date.now(),
          });
        } else if (undone > 0) {
          setNotice({
            text: `↩ Reverted ${undone} of ${plan.totalEdits} edit${
              plan.totalEdits === 1 ? '' : 's'
            }; ${skippedDetail}. Retrying anyway against the current doc — the new patch may not apply to those parts.`,
            key: Date.now(),
          });
        } else {
          setNotice({
            text: `Couldn't auto-revert the edit(s) (${skippedDetail}). Retrying anyway — the new patch may not apply.`,
            key: Date.now(),
          });
        }
      }

      startRun({
        convId: plan.convId,
        instruction: plan.instruction,
        mode: plan.mode,
        selectionText: plan.selectionText,
        priorMessages: plan.priorMessages,
        streamingId: plan.targetId,
        replace: true,
      });
    },
    [editor, startRun],
  );

  /** Retry entry point. If any accepted edits must be reverted, ask first via the
   *  confirm dialog (one dialog for the whole LIFO batch); otherwise just rerun. */
  const retry = useCallback(
    (assistantId: string) => {
      const plan = planRetry(assistantId);
      if (!plan) {
        return;
      }
      if (plan.totalEdits > 0) {
        setPendingRetry(plan);
      } else {
        void doRetry(plan);
      }
    },
    [doRetry, planRetry],
  );

  const confirmRetry = useCallback(() => {
    const plan = pendingRetry;
    setPendingRetry(null);
    if (plan) {
      void doRetry(plan);
    }
  }, [doRetry, pendingRetry]);

  const cancelRetry = useCallback(() => setPendingRetry(null), []);

  // Retry-confirm modal a11y: Escape cancels, and focus the confirm button on
  // open so keyboard users aren't left on the (still-operable) dock behind the
  // overlay. (The overlay has no focus trap; F1 + the send() guard are the real
  // guards against operating the dock while the dialog is open.)
  const confirmRetryBtnRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    if (!pendingRetry) {
      return;
    }
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        cancelRetry();
      }
    };
    document.addEventListener('keydown', onKey);
    confirmRetryBtnRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [pendingRetry, cancelRetry]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  /**
   * Accept a patch ACTION atomically: apply every still-pending (non-rejected)
   * edit in one pass, then capture a SINGLE checkpoint labeled with the action's
   * explanation. One justification → one checkpoint, no matter how many edits it
   * contains (avoids a burst of duplicate-labeled checkpoints).
   */
  const acceptPatch = useCallback(
    async (msgId_: string) => {
      const convId = active?.id;
      if (!convId || acceptingRef.current || loading) {
        return;
      }
      if (compareActive) {
        // Accepting applies patches to the live doc — forbidden while the
        // frozen compare view is showing (the two would silently diverge).
        setNotice({
          text: 'Exit the checkpoint comparison before accepting a patch.',
          key: Date.now(),
        });
        return;
      }
      const msg = active.messages.find(m => m.id === msgId_);
      if (!msg || msg.action?.kind !== 'patch') {
        return;
      }
      acceptingRef.current = true;
      try {
        const label = msg.action.explanation;
        const edits = msg.edits ?? [];
        let appliedAny = false;
        let staleCount = 0;
        const snapshot = msg.snapshot ?? '';
        for (let i = 0; i < edits.length; i++) {
          if (edits[i].state !== 'pending') {
            continue; // skip edits the user already rejected/resolved
          }
          const res = await applyTextPatch(editor, edits[i].search, edits[i].replace);
          if (res.ok) {
            appliedAny = true;
            // Await so the per-edit state is durable before releasing the guard:
            // retry() reads edit state from the (non-optimistic) store, and a
            // fire-and-forget write here lets a fast Retry see a stale 'pending'
            // snapshot and skip the revert.
            await setEditState(convId, msgId_, i, 'applied');
          } else {
            // Use the structured failure kind: 'not-found' means the doc changed
            // since the AI proposed this (finalize already filtered mis-copies and
            // invalid edits) — if the search WAS in the snapshot (per-paragraph,
            // matching locate's per-block scope), the original text moved/changed
            // → "stale". sentinel/structure/empty → "unlocatable" (the edit is
            // invalid, not stale — don't claim the doc changed).
            const isStale =
              res.kind === 'not-found' &&
              !!snapshot &&
              snapshot.split(/\n\s*\n/).some(p => textContains(p, edits[i].search));
            await setEditState(convId, msgId_, i, isStale ? 'stale' : 'unlocatable');
            if (isStale) {
              staleCount++;
            }
          }
        }
        if (appliedAny) {
          await captureCheckpoint(editor, {
            source: 'ai-accept',
            label: truncate(label, 120) || 'AI chat edit',
          });
        }
        if (staleCount > 0) {
          setNotice({
            text: `⚠ ${staleCount} edit${staleCount === 1 ? '' : 's'} couldn't be applied — the original text changed while the AI was working (the document was edited since this was proposed), so ${staleCount === 1 ? 'that edit' : 'those edits'} can't be completed. Reject ${staleCount === 1 ? 'it' : 'them'} and re-send if you still want the change.`,
            key: Date.now(),
          });
        }
      } catch (err) {
        // applyTextPatch / setEditState / captureCheckpoint can reject (backend
        // down, editor error). Don't let it become an unhandled rejection.
        setNotice({
          text: `⚠ Accept failed: ${
            err instanceof Error ? err.message : String(err)
          }. Some edits may not have been applied.`,
          key: Date.now(),
        });
      } finally {
        acceptingRef.current = false;
      }
    },
    [active, editor, loading, compareActive],
  );

  /** Reject a single edit within a patch (prune it before the action-level Accept). */
  const rejectEdit = useCallback(
    (msgId_: string, editIdx: number) => {
      const convId = active?.id;
      if (!convId) {
        return;
      }
      void setEditState(convId, msgId_, editIdx, 'rejected');
    },
    [active],
  );

  /** Undo an accidental Reject — restore a pruned edit to pending. Only meaningful
   *  before the action-level Accept seals the patch (creates the checkpoint). */
  const restoreEdit = useCallback(
    (msgId_: string, editIdx: number) => {
      const convId = active?.id;
      if (!convId) {
        return;
      }
      void setEditState(convId, msgId_, editIdx, 'pending');
    },
    [active],
  );

  /** Legacy per-edit accept (for pre-streaming messages with `edits` but no action). */
  const acceptEditLegacy = useCallback(
    async (
      msgId_: string,
      editIdx: number,
      search: string,
      replace: string,
      label: string,
    ) => {
      const convId = active?.id;
      if (!convId) {
        return;
      }
      const res = await applyTextPatch(editor, search, replace);
      if (res.ok) {
        await captureCheckpoint(editor, {
          source: 'ai-accept',
          label: truncate(label, 120) || 'AI chat edit',
        });
        void setEditState(convId, msgId_, editIdx, 'applied');
      } else {
        void setEditState(convId, msgId_, editIdx, 'unlocatable');
      }
    },
    [active, editor],
  );

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const ctxLabel =
    selInfo.mode === 'selection'
      ? `Selection · ${selInfo.chars} chars`
      : 'Full document';

  const sendDisabled = !input.trim() || loading || !active || !!pendingRetry;

  return (
    <>
      {!open && (
        <button
          type="button"
          className="side-reopen side-reopen--right"
          onClick={openPanel}
          title="Open AI chat"
          aria-label="Open AI chat">
          ‹ AI
        </button>
      )}
      <aside
        ref={trapRef}
        className={`chat-dock${open ? ' is-open' : ''}`}
        aria-hidden={!open}>
        <SidePanelResizer store={chatPanel} dockSide="right" />
        <header className="chat-header">
          <span className="chat-title">AI</span>
          <span
            className={`chat-ctx chat-ctx--${selInfo.mode}`}
            title={
              selInfo.mode === 'selection'
                ? 'The AI will edit your selection'
                : 'The AI sees the whole document'
            }>
            {ctxLabel}
          </span>
          <div className="chat-header-btns">
            <button
              type="button"
              className={`chat-mem-btn${memoryEnabled ? ' is-on' : ''}`}
              onClick={() => setShowMemory(true)}
              title="AI long-term memory settings"
              aria-label="AI long-term memory settings"
              aria-pressed={memoryEnabled}>
              <span className="chat-mem-dot" aria-hidden="true" />
              Memory
            </button>
            <button
              type="button"
              className="chat-icon-btn"
              onClick={() => setShowSettings(true)}
              title="Configure AI provider"
              aria-label="Configure AI provider">
              ⚙
            </button>
            <button
              type="button"
              className="chat-icon-btn"
              onClick={closePanel}
              title="Collapse"
              aria-label="Collapse AI chat">
              ›
            </button>
          </div>
        </header>

        <div className="chat-switcher">
          <button
            type="button"
            className="chat-switcher-btn"
            onClick={() => setShowList(v => !v)}
            title="Switch conversation"
            aria-label="Switch conversation">
            <span className="chat-switcher-title">
              {active?.title || 'Conversations'}
            </span>
            <span className="chat-switcher-chev">▾</span>
          </button>
          <button
            type="button"
            className="chat-switcher-new"
            onClick={() => {
              void createConversation();
              setShowList(false);
            }}
            title="New conversation"
            aria-label="New conversation">
            + New
          </button>
          {showList && (
            <>
              <div
                className="chat-switcher-backdrop"
                onClick={() => setShowList(false)}
              />
              <div className="chat-switcher-list" role="menu">
                {conversations.length === 0 && (
                  <div className="chat-switcher-empty">No conversations.</div>
                )}
                {conversations.map(c => (
                  <div
                    key={c.id}
                    role="menuitem"
                    className={`chat-conv-item${c.id === activeId ? ' is-active' : ''}`}
                    onClick={() => {
                      void setActiveConversation(c.id);
                      setShowList(false);
                    }}>
                    <span className="chat-conv-title">{c.title || 'Untitled'}</span>
                    <button
                      type="button"
                      className="chat-conv-del"
                      title="Delete conversation"
                      aria-label="Delete conversation"
                      onClick={e => {
                        e.stopPropagation();
                        void deleteConversation(c.id);
                      }}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {notice && (
          <div className="chat-notice" key={notice.key} role="status">
            {notice.text}
            <button
              type="button"
              className="chat-notice-close"
              aria-label="Dismiss"
              onClick={() => setNotice(null)}>
              ✕
            </button>
          </div>
        )}

        {pendingRetry &&
          createPortal(
            <div
              className="ai-overlay"
              role="presentation"
              onClick={cancelRetry}>
              <div
                className="ai-panel retry-panel"
                role="dialog"
                aria-modal="true"
                aria-label="Confirm retry"
                onClick={e => e.stopPropagation()}>
                <div className="cp-header">
                  <h3>Retry this response?</h3>
                  <button
                    type="button"
                    className="cp-close"
                    aria-label="Cancel"
                    onClick={cancelRetry}>
                    ✕
                  </button>
                </div>
                <div className="ai-body">
                  <p className="ai-note">
                    Retrying will <strong>revert {pendingRetry.totalEdits} accepted edit{pendingRetry.totalEdits === 1 ? '' : 's'}</strong> across{' '}
                    {pendingRetry.items.length} response{pendingRetry.items.length === 1 ? '' : 's'} — undone newest-first,
                    back to this one — so the regenerated response can apply cleanly.
                  </p>
                  <ul className="retry-items">
                    {pendingRetry.items.map(it => (
                      <li key={it.msgId} className="retry-item">
                        <span className="retry-badge">{it.count}</span>
                        <span className="retry-label">{it.label}</span>
                      </li>
                    ))}
                  </ul>
                  <p className="ai-note ai-note--muted">
                    Accepted versions are preserved in History.
                  </p>
                </div>
                <div className="ai-footer">
                  <span />
                  <div className="ai-footer-right">
                    <button
                      type="button"
                      className="cp-button cp-button--ghost"
                      onClick={cancelRetry}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="cp-button"
                      ref={confirmRetryBtnRef}
                      onClick={confirmRetry}>
                      Revert &amp; retry
                    </button>
                  </div>
                </div>
              </div>
            </div>,
            document.body,
          )}

        <div className="chat-messages" ref={scrollRef}>
          {messages.length === 0 && !streaming && (
            <div className="chat-empty">
              <p>
                <strong>Select text</strong> to make it the edit target, or leave the
                selection empty to work on the <strong>whole document</strong>.
              </p>
              <p className="chat-empty-sub">
                The AI thinks out loud, then proposes edits as reviewable diffs —
                nothing changes until you accept.
                {!configured && ' (No model configured — open ⚙ to set up your API.)'}
              </p>
            </div>
          )}

          {messages.map(m => {
            const isLive = streamingInPlace && m.id === streaming!.id;
            return (
              <MessageBubble
                key={m.id}
                message={isLive ? streaming! : m}
                live={isLive || undefined}
                busy={loading}
                onAcceptPatch={() => acceptPatch(m.id)}
                onRejectEdit={i => rejectEdit(m.id, i)}
                onRestoreEdit={i => restoreEdit(m.id, i)}
                onAcceptEditLegacy={(i, e, label) =>
                  acceptEditLegacy(m.id, i, e.search, e.replace, label)
                }
                onRetry={retry}
                onAskReply={send}
              />
            );
          })}

          {streaming && !streamingInPlace && (
            <MessageBubble
              key={streaming.id}
              message={streaming}
              live
              busy={loading}
              onAcceptPatch={() => acceptPatch(streaming.id)}
              onRejectEdit={i => rejectEdit(streaming.id, i)}
              onRestoreEdit={i => restoreEdit(streaming.id, i)}
              onAcceptEditLegacy={(i, e, label) =>
                acceptEditLegacy(streaming.id, i, e.search, e.replace, label)
              }
              onRetry={retry}
              onAskReply={send}
            />
          )}
        </div>

        <div className="chat-chips">
          {REWRITE_ACTIONS.map(a => (
            <button
              key={a.id}
              type="button"
              className="chat-chip"
              title={a.hint}
              disabled={loading}
              onClick={() => send(a.label)}>
              {a.label}
            </button>
          ))}
        </div>

        <div className="chat-composer">
          <textarea
            className="chat-input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={onComposerKey}
            placeholder={
              selInfo.mode === 'selection'
                ? 'Ask the AI to edit your selection…'
                : 'Ask the AI about your document…'
            }
            rows={2}
          />
          {loading ? (
            <button
              type="button"
              className="cp-button chat-stop"
              onClick={stop}
              title="Stop generating">
              ■ Stop
            </button>
          ) : (
            <button
              type="button"
              className="cp-button chat-send"
              onClick={() => send()}
              disabled={sendDisabled}>
              Send
            </button>
          )}
        </div>
      </aside>

      {showSettings && <AISettingsPanel onClose={() => setShowSettings(false)} />}
      {showMemory && activeProjectId && (
        <MemoryPanel
          projectId={activeProjectId}
          memories={memories}
          onClose={() => setShowMemory(false)}
        />
      )}
    </>
  );
}

function MessageBubble({
  message,
  live = false,
  busy,
  onAcceptPatch,
  onRejectEdit,
  onRestoreEdit,
  onAcceptEditLegacy,
  onRetry,
  onAskReply,
}: {
  message: ChatMessage;
  live?: boolean;
  busy: boolean;
  /** Action-level accept (new patch actions): applies all non-rejected edits → 1 checkpoint. */
  onAcceptPatch: () => void;
  /** Per-edit reject (prune one edit before the action-level Accept). */
  onRejectEdit: (editIdx: number) => void;
  /** Undo an accidental reject (restore a pruned edit to pending). */
  onRestoreEdit: (editIdx: number) => void;
  /** Legacy per-edit accept (messages with `edits` but no `action`). */
  onAcceptEditLegacy: (editIdx: number, edit: {search: string; replace: string}, label: string) => void;
  onRetry: (assistantId: string) => void;
  onAskReply: (text: string) => void;
}): JSX.Element {
  const editOps = useMemo(
    () =>
      (message.edits ?? []).map(e =>
        diffBlocks(plainTextToBlocks(e.search), plainTextToBlocks(e.replace)),
      ),
    [message.edits],
  );

  // Thoughts pane: open while streaming, collapsed once finalized (VS Code-style).
  const [thinkOpen, setThinkOpen] = useState(live);
  const [askText, setAskText] = useState('');
  // An in-place retry reuses this instance (same key), so `live` transitions
  // false→true without remounting — re-open the pane when it goes live.
  useEffect(() => {
    if (live) {
      setThinkOpen(true);
    }
  }, [live]);

  const hasThinking = !!(message.thinking && message.thinking.length > 0);
  const showThinking = live || hasThinking;
  const edits = message.edits ?? [];
  const isAtomicPatch = message.action?.kind === 'patch';
  const patchLabel =
    message.action?.kind === 'patch' ? message.action.explanation : undefined;
  const hasPendingEdit = edits.some(e => e.state === 'pending');
  const pendingEditCount = edits.filter(e => e.state === 'pending').length;
  // The patch is sealed once the action-level Accept has run (any edit applied or
  // unlocatable) or it was reverted for retry — before that, a rejected edit can
  // still be restored to pending.
  const actionSealed = edits.some(
    e =>
      e.state === 'applied' ||
      e.state === 'unlocatable' ||
      e.state === 'stale' ||
      e.state === 'reverted',
  );

  if (message.role === 'user') {
    return (
      <div className="chat-msg chat-msg--user">
        <div className="chat-bubble chat-bubble--user">{message.text}</div>
      </div>
    );
  }

  const submitAsk = () => {
    const t = askText.trim();
    if (!t) {
      return;
    }
    setAskText('');
    onAskReply(t);
  };

  const onAskKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submitAsk();
    }
  };

  return (
    <div
      className={`chat-msg chat-msg--assistant${live ? ' is-live' : ''}`}
      data-msg-id={message.id}>
      {showThinking && (
        <div className={`chat-thinking-pane${thinkOpen ? ' is-open' : ''}${live ? ' is-live' : ''}`}>
          <button
            type="button"
            className="chat-thinking-toggle"
            onClick={() => setThinkOpen(o => !o)}
            aria-expanded={thinkOpen}>
            <span className="chat-thinking-chev">▸</span>
            <span className="chat-thinking-label">
              {live && !hasThinking ? 'Thinking…' : 'Thoughts'}
            </span>
          </button>
          {thinkOpen && (
            <div className="chat-thinking-body">
              {message.thinking || (live ? '…' : '')}
            </div>
          )}
        </div>
      )}

      {(message.steps ?? []).map(s => (
        <div
          className={`chat-step${s.depth ? ` chat-step--nested` : ''}`}
          key={s.at}
          style={s.depth ? {marginLeft: Math.min(s.depth, 3) * 14} : undefined}>
          {s.kind !== 'remember' && (
            <span className="chat-step-icon">{STEP_ICON[s.kind] ?? '🔧'}</span>
          )}
          <span className="chat-step-text">{stepLabel(s)}</span>
          {s.hits !== undefined && (
            <span className="chat-step-hits">
              {s.hits}
              {s.hits === 1 ? ' match' : ' matches'}
            </span>
          )}
        </div>
      ))}

      {message.text && (
        <div className="chat-bubble chat-bubble--assistant">
          <Markdown>{message.text}</Markdown>
        </div>
      )}
      {message.patchFailure && (
        <div className="chat-bubble chat-bubble--assistant chat-patch-failure">
          {message.patchFailure === 'stale'
            ? '⚠ This edit couldn’t be applied — the original text changed while the AI was working, so the task can’t be completed.'
            : message.patchFailure === 'invalid'
              ? `⚠ This edit can’t be applied as proposed${
                  message.patchFailureReason ? ` — ${message.patchFailureReason}` : ''
                }. Try rephrasing or re-send.`
              : `⚠ Patch skipped — couldn’t produce a matching edit after ${MAX_PATCH_ATTEMPTS} attempts. Try rephrasing or re-send.`}
        </div>
      )}
      {message.error ? (
        <div className="chat-bubble chat-bubble--assistant chat-error">
          ⚠ {message.error}
        </div>
      ) : (
        <>
          {patchLabel && edits.length > 0 && (
            <div className="chat-edit-explanation">✎ {patchLabel}</div>
          )}
          {edits.map((e, i) => (
            <div key={i} className="chat-edit">
              <div className="chat-edit-label">
                {edits.length > 1 ? `Edit ${i + 1}` : 'Proposed edit'}
              </div>
              <div className="chat-edit-diff">
                <DiffView ops={editOps[i]} />
              </div>
              <div className="chat-edit-actions">
                {e.state === 'pending' &&
                  (isAtomicPatch ? (
                    /* Atomic flow: prune individual edits before the action-level
                       Accept below (no per-edit Accept — one Accept = one checkpoint). */
                    <button
                      type="button"
                      className="cp-button cp-button--ghost"
                      onClick={() => onRejectEdit(i)}>
                      Reject
                    </button>
                  ) : (
                    /* Legacy per-edit Accept/Reject (messages without an action). */
                    <>
                      <button
                        type="button"
                        className="cp-button"
                        disabled={busy}
                        onClick={() =>
                          onAcceptEditLegacy(i, e, patchLabel ?? 'AI chat edit')
                        }>
                        Accept
                      </button>
                      <button
                        type="button"
                        className="cp-button cp-button--ghost"
                        onClick={() => onRejectEdit(i)}>
                        Reject
                      </button>
                    </>
                  ))}
                {e.state === 'applied' && (
                  <span className="chat-edit-status chat-edit-status--ok">✓ Applied</span>
                )}
                {e.state === 'reverted' && (
                  <span className="chat-edit-status">↩ Reverted</span>
                )}
                {e.state === 'rejected' &&
                  (actionSealed ? (
                    <span className="chat-edit-status">Rejected</span>
                  ) : (
                    /* Before the action-level Accept seals the patch, an accidental
                       Reject can be undone — restore the edit to pending. */
                    <button
                      type="button"
                      className="cp-button cp-button--ghost chat-edit-undo"
                      onClick={() => onRestoreEdit(i)}>
                      ↩ Undo reject
                    </button>
                  ))}
                {(e.state === 'unlocatable' || e.state === 'stale') && (
                  <span className="chat-edit-status chat-edit-status--err">
                    {e.state === 'stale'
                      ? '⚠ The original text changed while the AI was working — can’t apply'
                      : '⚠ Couldn’t locate this passage (it may have changed)'}
                  </span>
                )}
              </div>
            </div>
          ))}

          {/* Action-level Accept: applies every still-pending edit and captures ONE
              checkpoint for the whole justification. */}
          {isAtomicPatch && hasPendingEdit && (
            <div className="chat-edit-action-footer">
              <button
                type="button"
                className="cp-button"
                disabled={busy}
                onClick={onAcceptPatch}>
                Accept {pendingEditCount} edit{pendingEditCount === 1 ? '' : 's'}
              </button>
            </div>
          )}

          {message.action?.kind === 'ask' && (
            <div className="chat-action chat-action-ask">
              {message.action.question && (
                <div className="chat-ask-question">
                  <Markdown>{message.action.question}</Markdown>
                </div>
              )}
              <div className="chat-ask-options">
                {message.action.options.map((o, i) => (
                  <button
                    key={i}
                    type="button"
                    className="cp-button cp-button--ghost chat-ask-option"
                    disabled={busy}
                    onClick={() => onAskReply(o)}>
                    {o}
                  </button>
                ))}
              </div>
              <div className="chat-ask-freeform">
                <input
                  className="chat-ask-input"
                  placeholder="Type your own… / chat about this"
                  value={askText}
                  onChange={e => setAskText(e.target.value)}
                  onKeyDown={onAskKey}
                  disabled={busy}
                />
                <button
                  type="button"
                  className="cp-button chat-ask-send"
                  disabled={busy || !askText.trim()}
                  onClick={submitAsk}>
                  Send
                </button>
              </div>
            </div>
          )}

          {message.action?.kind === 'finish' && (
            <div className="chat-action chat-finish">
              ✓ {message.action.summary || 'Done'}
            </div>
          )}

          {/* Persistent "still working" indicator: the three dots stay up for the
              whole stream (including across read/search agent turns), not just
              before the first token. */}
          {live && (
            <div className="chat-thinking" aria-label="AI is still working">
              <span />
              <span />
              <span />
            </div>
          )}
        </>
      )}

      {!live && (
        <div className="chat-msg-actions">
          <button
            type="button"
            className="chat-retry"
            disabled={busy}
            onClick={() => onRetry(message.id)}
            title="Regenerate this response">
            ↻ Retry
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Modal overlay for the AI's long-term, project-scoped memory: an on/off toggle,
 * the list of notes (deletable), and a box to add a note manually. The notes are
 * injected into the agent's system prompt (when on); the agent can also add
 * notes via its `remember` action.
 */
function MemoryPanel({
  projectId,
  memories,
  onClose,
}: {
  projectId: string;
  memories: Memory[];
  onClose: () => void;
}): JSX.Element {
  const enabled = useMemoryEnabled();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const add = async () => {
    const t = text.trim();
    if (!t) {
      return;
    }
    setSaving(true);
    try {
      await addMemory(projectId, t);
      setText('');
    } finally {
      setSaving(false);
    }
  };

  const onTextKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void add();
    }
  };

  return (
    <div className="mem-overlay" onClick={onClose}>
      <div
        className="mem-panel"
        role="dialog"
        aria-label="AI long-term memory"
        onClick={e => e.stopPropagation()}>
        <header className="mem-header">
          <span className="mem-title">Memory</span>
          <button
            type="button"
            className="mem-close"
            onClick={onClose}
            aria-label="Close">
            ✕
          </button>
        </header>

        <div className="mem-toggle-row">
          <label className="mem-switch">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setMemoryEnabled(e.target.checked)}
            />
            <span className="mem-switch-track" />
          </label>
          <div className="mem-toggle-text">
            <div className="mem-toggle-label">Long-term memory</div>
            <div className="mem-toggle-hint">
              {enabled
                ? 'On — the AI reads these notes before responding and can save new ones.'
                : 'Off — the AI will not read or save memory.'}
            </div>
          </div>
        </div>

        <div className="mem-list">
          {memories.length === 0 && (
            <div className="mem-empty">
              No notes yet. When memory is on, the AI saves important project
              context here as it works — including per-paper notes for uploaded
              literature.
            </div>
          )}
          {groupMemories(memories).map(group => (
            <div className="mem-group" key={group.key}>
              {group.title !== null && (
                <div className="mem-group-title" title={group.title}>
                  📄 {group.title}
                </div>
              )}
              {group.notes.map(m => (
                <div className="mem-item" key={m.id}>
                  <div className="mem-item-body">{m.content}</div>
                  <button
                    type="button"
                    className="mem-item-del"
                    title="Delete note"
                    aria-label="Delete note"
                    onClick={() => void deleteMemory(m.id)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="mem-add">
          <textarea
            className="mem-add-input"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={onTextKey}
            placeholder="Add a note for the AI… (⌘/Ctrl-Enter)"
            rows={2}
          />
          <button
            type="button"
            className="cp-button mem-add-btn"
            disabled={saving || !text.trim()}
            onClick={() => void add()}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
