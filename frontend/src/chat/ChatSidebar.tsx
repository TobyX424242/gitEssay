/**
 * gitEssay — AI chat sidebar (VS Code-style right dock).
 *
 * Always-available conversation surface. The send/retry path runs the STREAMING
 * LangGraph agent (runAgentGraph): the model's thinking streams into a collapsible
 * Thoughts pane (expanded live, auto-collapsed when the turn finishes), and each
 * turn ends in one terminal action — patch (reviewable diffs, checkpointed on
 * accept with the model's explanation as the label), ask (options + a free-text
 * box), or finish. read/search steps show as chips. A Stop button aborts
 * mid-stream.
 *
 * This file is the composition root; the logic lives in focused modules:
 * useAgentRun (streaming run + patch re-prompt loop), useSendMessage (composer
 * send), usePatchApply (accept/reject/revert/retry), MessageBubble, MemoryPanel,
 * RetryConfirmDialog, ConversationSwitcher.
 */
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$getSelection, $isNodeSelection, $isRangeSelection} from 'lexical';
import {
  type JSX,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import {REWRITE_ACTIONS} from '../rewrite/actions';
import {isConfigured, useAISettings} from '../rewrite/aiSettings';
import AISettingsPanel from '../rewrite/AISettingsPanel';

import {bootstrapConversations, useConversations} from './conversations';
import {type ChatNotice} from './chatUtils';
import ConversationSwitcher from './ConversationSwitcher';
import MemoryPanel from './MemoryPanel';
import MessageBubble from './MessageBubble';
import RetryConfirmDialog from './RetryConfirmDialog';
import {useAgentRun} from './useAgentRun';
import {usePatchApply} from './usePatchApply';
import {useSendMessage} from './useSendMessage';
import {findEquationsByNonce} from './patch';
import {$isEquationNode} from '../nodes/EquationNode';
import {chatPanel, closePanel, openPanel, usePanelOpen, usePanelWidth} from './panelStore';
import {useMemories, useMemoryEnabled} from './memories';
import {useActiveProjectId} from '../projects/projectStore';
import {useCompareMode} from '../ui/CompareMode';
import {SidePanelResizer} from '../ui/SidePanelResizer';
import {useScrollTrap} from '../ui/useScrollTrap';
import './chat.css';

export default function ChatSidebar(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const open = usePanelOpen();
  const width = usePanelWidth();
  const settings = useAISettings();
  const configured = isConfigured(settings);
  const activeProjectId = useActiveProjectId();
  const {active} = useConversations();
  const messages = active?.messages ?? [];
  const memories = useMemories(activeProjectId);
  const memoryEnabled = useMemoryEnabled();
  // Compare mode only sets `editor.setEditable(false)` — programmatic
  // `editor.update` (accept / retry-revert) would still mutate the live doc
  // underneath the frozen diff view. Mutations must bail out while it's on.
  const {active: compareActive} = useCompareMode();

  const [notice, setNotice] = useState<ChatNotice | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [selInfo, setSelInfo] = useState<{
    mode: 'selection' | 'document';
    chars: number;
    /** Number of equations referenced via a node selection (clicked formula). */
    eq: number;
  }>({mode: 'document', chars: 0, eq: 0});

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trapRef = useScrollTrap();

  const {streaming, loading, pinnedIdRef, startRun, stop, cancelAll} = useAgentRun({
    editor,
    configured,
    activeProjectId,
    activeConvId: active?.id ?? null,
    memoryEnabled,
  });
  const {
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
  } = usePatchApply({
    editor,
    active,
    loading,
    compareActive,
    startRun,
    setNotice,
  });
  const {input, setInput, send} = useSendMessage({
    editor,
    active,
    loading,
    pendingRetry,
    acceptingRef,
    startRun,
  });

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

  // Live context chip: selection / referenced equation(s) vs full document.
  useEffect(() => {
    const probe = () => {
      editor.getEditorState().read(() => {
        const sel = $getSelection();
        let next: {mode: 'selection' | 'document'; chars: number; eq: number};
        if ($isRangeSelection(sel) && !sel.isCollapsed()) {
          next = {mode: 'selection', chars: sel.getTextContent().length, eq: 0};
        } else {
          // A clicked equation block is a NODE selection — it counts as
          // referencing the formula to the AI (see selectionToSentinelText).
          const eq = $isNodeSelection(sel)
            ? sel.getNodes().filter($isEquationNode).length
            : 0;
          next =
            eq > 0
              ? {mode: 'selection', chars: 0, eq}
              : {mode: 'document', chars: 0, eq: 0};
        }
        setSelInfo(prev =>
          prev.mode === next.mode && prev.chars === next.chars && prev.eq === next.eq
            ? prev
            : next,
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

  // Switching conversations does NOT cancel a run: it keeps streaming in the
  // background, persists to its own conversation, and its bubble reappears
  // when you switch back. Only the retry pin/plan is per-conversation UI
  // state, so those are cleared so a stale target doesn't pin and a stale
  // plan doesn't revert/persist against the wrong conversation.
  useEffect(() => {
    pinnedIdRef.current = null;
    cancelRetry();
  }, [active?.id, cancelRetry, pinnedIdRef]);

  // A project switch swaps the whole document + conversation set — in-flight
  // runs would validate their patches against the WRONG doc, so cancel all.
  useEffect(() => {
    cancelAll();
  }, [activeProjectId, cancelAll]);

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
  }, [messages, streaming, loading, pinnedIdRef]);

  // Auto-dismiss the transient notice banner.
  useEffect(() => {
    if (!notice) {
      return;
    }
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  const onComposerKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const ctxLabel =
    selInfo.mode === 'selection'
      ? selInfo.eq > 0
        ? `${selInfo.eq} equation${selInfo.eq === 1 ? '' : 's'}`
        : `Selection · ${selInfo.chars} chars`
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
                ? selInfo.eq > 0
                  ? 'The AI will work on the clicked equation(s)'
                  : 'The AI will edit your selection'
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

        <ConversationSwitcher />

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

        {pendingRetry && (
          <RetryConfirmDialog
            plan={pendingRetry}
            confirmBtnRef={confirmRetryBtnRef}
            onConfirm={confirmRetry}
            onCancel={cancelRetry}
          />
        )}

        <div className="chat-messages" ref={scrollRef}>
          {messages.length === 0 && !streaming && (
            <div className="chat-empty">
              <p>
                <strong>Select text</strong> to edit it, or ask about the{' '}
                <strong>whole document</strong>.
              </p>
              <p className="chat-empty-sub">
                The AI proposes edits as reviewable diffs — nothing changes
                until you accept.
                {!configured && ' No model configured — open ⚙ to set up your API.'}
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
                onRejectEqEdit={i => rejectEqEdit(m.id, i)}
                onRestoreEqEdit={i => restoreEqEdit(m.id, i)}
                onRejectAppendEdit={i => rejectAppendEdit(m.id, i)}
                onRestoreAppendEdit={i => restoreAppendEdit(m.id, i)}
                resolveEquation={nonce =>
                  findEquationsByNonce(editor, nonce)[0]?.equation
                }
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
              onRejectEqEdit={i => rejectEqEdit(streaming.id, i)}
              onRestoreEqEdit={i => restoreEqEdit(streaming.id, i)}
              onRejectAppendEdit={i => rejectAppendEdit(streaming.id, i)}
              onRestoreAppendEdit={i => restoreAppendEdit(streaming.id, i)}
              resolveEquation={nonce =>
                findEquationsByNonce(editor, nonce)[0]?.equation
              }
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
                ? selInfo.eq > 0
                  ? 'Ask the AI about the clicked equation…'
                  : 'Ask the AI to edit your selection…'
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
