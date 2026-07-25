/**
 * gitEssay — agent run hook (extracted from ChatSidebar).
 *
 * Owns the live-stream state (streaming bubble, loading flag, abort controller)
 * and the shared run path for send + retry (`startRun`): the model's thinking
 * streams into the bubble, then each run ends in one terminal action — patch,
 * ask, or finish. A patch is validated against the document snapshot and
 * re-prompted on a mis-copy or unparseable LaTeX (each bounded independently);
 * a stale or structurally invalid patch is marked failed instead.
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
  streaming: ChatMessage | null;
  loading: boolean;
  /** The message id kept in view during/after a retry (its target), so the live
   *  stream and the finalized patch card don't get scrolled off to the bottom.
   *  Set on a retry, cleared on a fresh send or a conversation switch. */
  pinnedIdRef: React.MutableRefObject<string | null>;
  startRun: (args: StartRunArgs) => void;
  stop: () => void;
}

export function useAgentRun({
  editor,
  configured,
  activeProjectId,
  memoryEnabled,
}: {
  editor: LexicalEditor;
  configured: boolean;
  activeProjectId: string | null;
  memoryEnabled: boolean;
}): AgentRun {
  const [streaming, setStreaming] = useState<ChatMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const pinnedIdRef = useRef<string | null>(null);

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
    [activeProjectId, configured, editor, memoryEnabled],
  );

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return {streaming, loading, pinnedIdRef, startRun, stop};
}
