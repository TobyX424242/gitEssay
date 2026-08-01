/**
 * gitEssay — retry confirm dialog (extracted from ChatSidebar).
 *
 * Modal (portaled to document.body) shown before a retry that must revert
 * accepted edits: lists the LIFO batch of patches that will be rolled back so
 * the new response can apply cleanly. Accepted versions stay in History.
 */
import {type JSX} from 'react';
import {createPortal} from 'react-dom';

import type {PendingRetry} from './usePatchApply';

import useOverlayDismiss from '../hooks/useOverlayDismiss';

export default function RetryConfirmDialog({
  plan,
  confirmBtnRef,
  onConfirm,
  onCancel,
}: {
  plan: PendingRetry;
  confirmBtnRef: React.RefObject<HTMLButtonElement | null>;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const dismiss = useOverlayDismiss(onCancel);

  return createPortal(
    <div className="ai-overlay" role="presentation" {...dismiss}>
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
            onClick={onCancel}>
            ✕
          </button>
        </div>
        <div className="ai-body">
          <p className="ai-note">
            Retrying will <strong>revert {plan.totalEdits} accepted edit{plan.totalEdits === 1 ? '' : 's'}</strong>{' '}
            so the new response can apply cleanly.
          </p>
          <ul className="retry-items">
            {plan.items.map(it => (
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
              onClick={onCancel}>
              Cancel
            </button>
            <button
              type="button"
              className="cp-button"
              ref={confirmBtnRef}
              onClick={onConfirm}>
              Revert &amp; retry
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
