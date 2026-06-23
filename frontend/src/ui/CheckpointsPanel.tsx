/**
 * gitEssay — CheckpointsPanel. Versions-style modal: name+save a checkpoint,
 * browse history (newest first), and restore any past checkpoint. Uses the
 * --ge-* palette tokens so it follows the light/dark theme.
 */
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {type JSX, useState} from 'react';
import {createPortal} from 'react-dom';

import {useCheckpoints} from '../checkpoints/useCheckpoints';
import {LATEST_ID, useCompareMode} from './CompareMode';
import './CheckpointsPanel.css';

export default function CheckpointsPanel({
  onClose,
}: {
  onClose: () => void;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const {checkpoints, currentId, save, restore} = useCheckpoints(editor);
  const [label, setLabel] = useState('');
  const {enter: enterCompare} = useCompareMode();

  return createPortal(
    <div className="cp-overlay" onClick={onClose} role="presentation">
      <div
        className="cp-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Checkpoints"
        onClick={e => e.stopPropagation()}>
        <div className="cp-header">
          <h3>Checkpoints</h3>
          <button
            type="button"
            className="cp-button"
            disabled={checkpoints.length < 1}
            title="Compare a checkpoint against the live editor (read-only)"
            onClick={() => {
              // git-style default: previous checkpoint → live editor (latest).
              const s = [...checkpoints].sort((a, b) => a.createdAt - b.createdAt);
              const cur =
                currentId && s.some(c => c.id === currentId)
                  ? currentId
                  : s[s.length - 1]?.id;
              const curIdx = s.findIndex(c => c.id === cur);
              const from = curIdx > 0 ? s[curIdx - 1].id : s[0]?.id;
              enterCompare(from ?? '', LATEST_ID);
              onClose();
            }}>
            Compare…
          </button>
          <button
            type="button"
            className="cp-close"
            onClick={onClose}
            aria-label="Close checkpoints">
            ✕
          </button>
        </div>

        <div className="cp-save-row">
          <input
            className="cp-input"
            value={label}
            onChange={e => setLabel(e.target.value)}
            placeholder="Label (optional)"
          />
          <button
            type="button"
            className="cp-button"
            onClick={async () => {
              await save(label.trim() || undefined);
              setLabel('');
            }}>
            Save checkpoint
          </button>
        </div>

        <ul className="cp-list">
          {checkpoints.length === 0 && (
            <li className="cp-empty">No checkpoints yet.</li>
          )}
          {checkpoints.map(cp => {
            const isCurrent = cp.id === currentId;
            return (
              <li
                key={cp.id}
                className={`cp-item${isCurrent ? ' cp-item--current' : ''}`}>
                <div className="cp-meta">
                  <span className="cp-time">
                    {new Date(cp.createdAt).toLocaleString()}
                  </span>
                  <span className="cp-source">
                    {cp.source === 'auto'
                      ? 'auto-draft'
                      : cp.source === 'init'
                        ? 'initial'
                        : cp.source}
                    {cp.label ? ` · ${cp.label}` : ''}
                  </span>
                </div>
                <div className="cp-row-actions">
                  {isCurrent ? (
                    <span className="cp-current-tag">current</span>
                  ) : (
                    <button
                      type="button"
                      className="cp-button cp-button--ghost"
                      onClick={async () => {
                        await restore(cp.id);
                        onClose();
                      }}>
                      Restore
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </div>,
    document.body,
  );
}
