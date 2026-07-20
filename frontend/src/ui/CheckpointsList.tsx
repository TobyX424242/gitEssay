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
import type {Checkpoint} from '../checkpoints/types';
import {LATEST_ID, useCompareMode} from './CompareMode';
import './CheckpointsPanel.css';

type SourceFilter = 'all' | 'manual' | 'ai';

/** Display name + badge modifier + no-label fallback title per source. */
const SOURCE_META: Record<
  Checkpoint['source'],
  {badge: string; cls: string; untitled: string}
> = {
  init: {badge: 'Initial', cls: 'init', untitled: 'Initial version'},
  manual: {badge: 'Manual', cls: 'manual', untitled: 'Manual checkpoint'},
  auto: {badge: 'Auto-draft', cls: 'auto', untitled: 'Auto-saved draft'},
  restore: {badge: 'Restore', cls: 'restore', untitled: 'Restored version'},
  'ai-accept': {badge: 'AI edit', cls: 'ai', untitled: 'AI edit'},
};

/**
 * Compact relative timestamp for the list ("2h ago") — the full locale string
 * stays one hover away in the tooltip. Falls back to a short date past a week.
 */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) {
    return 'just now';
  }
  if (mins < 60) {
    return `${mins}m ago`;
  }
  const hours = Math.floor(mins / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return 'yesterday';
  }
  if (days < 7) {
    return `${days}d ago`;
  }
  return new Date(ts).toLocaleDateString();
}

/**
 * Split `text` into plain runs + highlighted <mark> runs for each occurrence of
 * `query`. Honours the case-sensitivity flag so the highlight matches the same
 * occurrences the filter matched. Returns the text unchanged when the query is
 * empty (no search active).
 */
function highlightMatches(
  text: string,
  query: string,
  caseSensitive: boolean,
): Array<string | JSX.Element> {
  const q = query.trim();
  if (!q) {
    return [text];
  }
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, caseSensitive ? 'g' : 'gi');
  const parts: Array<string | JSX.Element> = [];
  let last = 0;
  let key = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push(text.slice(last, m.index));
    }
    parts.push(
      <mark className="cp-highlight" key={key++}>
        {m[0]}
      </mark>,
    );
    last = m.index + m[0].length;
    if (m[0].length === 0) {
      re.lastIndex++; // guard against a zero-length match looping forever
    }
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts;
}

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

  // Search + filter state for the list.
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [filter, setFilter] = useState<SourceFilter>('all');

  const matchesQuery = (cp: Checkpoint): boolean => {
    const q = query.trim();
    if (!q) {
      return true;
    }
    const hay = cp.label ?? '';
    return caseSensitive
      ? hay.includes(q)
      : hay.toLowerCase().includes(q.toLowerCase());
  };
  const matchesFilter = (cp: Checkpoint): boolean => {
    if (filter === 'manual') {
      return cp.source === 'manual';
    }
    if (filter === 'ai') {
      return cp.source === 'ai-accept';
    }
    return true; // 'all'
  };
  const filtered = checkpoints.filter(cp => matchesFilter(cp) && matchesQuery(cp));

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

      <div className="cp-filter-row">
        <div className="cp-search">
          <input
            className="cp-input cp-search-input"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Search labels…"
            aria-label="Search checkpoint labels"
          />
          <button
            type="button"
            className={`cp-case-toggle${caseSensitive ? ' is-active' : ''}`}
            onClick={() => setCaseSensitive(v => !v)}
            aria-pressed={caseSensitive}
            title={
              caseSensitive
                ? 'Case-sensitive search — click for case-insensitive'
                : 'Case-insensitive search — click for case-sensitive'
            }>
            Aa
          </button>
        </div>
        <div
          className="cp-segmented"
          role="group"
          aria-label="Filter checkpoints by source">
          {(['all', 'manual', 'ai'] as const).map(f => (
            <button
              key={f}
              type="button"
              className={`cp-seg${filter === f ? ' is-active' : ''}`}
              onClick={() => setFilter(f)}
              aria-pressed={filter === f}>
              {f === 'all' ? 'All' : f === 'manual' ? 'Manual' : 'AI'}
            </button>
          ))}
        </div>
      </div>

      <ul className="cp-list">
        {checkpoints.length === 0 && (
          <li className="cp-empty">No checkpoints yet.</li>
        )}
        {checkpoints.length > 0 && filtered.length === 0 && (
          <li className="cp-empty">No checkpoints match your search.</li>
        )}
        {filtered.map(cp => {
          const isCurrent = cp.id === currentId;
          const meta = SOURCE_META[cp.source] ?? SOURCE_META.manual;
          const absolute = new Date(cp.createdAt);
          return (
            <li
              key={cp.id}
              className={`cp-item${isCurrent ? ' cp-item--current' : ''}`}>
              <div className="cp-item-body">
                <div
                  className={`cp-item-title${cp.label ? '' : ' cp-item-title--untitled'}`}>
                  {cp.label
                    ? highlightMatches(cp.label, query, caseSensitive)
                    : meta.untitled}
                </div>
                <div className="cp-item-sub">
                  <span className={`cp-badge cp-badge--${meta.cls}`}>
                    {meta.badge}
                  </span>
                  <time
                    className="cp-time"
                    dateTime={absolute.toISOString()}
                    title={absolute.toLocaleString()}>
                    {relativeTime(cp.createdAt)}
                  </time>
                </div>
              </div>
              <div className="cp-row-actions">
                <button
                  type="button"
                  className="cp-button cp-button--ghost"
                  title="Compare this checkpoint against the live editor"
                  onClick={() => {
                    enterCompare(cp.id, LATEST_ID);
                    onCompare?.();
                  }}>
                  Compare
                </button>
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
