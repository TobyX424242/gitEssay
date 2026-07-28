/**
 * gitEssay — agent run hook (extracted from ChatSidebar).
 *
 * Owns the live-stream state (streaming bubble, loading flag, abort controller)
 * and the shared run path for send + retry (`startRun`): the model's thinking
 * streams into the bubble, then each run ends in one terminal action — patch,
 * ask, or finish. A patch is validated against the document snapshot and
 * re-prompted on a mis-copy or unparseable LaTeX (each bounded independently);
 * a stale or structurally invalid patch is marked failed instead.
 *
 * Runs are keyed BY CONVERSATION. Switching conversations never interrupts a
 * run: it keeps streaming in the background, persists to its own conversation
 * when done, and the live bubble reappears when you switch back. `loading` is
 * per-conversation too, so another conversation's composer stays usable while
 * a run streams. A PROJECT switch cancels every run (cancelAll) — the document
 * is swapped out, so patch validation would target the wrong doc.
 */
import type {LexicalEditor} from 'lexical';
import {useCallback, useRef, useState} from 'react';

import {docParagraphs, messagesToHistory, runAgentGraph} from './agentClient';
import {appendMessages, replaceMessage} from './conversations';
import {
  APPEND_LATEX_NONCE,
  classifyPatch,
  latexFeedback,
  MAX_PATCH_ATTEMPTS,
  patchFeedback,
  withPatchFailure,
} from './patchValidate';
import type {ChatTurn} from '../rewrite/llmClient';
import type {ChatMessage, ChatMode} from './types';

/** Arguments for one agent run (a fresh send or an in-place retry). */
export interface StartRunArgs {
  convId: string;
  instruction: string;
  mode: ChatMode;
  selectionText?: string;
  priorMessages: ChatMessage[];
  streamingId: string;
  replace: boolean;
}

export interface AgentRun {
  /** Live bubble of the ACTIVE conversation's run (null when it has none). */
  streaming: ChatMessage | null;
  /** True while the ACTIVE conversation has a run in flight. */
  loading: boolean;
  /** The message id kept in view during/after a retry (its target), so the live
   *  stream and the finalized patch card don't get scrolled off to the bottom.
   *  Set on a retry, cleared on a fresh send or a conversation switch. */
  pinnedIdRef: React.MutableRefObject<string | null>;
  startRun: (args: StartRunArgs) => void;
  /** Abort the ACTIVE conversation's run (the Stop button). The partial
   *  message still persists to its conversation via the normal finalize path. */
  stop: () => void;
  /** Abort EVERY in-flight run and drop all live state immediately (project
   *  switch). Aborted runs still persist their partial messages to their own
   *  conversations — only the UI moves on. */
  cancelAll: () => void;
}

/** Live state of one conversation's in-flight run. */
interface RunEntry {
  message: ChatMessage;
  controller: AbortController;
}

