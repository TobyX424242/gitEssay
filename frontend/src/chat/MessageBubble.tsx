/**
 * gitEssay — one chat message bubble (extracted from ChatSidebar).
 *
 * Renders a user message, or an assistant turn: the collapsible Thoughts pane
 * (open while streaming, collapsed once finalized), read/search step chips, the
 * markdown body, reviewable patch diffs (text / equation / append edits with
 * per-edit Reject + Undo-reject and one action-level Accept), ask options +
 * free-text reply, the finish summary, and the Retry action.
 */
import {type JSX, useEffect, useMemo, useState, type KeyboardEvent} from 'react';

import {diffBlocks} from '../diff/diff';
import DiffView from '../diff/DiffView';
import useModal from '../hooks/useModal';
import KatexRenderer from '../ui/KatexRenderer';
import Markdown from './Markdown';
import {plainTextToBlocks} from './patch';
import {MAX_PATCH_ATTEMPTS} from './patchValidate';
import type {AgentStep, ChatMessage} from './types';

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
      return `delegated a subtask${layer}: ${s.task ?? ''}`;
    }
    case 'read':
    default:
      return 'read the document';
  }
}

export default function MessageBubble({
  message,
  live = false,
  busy,
  onAcceptPatch,
  onRejectEdit,
  onRestoreEdit,
  onRejectEqEdit,
  onRestoreEqEdit,
  onRejectAppendEdit,
  onRestoreAppendEdit,
  resolveEquation,
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
  /** Equation-edit counterparts of onRejectEdit / onRestoreEdit. */
  onRejectEqEdit: (editIdx: number) => void;
  onRestoreEqEdit: (editIdx: number) => void;
  /** Append-edit counterparts of onRejectEdit / onRestoreEdit. */
  onRejectAppendEdit: (editIdx: number) => void;
  onRestoreAppendEdit: (editIdx: number) => void;
  /** Resolve an [[EQ:nonce]] token to the equation's CURRENT LaTeX (diff old side). */
  resolveEquation: (nonce: string) => string | undefined;
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
  // Equation edit diffs: old side = prevLatex (once applied) or the equation's
  // current live LaTeX; new side = the proposed LaTeX.
  const eqEditOps = useMemo(
    () =>
      (message.eqEdits ?? []).map(e =>
        diffBlocks(
          plainTextToBlocks(e.prevLatex ?? resolveEquation(e.nonce) ?? ''),
          plainTextToBlocks(e.latex),
        ),
      ),
    [message.eqEdits, resolveEquation],
  );
  // Append edits: all-added diff (empty → appended text).
  const appendOps = useMemo(
    () =>
      (message.appendEdits ?? []).map(e =>
        diffBlocks(plainTextToBlocks(''), plainTextToBlocks(e.text)),
      ),
    [message.appendEdits],
  );

  const [eqModal, showEqModal] = useModal();

  // Visualization for an equation edit: full KaTeX render of BEFORE (the
  // equation's current/previous LaTeX) vs AFTER (the proposed LaTeX).
  const showEqViz = (nonce: string, before: string, after: string) => {
    const pane = (label: string, source: string, accent: 'before' | 'after') => (
      <div className="eqviz-pane">
        <div className={`eqviz-pane-header eqviz-pane-header--${accent}`}>
          {label}
        </div>
        <div className="eqviz-pane-body">
          {source.trim() ? (
            <KatexRenderer equation={source} inline={false} onDoubleClick={() => null} />
          ) : (
            <span className="eqviz-empty">(equation not found)</span>
          )}
        </div>
        <div className="eqviz-src">{source || ' '}</div>
      </div>
    );
    showEqModal(
      `Equation [[EQ:${nonce}]]`,
      () => (
        <div className="eqviz-grid">
          {pane('Before', before, 'before')}
          {pane('After', after, 'after')}
        </div>
      ),
      true,
      'eqviz-modal',
    );
  };

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
  // Only show the Thoughts pane when the model actually produced reasoning
  // content (reasoning models: DeepSeek-R1, o-series, …). Non-reasoning models
  // (gpt-4o-mini etc.) emit none — an always-"…" placeholder pane looks broken;
  // the three-dot working indicator below already covers the busy state.
  const showThinking = hasThinking;
  const edits = message.edits ?? [];
  const eqEdits = message.eqEdits ?? [];
  const appendEdits = message.appendEdits ?? [];
  const isAtomicPatch = message.action?.kind === 'patch';
  const patchLabel =
    message.action?.kind === 'patch' ? message.action.explanation : undefined;
  const hasPendingEdit =
    edits.some(e => e.state === 'pending') ||
    eqEdits.some(e => e.state === 'pending') ||
    appendEdits.some(e => e.state === 'pending');
  const pendingEditCount =
    edits.filter(e => e.state === 'pending').length +
    eqEdits.filter(e => e.state === 'pending').length +
    appendEdits.filter(e => e.state === 'pending').length;
  // The patch is sealed once the action-level Accept has run (any edit applied or
  // unlocatable) or it was reverted for retry — before that, a rejected edit can
  // still be restored to pending.
  const sealedStates = ['applied', 'unlocatable', 'stale', 'reverted'];
  const actionSealed =
    edits.some(e => sealedStates.includes(e.state)) ||
    eqEdits.some(e => sealedStates.includes(e.state)) ||
    appendEdits.some(e => sealedStates.includes(e.state));

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
              {live ? 'Thinking…' : 'Thoughts'}
            </span>
          </button>
          {thinkOpen && (
            <div className="chat-thinking-body">{message.thinking}</div>
          )}
        </div>
      )}

      {(message.steps ?? []).map(s => (
        <div
          className={`chat-step${s.depth ? ` chat-step--nested` : ''}`}
          key={s.at}
          style={s.depth ? {marginLeft: Math.min(s.depth, 3) * 14} : undefined}>
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
          {patchLabel &&
            (edits.length > 0 || eqEdits.length > 0 || appendEdits.length > 0) && (
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

          {/* Equation edits: dedicated LaTeX patches (old → new LaTeX). */}
          {eqEdits.map((e, i) => (
            <div key={`eq-${i}`} className="chat-edit">
              <div className="chat-edit-label">
                Equation edit <code>{`[[EQ:${e.nonce}]]`}</code>
              </div>
              <div className="chat-edit-diff">
                <DiffView ops={eqEditOps[i]} />
              </div>
              <div className="chat-edit-actions">
                <button
                  type="button"
                  className="cp-button cp-button--ghost"
                  title="Render the equation before and after this edit"
                  onClick={() =>
                    showEqViz(e.nonce, e.prevLatex ?? resolveEquation(e.nonce) ?? '', e.latex)
                  }>
                  Visualize
                </button>
                {e.state === 'pending' && isAtomicPatch && (
                  <button
                    type="button"
                    className="cp-button cp-button--ghost"
                    onClick={() => onRejectEqEdit(i)}>
                    Reject
                  </button>
                )}
                {e.state === 'applied' && (
                  <span className="chat-edit-status chat-edit-status--ok">✓ Applied</span>
                )}
                {e.state === 'reverted' && (
                  <span className="chat-edit-status">↩ Reverted</span>
                )}
                {e.state === 'rejected' &&
                  (e.failReason ? (
                    <span className="chat-edit-status chat-edit-status--err">
                      ⚠ Invalid LaTeX — rejected: {e.failReason}
                    </span>
                  ) : actionSealed ? (
                    <span className="chat-edit-status">Rejected</span>
                  ) : (
                    <button
                      type="button"
                      className="cp-button cp-button--ghost chat-edit-undo"
                      onClick={() => onRestoreEqEdit(i)}>
                      ↩ Undo reject
                    </button>
                  ))}
                {(e.state === 'unlocatable' || e.state === 'stale') && (
                  <span className="chat-edit-status chat-edit-status--err">
                    ⚠ Couldn’t locate this equation (it may have changed)
                  </span>
                )}
              </div>
            </div>
          ))}

          {/* Append edits: new content added to the end of the document. */}
          {appendEdits.map((e, i) => (
            <div key={`append-${i}`} className="chat-edit">
              <div className="chat-edit-label">Append to end of document</div>
              <div className="chat-edit-diff">
                <DiffView ops={appendOps[i]} />
              </div>
              <div className="chat-edit-actions">
                {e.state === 'pending' && isAtomicPatch && (
                  <button
                    type="button"
                    className="cp-button cp-button--ghost"
                    onClick={() => onRejectAppendEdit(i)}>
                    Reject
                  </button>
                )}
                {e.state === 'applied' && (
                  <span className="chat-edit-status chat-edit-status--ok">✓ Applied</span>
                )}
                {e.state === 'reverted' && (
                  <span className="chat-edit-status">↩ Reverted</span>
                )}
                {e.state === 'rejected' &&
                  (e.failReason ? (
                    <span className="chat-edit-status chat-edit-status--err">
                      ⚠ Invalid LaTeX — rejected: {e.failReason}
                    </span>
                  ) : actionSealed ? (
                    <span className="chat-edit-status">Rejected</span>
                  ) : (
                    <button
                      type="button"
                      className="cp-button cp-button--ghost chat-edit-undo"
                      onClick={() => onRestoreAppendEdit(i)}>
                      ↩ Undo reject
                    </button>
                  ))}
                {(e.state === 'unlocatable' || e.state === 'stale') && (
                  <span className="chat-edit-status chat-edit-status--err">
                    ⚠ Couldn’t append this content
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
      {eqModal}
    </div>
  );
}
