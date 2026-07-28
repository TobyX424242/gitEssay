/**
 * gitEssay — composer send hook (extracted from ChatSidebar).
 *
 * Owns the composer input and the send path: capture the current selection as
 * sentinel-laden context, append the user message (deriving a title for a fresh
 * conversation), then hand off to the shared agent run. Guards against sending
 * while a run is streaming, a retry-confirm dialog is open, or an accept/revert
 * is in flight.
 */
import type {LexicalEditor} from 'lexical';
import {useCallback, useRef, useState} from 'react';

import {appendMessages, type Conversation} from './conversations';
import {deriveTitle, msgId} from './chatUtils';
import {selectionToSentinelText} from './sentinels';
import type {PendingRetry} from './usePatchApply';
import type {StartRunArgs} from './useAgentRun';
import type {ChatMessage, MessageContext} from './types';

/** Context captured at send time and stored on the user message (drives Retry). */
type SendContext = MessageContext;

export function useSendMessage({
  editor,
  active,
  loading,
  pendingRetry,
  acceptingRef,
  startRun,
}: {
  editor: LexicalEditor;
  active: Conversation | null | undefined;
  loading: boolean;
  pendingRetry: PendingRetry | null;
  acceptingRef: React.MutableRefObject<boolean>;
  startRun: (args: StartRunArgs) => void;
}): {
  input: string;
  setInput: (v: string) => void;
  send: (instruction?: string) => void;
} {
  const [input, setInput] = useState('');
  // Synchronous in-flight guard: `loading` only flips true on the re-render
  // AFTER the run starts, so without this two quick sends (e.g. double-clicking
  // a quick-action chip) both pass the guard while the first is still awaiting
  // appendMessages — the second run then supersedes and kills the first.
  const sendingRef = useRef(false);

  const captureSelection = useCallback(
    (instruction: string): SendContext => {
      // Sentinel-laden selection text (citations/equations → opaque tokens), so a
      // patch the model writes against the selection locates consistently in the
      // live document (whose decorator nodes flatten to the same tokens).
      const selectionText = selectionToSentinelText(editor);
      void instruction; // instruction is stored separately on the user message
      return selectionText && selectionText.length > 0
        ? {mode: 'selection', selectionText}
        : {mode: 'document'};
    },
    [editor],
  );

  const send = useCallback(
    (instruction?: string) => {
      const text = (instruction ?? input).trim();
      if (
        !text ||
        loading ||
        sendingRef.current ||
        !active ||
        pendingRetry ||
        acceptingRef.current
      ) {
        return;
      }
      sendingRef.current = true;
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
      // Persist the user message BEFORE starting the run: fire-and-forget
      // (`void appendMessages(...); startRun(...)`) races the streaming
      // persist and can silently drop the message.
      void (async () => {
        try {
          await appendMessages(convId, [userMsg], title);
          startRun({
            convId,
            instruction: text,
            mode: ctx.mode,
            selectionText: ctx.selectionText,
            priorMessages,
            streamingId: msgId(),
            replace: false,
          });
        } catch (err) {
          // The persist failed (backend down): put the instruction BACK in the
          // composer so the user's typed text is never silently lost, and log
          // the cause (there is no persisted place to surface it offline).
          console.error('send failed — restoring composer text:', err);
          setInput(text);
        } finally {
          sendingRef.current = false;
        }
      })();
    },
    [active, captureSelection, input, loading, pendingRetry, startRun, acceptingRef],
  );

  return {input, setInput, send};
}