export function useAgentRun({
  editor,
  configured,
  activeProjectId,
  activeConvId,
  memoryEnabled,
}: {
  editor: LexicalEditor;
  configured: boolean;
  activeProjectId: string | null;
  activeConvId: string | null;
  memoryEnabled: boolean;
}): AgentRun {
  const [runs, setRuns] = useState<Record<string, RunEntry>>({});
  const pinnedIdRef = useRef<string | null>(null);
  // Mirrors for the stable callbacks (stop/cancelAll) so they always see the
  // latest runs + active conversation without re-creating.
  const runsRef = useRef(runs);
  runsRef.current = runs;
  const activeConvIdRef = useRef(activeConvId);
  activeConvIdRef.current = activeConvId;

  /**
   * Shared run path for send + retry. `replace` swaps an existing assistant
   * message (retry); otherwise the finalized message is appended. `streamingId`
   * is the id the live bubble uses (a fresh id for send, the target id for retry).
   */
  const startRun = useCallback(
    (args: StartRunArgs) => {
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
      // Pin a retry's target into view (live stream + finalized patch card); a
      // fresh send has no pin, so it scrolls to the bottom as usual.
      pinnedIdRef.current = args.replace ? args.streamingId : null;
      const entry: RunEntry = {
        controller,
        message: {
          id: args.streamingId,
          role: 'assistant',
          text: '',
          mode: args.mode,
          streaming: true,
          steps: [],
          action: null,
        },
      };
      // Supersede any in-flight run for this conversation: two sends can slip
      // past the `loading` guard while the first still persists its user
      // message (await appendMessages). Abort the old run (stops the stream +
      // token burn) and take the slot SYNCHRONOUSLY via runsRef so the old
      // run's persist path sees it is stale and drops its result instead of
      // appending a duplicate assistant message.
      runsRef.current[args.convId]?.controller.abort();
      runsRef.current = {...runsRef.current, [args.convId]: entry};
      setRuns(rs => ({...rs, [args.convId]: entry}));
      // Merge into THIS run's bubble only — a stale update (entry replaced by
      // a newer run in the same conversation, or the run already finished)
      // is dropped, never clobbers another conversation's bubble.
      const patchRun = (fn: (m: ChatMessage) => ChatMessage) =>
        setRuns(rs => {
          const r = rs[args.convId];
          if (!r || r.controller !== controller || r.message.id !== args.streamingId) {
            return rs;
          }
          return {...rs, [args.convId]: {...r, message: fn(r.message)}};
        });

      const history = messagesToHistory(args.priorMessages);
      // Snapshot of the document the AI is given for THIS run. Recorded per turn
      // (context varies even within one conversation) so a failing patch can be
      // classified: mis-copy (search never in the snapshot) vs stale (search was
      // in the snapshot but the live doc changed).
      const snapshot = docParagraphs(editor).join('\n\n');
      // One engine run with a given history + instruction — used for the first
      // attempt and each mis-copy retry. Resets the streaming bubble each time so
      // the retry streams cleanly into the same slot.
      const runOnce = (h: ChatTurn[], instr: string): Promise<ChatMessage> => {
        patchRun(m => ({
          ...m,
          text: '',
          thinking: undefined,
          steps: [],
          action: null,
          edits: undefined,
        }));
        return runAgentGraph({
          editor,
          mode: args.mode,
          selectionText: args.selectionText,
          signal: controller.signal,
          // Long-term memory is owned by the backend (it runs the remember
          // tool); the frontend only forwards the on/off toggle.
          memoryEnabled,
          history: h,
          instruction: instr,
          onUpdate: (patch: Partial<ChatMessage>) => patchRun(m => ({...m, ...patch})),
          projectId: activeProjectId ?? '',
        });
      };

      // Multi-layer fallback: validate the patch the AI produced; re-prompt on a
      // mis-copy or unparseable LaTeX (each bounded independently), or mark it
      // failed if the doc changed under the AI or the edit is structurally invalid.
      let attempts = 0;
      let latexAttempts = 0;
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
        const hasPatchEdits =
          (msg.edits?.length ?? 0) > 0 ||
          (msg.eqEdits?.length ?? 0) > 0 ||
          (msg.appendEdits?.length ?? 0) > 0;
        if (msg.action?.kind === 'patch' && hasPatchEdits) {
          const cls = classifyPatch(
            editor,
            msg.edits ?? [],
            snapshot,
            msg.eqEdits ?? [],
            msg.appendEdits ?? [],
          );
          const {issue, reason} = cls;
          if (issue === 'stale') {
            // The passage the AI was editing is gone from the live doc — the doc
            // changed while it worked. The patch can't complete; tell the user.
            return Promise.resolve(withPatchFailure(msg, 'stale', snapshot));
          }
          if (issue === 'invalid') {
            // Structurally un-applicable (sentinel/structure/bad equation token).
            // Re-prompting won't reliably fix it; fail the patch with the reason.
            return Promise.resolve(withPatchFailure(msg, 'invalid', snapshot, reason));
          }
          if (issue === 'invalid-latex') {
            // Unparseable LaTeX in an equation edit — RETRYABLE: re-prompt the
            // model to fix the syntax (bounded). Past the budget, reject ONLY the
            // failing equation edits; text edits stay pending for the user.
            latexAttempts += 1;
            if (latexAttempts > MAX_PATCH_ATTEMPTS) {
              const failures = cls.latexFailures ?? [];
              const eqEdits = (msg.eqEdits ?? []).map(e => {
                const f = failures.find(x => x.nonce === e.nonce);
                return f ? {...e, state: 'rejected' as const, failReason: f.error} : e;
              });
              // Append edits fail when one of their NEW $$…$$ equations is bad.
              const appendEdits = (msg.appendEdits ?? []).map(e => {
                const f = failures.find(
                  x => x.nonce === APPEND_LATEX_NONCE && e.text.includes(x.latex),
                );
                return f ? {...e, state: 'rejected' as const, failReason: f.error} : e;
              });
              return Promise.resolve({...msg, eqEdits, appendEdits, snapshot});
            }
            const failedText =
              msg.text?.trim() || '(proposed a patch with invalid LaTeX)';
            const feedback = latexFeedback(cls.latexFailures ?? []);
            // Accumulate prior attempts (same anti-rotation rationale as mis-copy).
            const nextHistory: ChatTurn[] = [
              ...accHistory,
              {role: 'user', content: prevInstruction},
              {role: 'assistant', content: failedText},
            ];
            return runOnce(nextHistory, feedback).then(m =>
              finalize(m, nextHistory, feedback),
            );
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
            const feedback = patchFeedback(msg.edits ?? []);
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
          // Superseded by a newer run in this conversation while this one
          // settled — drop the stale result, never persist a duplicate.
          if (runsRef.current[args.convId]?.controller !== controller) {
            return;
          }
          const persisted: ChatMessage = {...finalMsg, id: args.streamingId};
          // Await the persist so the store holds the new message BEFORE we drop
          // the live streaming bubble — otherwise the non-optimistic refetch
          // leaves the OLD (pre-retry) message visible for a frame (a flicker)
          // on an in-place retry. Targets args.convId, so a background run
          // lands in its OWN conversation even if the user is elsewhere.
          if (args.replace) {
            await replaceMessage(args.convId, args.streamingId, persisted);
          } else {
            await appendMessages(args.convId, [persisted]);
          }
        })
        .catch((err: unknown) => {
          if (runsRef.current[args.convId]?.controller !== controller) {
            return; // superseded — the error belongs to the dropped run
          }
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
          // Drop this run's entry — but only if it is still THIS run (a newer
          // run may have taken the conversation's slot while this one settled).
          if (runsRef.current[args.convId]?.controller === controller) {
            const next = {...runsRef.current};
            delete next[args.convId];
            runsRef.current = next;
          }
          setRuns(rs => {
            const r = rs[args.convId];
            if (!r || r.controller !== controller) {
              return rs;
            }
            const next = {...rs};
            delete next[args.convId];
            return next;
          });
        });
    },
    [activeProjectId, configured, editor, memoryEnabled],
  );

  const stop = useCallback(() => {
    const id = activeConvIdRef.current;
    if (id) {
      runsRef.current[id]?.controller.abort();
    }
  }, []);

  const cancelAll = useCallback(() => {
    Object.values(runsRef.current).forEach(r => r.controller.abort());
    setRuns({});
  }, []);

  const activeRun = activeConvId ? runs[activeConvId] : undefined;
  return {
    streaming: activeRun?.message ?? null,
    loading: !!activeRun,
    pinnedIdRef,
    startRun,
    stop,
    cancelAll,
  };
}
