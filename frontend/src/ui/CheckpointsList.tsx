/**
 * gitEssay — checkpoint list (non-modal presentational component).
 *
 * The save row + Compare action + newest-first list, extracted from the old
 * CheckpointsPanel modal so it can render inside the left Versions dock. Reuses
 * useCheckpoints + useCompareMode.
 */
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {type JSX, useState} from 'react';

import {useCheckpoints} from '../checkpoints/useCheckpoints';
import {LATEST_ID, useCompareMode} from './CompareMode';
import './CheckpointsPanel.css';

export default function CheckpointsList({
  onCompare,
}: {
  /** Called after entering compare mode (e.g. to collapse the dock). */
  onCompare?: () => void;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const {checkpoints, currentId, save, restore} = useCheckpoints(editor);
  const [label, setLabel] = useState('');
  const {enter: enterCompare, active: compareActive, exit: exitCompare} =
    useCompareMode();

  return (
    <>
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
          Save
        </button>
      </div>

      <div className="cp-toolbar-row">
        <button
          type="button"
          className="cp-button cp-button--ghost"
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
            onCompare?.();
          }}>
          Compare…
        </button>
        {compareActive && (
          <button
            type="button"
            className="cp-button cp-button--ghost"
            onClick={exitCompare}
            title="Exit compare mode"
            aria-label="Exit compare mode">
            Exit compare
          </button>
        )}
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
                    }}>
                    Restore
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
