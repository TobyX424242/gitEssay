/**
 * gitEssay — AI chat sidebar (VS Code-style right dock).
 *
 * Always-available conversation surface. Context rules: a non-collapsed
 * selection is the edit target; otherwise the full document is the context.
 * The provider returns prose + SEARCH/REPLACE edits; each edit renders as a
 * reviewable diff card and is applied only on Accept (then checkpointed).
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

import {applyTextPatch, plainTextToBlocks} from './patch';
import {chatPanel, closePanel, openPanel, usePanelOpen, usePanelWidth} from './panelStore';
import {getActiveChatProvider} from './providers';
import type {ChatContext, ChatEditState, ChatMessage} from './types';
import {SidePanelResizer} from '../ui/SidePanelResizer';
import {useScrollTrap} from '../ui/useScrollTrap';
import './chat.css';

export default function ChatSidebar(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const open = usePanelOpen();
  const width = usePanelWidth();
  const settings = useAISettings();
  const configured = isConfigured(settings);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [selInfo, setSelInfo] = useState<{mode: 'selection' | 'document'; chars: number}>(
    {mode: 'document', chars: 0},
  );

  const idRef = useRef(0);
  const nextId = useCallback(() => `m${++idRef.current}`, []);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const trapRef = useScrollTrap();

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
  }, [messages, loading]);

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
      if (!text || loading) {
        return;
      }
      const ctx = captureContext(text);
      setMessages(m => [...m, {id: nextId(), role: 'user', text}]);
      setInput('');
      setLoading(true);
      const provider = getActiveChatProvider(configured, settings);
      provider
        .chat(ctx)
        .then(resp => {
          setMessages(m => [
            ...m,
            {
              id: nextId(),
              role: 'assistant',
              text: resp.text,
              mode: ctx.mode,
              edits: resp.edits.map(e => ({...e, state: 'pending' as ChatEditState})),
            },
          ]);
        })
        .catch((err: unknown) => {
          setMessages(m => [
            ...m,
            {
              id: nextId(),
              role: 'assistant',
              text: '',
              error: err instanceof Error ? err.message : String(err),
            },
          ]);
        })
        .finally(() => setLoading(false));
    },
    [captureContext, configured, input, loading, nextId, settings],
  );

  const setEditState = useCallback(
    (msgId: string, editIdx: number, state: ChatEditState) => {
      setMessages(m =>
        m.map(mm =>
          mm.id === msgId
            ? {
                ...mm,
                edits: mm.edits?.map((e, i) => (i === editIdx ? {...e, state} : e)),
              }
            : mm,
        ),
      );
    },
    [],
  );

  const acceptEdit = useCallback(
    async (msgId: string, editIdx: number, search: string, replace: string) => {
      const res = await applyTextPatch(editor, search, replace);
      if (res.ok) {
        await captureCheckpoint(editor, {source: 'ai-accept', label: 'AI chat edit'});
        setEditState(msgId, editIdx, 'applied');
      } else {
        setEditState(msgId, editIdx, 'unlocatable');
      }
    },
    [editor, setEditState],
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

  const sendDisabled = !input.trim() || loading;

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

        <div className="chat-messages" ref={scrollRef}>
          {messages.length === 0 && !loading && (
            <div className="chat-empty">
              <p>
                <strong>Select text</strong> to make it the edit target, or leave the
                selection empty to work on the <strong>whole document</strong>.
              </p>
              <p className="chat-empty-sub">
                Edits appear as reviewable diffs — nothing changes until you accept.
                {!configured && ' (Running in local demo mode — configure a model in ⚙.)'}
              </p>
            </div>
          )}

          {messages.map(m => (
            <MessageBubble
              key={m.id}
              message={m}
              onAccept={(i, e) => acceptEdit(m.id, i, e.search, e.replace)}
              onReject={i => setEditState(m.id, i, 'rejected')}
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
  onAccept,
  onReject,
}: {
  message: ChatMessage;
  onAccept: (editIdx: number, edit: {search: string; replace: string}) => void;
  onReject: (editIdx: number) => void;
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
      {message.error ? (
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
    </div>
  );
}
