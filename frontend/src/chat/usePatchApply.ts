/**
 * gitEssay — patch apply / retry hook (extracted from ChatSidebar).
 *
 * Owns every chat-driven mutation of the live document and of per-edit state:
 * the action-level Accept (apply all pending edits → ONE checkpoint), per-edit
 * Reject/Undo-reject (text, equation, append), the legacy per-edit Accept, and
 * the Retry flow (plan → confirm dialog → LIFO revert → regenerate). All of
 * these share one re-entrancy guard (`acceptingRef`): applying edits +
 * persisting per-edit state is async, and the conversations store is NOT
 * optimistic, so a retry reading a snapshot mid-accept would see stale
 * 'pending' edits and skip the revert.
 */
import type {LexicalEditor} from 'lexical';
import {useCallback, useEffect, useRef, useState} from 'react';

import {captureCheckpoint} from '../checkpoints/service';
import type {Conversation} from './conversations';
import {
  setAppendEditState,
  setEditState,
  setEqEditState,
} from './conversations';
import {applyAppendPatch, applyEquationPatch, applyTextPatch, textContains} from './patch';
import {buildRetryPlan, lifoRevertSteps} from './retry';
import type {RetryPlan} from './retry';
import {truncate, type ChatNotice} from './chatUtils';
import type {StartRunArgs} from './useAgentRun';

/** A retry plan plus the conversation it belongs to (dialog state). */
export type PendingRetry = RetryPlan & {convId: string};

export interface PatchApply {
  /** Shared re-entrancy guard for the accept/revert paths (also read by send). */
  acceptingRef: React.MutableRefObject<boolean>;
  pendingRetry: PendingRetry | null;
  confirmRetryBtnRef: React.RefObject<HTMLButtonElement | null>;
  acceptPatch: (msgId: string) => Promise<void>;
  rejectEdit: (msgId: string, editIdx: number) => void;
  restoreEdit: (msgId: string, editIdx: number) => void;
  rejectEqEdit: (msgId: string, editIdx: number) => void;
  restoreEqEdit: (msgId: string, editIdx: number) => void;
  rejectAppendEdit: (msgId: string, editIdx: number) => void;
  restoreAppendEdit: (msgId: string, editIdx: number) => void;
  acceptEditLegacy: (
    msgId: string,
    editIdx: number,
    search: string,
    replace: string,
    label: string,
  ) => Promise<void>;
  retry: (assistantId: string) => void;
  confirmRetry: () => void;
  cancelRetry: () => void;
}

