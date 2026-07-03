/**
 * gitEssay — AI chat sidebar (VS Code-style right dock).
 *
 * Always-available conversation surface. The send/retry path runs a STREAMING
 * agent (runAgent): the model's <thinking> streams into a collapsible Thoughts
 * pane (expanded live, auto-collapsed when the turn finishes), and each turn ends
 * in one terminal action — patch (reviewable diffs, checkpointed on accept with
 * the model's explanation as the label), ask (options + a free-text box), or
 * finish. read/search steps show as chips. A Stop button aborts mid-stream.
 */
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$getRoot, $getSelection, $isRangeSelection} from 'lexical';
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
import {applyTextPatch, plainTextToBlocks} from './patch';
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
import {messagesToHistory, runAgent} from './providers';
import type {ChatEditState, ChatMessage, ChatMode, MessageContext} from './types';
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

/** Context captured at send time and stored on the user message (drives Retry). */
type SendContext = MessageContext;

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

  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState<ChatMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<{text: string; key: number} | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showMemory, setShowMemory] = useState(false);
  const [showList, setShowList] = useState(false);
  const [selInfo, setSelInfo] = useState<{mode: 'selection' | 'document'; chars: number}>(
    {mode: 'document', chars: 0},
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
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

  // Autoscroll to the latest content (persisted messages + the live stream).
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
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
    let ctx: SendContext = {mode: 'document'};
    editor.getEditorState().read(() => {
      const sel = $getSelection();
      if ($isRangeSelection(sel) && !sel.isCollapsed()) {
        ctx = {mode: 'selection', selectionText: sel.getTextContent()};
      }
    });
    void instruction; // instruction is stored separately on the user message
    return ctx;
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
      runAgent({
        editor,
        instruction: args.instruction,
        mode: args.mode,
        selectionText: args.selectionText,
        history,
        signal: controller.signal,
        memoryEnabled,
        memories: memories.map(m => ({content: m.content})),
        onRemember: async note => {
          if (activeProjectId) {
            await addMemory(activeProjectId, note);
          }
        },
        onUpdate: patch =>
          setStreaming(s => (s && s.id === args.streamingId ? {...s, ...patch} : s)),
      })
        .then(msg => {
          const final: ChatMessage = {...msg, id: args.streamingId};
          if (args.replace) {
            void replaceMessage(args.convId, args.streamingId, final);
          } else {
            void appendMessages(args.convId, [final]);
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
      if (!text || loading || !active) {
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
    [active, captureSelection, input, loading, startRun],
  );

  const retry = useCallback(
    async (assistantId: string) => {
      if (!active || loading || acceptingRef.current) {
        return;
      }
      const convId = active.id;
      const msgs = active.messages;
      const idx = msgs.findIndex(m => m.id === assistantId);
      if (idx < 1) {
        return;
      }
      const userMsg = msgs[idx - 1];
      if (userMsg.role !== 'user') {
        return;
      }
      const target = msgs[idx];
      const ctx: SendContext = userMsg.context ?? {mode: 'document'};

      // Before regenerating, REVERT any edits the user already accepted from this
      // response. Otherwise the document still contains the old version, so the
      // new attempt's SEARCH text won't match and the patch is invalid — most
      // visibly in selection mode (retry re-sends the original selection). The
      // accepted state is preserved as a version, so nothing is lost.
      const applied = (target.edits ?? [])
        .map((e, i) => ({e, i}))
        .filter(({e}) => e.state === 'applied');
      if (applied.length > 0) {
        const explanation =
          target.action?.kind === 'patch' ? target.action.explanation : 'AI edit';
        // Undo last-applied first (safer ordering, like an undo stack). Track
        // failures: a revert can't locate the text if the user edited it since, or
        // if an earlier revert in this same loop shifted the region.
        let undone = 0;
        let failed = 0;
        acceptingRef.current = true;
        try {
          for (const {e, i} of [...applied].reverse()) {
            const res = await applyTextPatch(editor, e.replace, e.search); // reverse swap
            if (res.ok) {
              undone++;
              await setEditState(convId, assistantId, i, 'reverted');
            } else {
              failed++;
            }
          }
          if (undone > 0) {
            await captureCheckpoint(editor, {
              source: 'manual',
              label: `Reverted before retry: ${truncate(explanation, 80)}`,
            });
          }
        } finally {
          acceptingRef.current = false;
        }
        if (failed === 0) {
          setNotice({
            text: `↩ Reverted ${undone} accepted edit${
              undone === 1 ? '' : 's'
            } from the previous response so the new attempt can apply cleanly. The accepted version is still in History.`,
            key: Date.now(),
          });
        } else if (undone > 0) {
          // Partial revert: some edits couldn't be located, so the document still
          // contains them. Report it honestly rather than claiming a clean slate.
          setNotice({
            text: `↩ Reverted ${undone} of ${applied.length} edit${
              applied.length === 1 ? '' : 's'
            }; ${failed} couldn't be located (the document changed). Retrying anyway — the new patch may not apply to those parts.`,
            key: Date.now(),
          });
        } else {
          setNotice({
            text: "Couldn't auto-revert the previous edit(s) (the document has changed since). Retrying anyway — the new patch may not apply.",
            key: Date.now(),
          });
        }
      }

      startRun({
        convId,
        instruction: userMsg.text,
        mode: ctx.mode,
        selectionText: ctx.selectionText,
        priorMessages: msgs.slice(0, idx - 1),
        streamingId: assistantId,
        replace: true,
      });
    },
    [active, editor, loading, startRun],
  );

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
      if (!convId || acceptingRef.current) {
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
            await setEditState(convId, msgId_, i, 'unlocatable');
          }
        }
        if (appliedAny) {
          await captureCheckpoint(editor, {
            source: 'ai-accept',
            label: truncate(label, 120) || 'AI chat edit',
          });
        }
      } finally {
        acceptingRef.current = false;
      }
    },
    [active, editor],
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

  const sendDisabled = !input.trim() || loading || !active;
  // Hide the message currently being regenerated (the live bubble stands in).
  const visibleMessages = messages.filter(m => m.id !== streaming?.id);

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

          {visibleMessages.map(m => (
            <MessageBubble
              key={m.id}
              message={m}
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
          ))}

          {streaming && (
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
    e => e.state === 'applied' || e.state === 'unlocatable' || e.state === 'reverted',
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
    <div className={`chat-msg chat-msg--assistant${live ? ' is-live' : ''}`}>
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
        <div className="chat-step" key={s.at}>
          {s.kind !== 'remember' && (
            <span className="chat-step-icon">
              {s.kind === 'search' ? '🔍' : '📖'}
            </span>
          )}
          <span className="chat-step-text">
            {s.kind === 'search'
              ? `searched “${s.query ?? ''}”`
              : s.kind === 'remember'
                ? `remembered: ${s.note ?? ''}`
                : 'read the document'}
          </span>
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
                  <span className="chat-edit-status">↩ Reverted (retrying)</span>
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
                {e.state === 'unlocatable' && (
                  <span className="chat-edit-status chat-edit-status--err">
                    ⚠ Couldn’t locate this passage (it may have changed)
                  </span>
                )}
              </div>
            </div>
          ))}

          {/* Action-level Accept: applies every still-pending edit and captures ONE
              checkpoint for the whole justification. */}
          {isAtomicPatch && hasPendingEdit && (
            <div className="chat-edit-action-footer">
              <button type="button" className="cp-button" onClick={onAcceptPatch}>
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
              context here as it works.
            </div>
          )}
          {memories.map(m => (
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
