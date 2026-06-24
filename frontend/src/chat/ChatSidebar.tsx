/**
 * gitEssay — AI chat sidebar (VS Code-style right dock).
 *
 * Always-available conversation surface with multiple, persisted, switchable
 * conversations. Context rules: a non-collapsed selection is the edit target;
 * otherwise the full document is the context. The provider returns prose +
 * SEARCH/REPLACE edits; each edit renders as a reviewable diff card and is
 * applied only on Accept (then checkpointed). Every AI response has a Retry
 * control that re-runs the original request.
 */
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
} from 'lexical';
import {type JSX, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';

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
import {applyTextPatch, plainTextToBlocks} from './patch';
import {chatPanel, closePanel, openPanel, usePanelOpen, usePanelWidth} from './panelStore';
import {getActiveChatProvider} from './providers';
import type {ChatContext, ChatEditState, ChatMessage} from './types';
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

export default function ChatSidebar(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const open = usePanelOpen();
  const width = usePanelWidth();
  const settings = useAISettings();
  const configured = isConfigured(settings);
  const {conversations, activeId, active} = useConversations();
  const messages = active?.messages ?? [];

  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showList, setShowList] = useState(false);
  const [selInfo, setSelInfo] = useState<{mode: 'selection' | 'document'; chars: number}>(
    {mode: 'document', chars: 0},
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trapRef = useScrollTrap();

  // Ensure at least one conversation exists.
  useEffect(() => {
    bootstrapConversations();
  }, []);

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

  // Autoscroll to the latest message / thinking indicator.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages, loading, retryingId]);

  const captureContext = useCallback(
    (instruction: string): ChatContext => {
      let ctx!: ChatContext;
      editor.getEditorState().read(() => {
        const sel = $getSelection();
        if ($isRangeSelection(sel) && !sel.isCollapsed()) {
          ctx = {
            mode: 'selection',
            selectionText: sel.getTextContent(),
            documentText: '',
            instruction,
          };
        } else {
          const blocks = $getRoot()
            .getChildren()
            .map(b => b.getTextContent());
          ctx = {mode: 'document', documentText: blocks.join('\n\n'), instruction};
        }
      });
      return ctx;
    },
    [editor],
  );

  const send = useCallback(
    (instruction?: string) => {
      const text = (instruction ?? input).trim();
      if (!text || loading || !active) {
        return;
      }
      const convId = active.id;
      const ctx = captureContext(text);
      const needsTitle =
        active.messages.length === 0 || active.title === 'New conversation';
      const title = needsTitle ? deriveTitle(text) : undefined;
      const userMsg: ChatMessage = {id: msgId(), role: 'user', text, context: ctx};
      setInput('');
      setLoading(true);
      void appendMessages(convId, [userMsg], title);
      const provider = getActiveChatProvider(configured, settings);
      provider
        .chat(ctx)
        .then(resp => {
          const aMsg: ChatMessage = {
            id: msgId(),
            role: 'assistant',
            text: resp.text,
            mode: ctx.mode,
            edits: resp.edits.map(e => ({...e, state: 'pending' as ChatEditState})),
          };
          void appendMessages(convId, [aMsg]);
        })
        .catch((err: unknown) => {
          const aMsg: ChatMessage = {
            id: msgId(),
            role: 'assistant',
            text: '',
            error: err instanceof Error ? err.message : String(err),
          };
          void appendMessages(convId, [aMsg]);
        })
        .finally(() => setLoading(false));
    },
    [active, captureContext, configured, input, loading, settings],
  );

  const retry = useCallback(
    (assistantId: string) => {
      if (!active || loading || retryingId) {
        return;
      }
      const msgs = active.messages;
      const idx = msgs.findIndex(m => m.id === assistantId);
      if (idx < 1) {
        return;
      }
      const userMsg = msgs[idx - 1];
      if (userMsg.role !== 'user' || !userMsg.context) {
        return;
      }
      const ctx = userMsg.context;
      const convId = active.id;
      setRetryingId(assistantId);
      const provider = getActiveChatProvider(configured, settings);
      provider
        .chat(ctx)
        .then(resp => {
          const aMsg: ChatMessage = {
            id: assistantId,
            role: 'assistant',
            text: resp.text,
            mode: ctx.mode,
            edits: resp.edits.map(e => ({...e, state: 'pending' as ChatEditState})),
          };
          void replaceMessage(convId, assistantId, aMsg);
        })
        .catch((err: unknown) => {
          const aMsg: ChatMessage = {
            id: assistantId,
            role: 'assistant',
            text: '',
            error: err instanceof Error ? err.message : String(err),
          };
          void replaceMessage(convId, assistantId, aMsg);
        })
        .finally(() => setRetryingId(null));
    },
    [active, configured, loading, retryingId, settings],
  );

  const acceptEdit = useCallback(
    async (msgId_: string, editIdx: number, search: string, replace: string) => {
      if (!active) {
        return;
      }
      const res = await applyTextPatch(editor, search, replace);
      if (res.ok) {
        await captureCheckpoint(editor, {source: 'ai-accept', label: 'AI chat edit'});
        void setEditState(active.id, msgId_, editIdx, 'applied');
      } else {
        void setEditState(active.id, msgId_, editIdx, 'unlocatable');
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

  const busy = loading || retryingId !== null;
  const sendDisabled = !input.trim() || loading || !active;

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

        <div className="chat-messages" ref={scrollRef}>
          {messages.length === 0 && !loading && (
            <div className="chat-empty">
              <p>
                <strong>Select text</strong> to make it the edit target, or leave the
                selection empty to work on the <strong>whole document</strong>.
              </p>
              <p className="chat-empty-sub">
                Edits appear as reviewable diffs — nothing changes until you accept.
                {!configured && ' (No model configured — open ⚙ to set up your API.)'}
              </p>
            </div>
          )}

          {messages.map(m => (
            <MessageBubble
              key={m.id}
              message={m}
              retrying={m.id === retryingId}
              busy={busy}
              onAccept={(i, e) => acceptEdit(m.id, i, e.search, e.replace)}
              onReject={i => active && void setEditState(active.id, m.id, i, 'rejected')}
              onRetry={retry}
            />
          ))}

          {loading && (
            <div className="chat-thinking" aria-label="AI is thinking">
              <span />
              <span />
              <span />
            </div>
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
          <button
            type="button"
            className="cp-button chat-send"
            onClick={() => send()}
            disabled={sendDisabled}>
            Send
          </button>
        </div>
      </aside>

      {showSettings && <AISettingsPanel onClose={() => setShowSettings(false)} />}
    </>
  );
}

function MessageBubble({
  message,
  retrying,
  busy,
  onAccept,
  onReject,
  onRetry,
}: {
  message: ChatMessage;
  retrying: boolean;
  busy: boolean;
  onAccept: (editIdx: number, edit: {search: string; replace: string}) => void;
  onReject: (editIdx: number) => void;
  onRetry: (assistantId: string) => void;
}): JSX.Element {
  const editOps = useMemo(
    () =>
      (message.edits ?? []).map(e =>
        diffBlocks(plainTextToBlocks(e.search), plainTextToBlocks(e.replace)),
      ),
    [message.edits],
  );

  if (message.role === 'user') {
    return (
      <div className="chat-msg chat-msg--user">
        <div className="chat-bubble chat-bubble--user">{message.text}</div>
      </div>
    );
  }

  return (
    <div className="chat-msg chat-msg--assistant">
      {retrying ? (
        <div className="chat-thinking" aria-label="Regenerating">
          <span />
          <span />
          <span />
        </div>
      ) : message.error ? (
        <div className="chat-bubble chat-bubble--assistant chat-error">
          ⚠ {message.error}
        </div>
      ) : (
        <>
          {message.text && (
            <div className="chat-bubble chat-bubble--assistant">{message.text}</div>
          )}
          {(message.edits ?? []).map((e, i) => (
            <div key={i} className="chat-edit">
              <div className="chat-edit-label">Proposed edit</div>
              <div className="chat-edit-diff">
                <DiffView ops={editOps[i]} />
              </div>
              <div className="chat-edit-actions">
                {e.state === 'pending' && (
                  <>
                    <button
                      type="button"
                      className="cp-button"
                      onClick={() => onAccept(i, e)}>
                      Accept
                    </button>
                    <button
                      type="button"
                      className="cp-button cp-button--ghost"
                      onClick={() => onReject(i)}>
                      Reject
                    </button>
                  </>
                )}
                {e.state === 'applied' && (
                  <span className="chat-edit-status chat-edit-status--ok">✓ Applied</span>
                )}
                {e.state === 'rejected' && (
                  <span className="chat-edit-status">Rejected</span>
                )}
                {e.state === 'unlocatable' && (
                  <span className="chat-edit-status chat-edit-status--err">
                    ⚠ Couldn’t locate this passage (it may have changed)
                  </span>
                )}
              </div>
            </div>
          ))}
        </>
      )}
      {!retrying && (
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