export function usePatchApply({
  editor,
  active,
  loading,
  compareActive,
  startRun,
  setNotice,
}: {
  editor: LexicalEditor;
  active: Conversation | null | undefined;
  loading: boolean;
  compareActive: boolean;
  startRun: (args: StartRunArgs) => void;
  setNotice: (n: ChatNotice | null) => void;
}): PatchApply {
  // Re-entrancy guard for the accept/revert paths. Applying edits + persisting
  // per-edit state is async, and the conversations store is NOT optimistic (each
  // write awaits HTTP then refetches), so retry() reading a snapshot mid-accept
  // would see stale 'pending' edits and skip the revert. Block retry (and a
  // second accept) while one is in flight.
  const acceptingRef = useRef(false);
  const [pendingRetry, setPendingRetry] = useState<PendingRetry | null>(null);

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
          text: 'Exit the comparison before accepting a patch.',
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
        const eqEdits = msg.eqEdits ?? [];
        const appendEdits = msg.appendEdits ?? [];
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
        // Equation edits: dedicated LaTeX patches, applied after the text edits.
        // applyEquationPatch re-validates the LaTeX (KaTeX) before touching the
        // document, so a bad formula can never corrupt the rendered equation.
        for (let i = 0; i < eqEdits.length; i++) {
          if (eqEdits[i].state !== 'pending') {
            continue;
          }
          const res = await applyEquationPatch(editor, eqEdits[i].nonce, eqEdits[i].latex);
          if ('prevLatex' in res) {
            appliedAny = true;
            // Record prevLatex so a later Retry can LIFO-revert this edit.
            await setEqEditState(convId, msgId_, i, 'applied', {
              prevLatex: res.prevLatex,
            });
          } else {
            await setEqEditState(
              convId,
              msgId_,
              i,
              res.kind === 'invalid-latex' ? 'rejected' : 'unlocatable',
              {failReason: res.reason},
            );
          }
        }
        // Append edits last, so the new content lands at the very end of the
        // document even when the same patch also edited existing text.
        for (let i = 0; i < appendEdits.length; i++) {
          if (appendEdits[i].state !== 'pending') {
            continue;
          }
          const res = await applyAppendPatch(editor, appendEdits[i].text);
          if ('paragraphs' in res) {
            appliedAny = true;
            await setAppendEditState(convId, msgId_, i, 'applied');
          } else {
            await setAppendEditState(
              convId,
              msgId_,
              i,
              res.kind === 'invalid-latex' ? 'rejected' : 'unlocatable',
              {failReason: res.reason},
            );
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
            text: `⚠ ${staleCount} edit${staleCount === 1 ? '' : 's'} couldn't be applied — the original text changed since ${staleCount === 1 ? 'it was' : 'they were'} proposed. Reject and re-send to try again.`,
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
    [active, editor, loading, compareActive, setNotice],
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

  /** Equation-edit counterparts of rejectEdit / restoreEdit. */
  const rejectEqEdit = useCallback(
    (msgId_: string, editIdx: number) => {
      const convId = active?.id;
      if (!convId) {
        return;
      }
      void setEqEditState(convId, msgId_, editIdx, 'rejected');
    },
    [active],
  );

  const restoreEqEdit = useCallback(
    (msgId_: string, editIdx: number) => {
      const convId = active?.id;
      if (!convId) {
        return;
      }
      void setEqEditState(convId, msgId_, editIdx, 'pending');
    },
    [active],
  );

  /** Append-edit counterparts of rejectEdit / restoreEdit. */
  const rejectAppendEdit = useCallback(
    (msgId_: string, editIdx: number) => {
      const convId = active?.id;
      if (!convId) {
        return;
      }
      void setAppendEditState(convId, msgId_, editIdx, 'rejected');
    },
    [active],
  );

  const restoreAppendEdit = useCallback(
    (msgId_: string, editIdx: number) => {
      const convId = active?.id;
      if (!convId) {
        return;
      }
      void setAppendEditState(convId, msgId_, editIdx, 'pending');
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
          text: 'Exit the comparison before retrying — retrying reverts edits in the live document.',
          key: Date.now(),
        });
        return null;
      }
      const plan = buildRetryPlan(active.messages, assistantId);
      return plan ? {convId: active.id, ...plan} : null;
    },
    [active, loading, compareActive, setNotice],
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
          if (step.kind === 'eq') {
            // Equation edit: restore the LaTeX recorded when it was applied.
            const res = await applyEquationPatch(editor, step.nonce, step.prevLatex);
            if ('prevLatex' in res) {
              undone++;
              await setEqEditState(plan.convId, step.msgId, step.editIndex, 'reverted');
            } else {
              failed++;
            }
            continue;
          }
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
            } so the new attempt can apply cleanly. Accepted versions stay in History.`,
            key: Date.now(),
          });
        } else if (undone > 0) {
          setNotice({
            text: `↩ Reverted ${undone} of ${plan.totalEdits} edit${
              plan.totalEdits === 1 ? '' : 's'
            }; ${skippedDetail}. The new patch may not apply to those parts.`,
            key: Date.now(),
          });
        } else {
          setNotice({
            text: `Couldn't revert the edit(s) (${skippedDetail}). Retrying anyway — the new patch may not apply.`,
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
    [editor, startRun, setNotice],
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

  return {
    acceptingRef,
    pendingRetry,
    confirmRetryBtnRef,
    acceptPatch,
    rejectEdit,
    restoreEdit,
    rejectEqEdit,
    restoreEqEdit,
    rejectAppendEdit,
    restoreAppendEdit,
    acceptEditLegacy,
    retry,
    confirmRetry,
    cancelRetry,
  };
}
