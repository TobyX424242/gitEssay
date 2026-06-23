/**
 * gitEssay — in-editor compare mode (VS Code "Open Changes"-style).
 *
 * CompareModeProvider holds the selected From/To checkpoint ids. When both are
 * set, CompareSurface renders the unified-inline diff directly over the editor
 * surface (the live editor stays mounted, read-only, underneath) with a bar to
 * change From/To and an "Exit compare" control. Exiting clears the selection
 * and the editor becomes editable again.
 */
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  createContext,
  type JSX,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

import {useCheckpoints} from '../checkpoints/useCheckpoints';
import {diffBlocks} from '../diff/diff';
import DiffView from '../diff/DiffView';
import {tokenizeBlocks} from '../diff/tokenize';

interface CompareModeValue {
  fromId: string | null;
  toId: string | null;
  active: boolean;
  enter: (fromId: string, toId: string) => void;
  setFrom: (id: string) => void;
  setTo: (id: string) => void;
  exit: () => void;
}

const CompareModeContext = createContext<CompareModeValue | null>(null);

export function CompareModeProvider({
  children,
}: {
  children: ReactNode;
}): JSX.Element {
  const [fromId, setFromId] = useState<string | null>(null);
  const [toId, setToId] = useState<string | null>(null);
  const value = useMemo<CompareModeValue>(
    () => ({
      fromId,
      toId,
      active: fromId !== null && toId !== null,
      enter: (f, t) => {
        setFromId(f);
        setToId(t);
      },
      setFrom: setFromId,
      setTo: setToId,
      exit: () => {
        setFromId(null);
        setToId(null);
      },
    }),
    [fromId, toId],
  );
  return (
    <CompareModeContext.Provider value={value}>
      {children}
    </CompareModeContext.Provider>
  );
}

export function useCompareMode(): CompareModeValue {
  const c = useContext(CompareModeContext);
  if (c === null) {
    throw new Error('useCompareMode must be used within CompareModeProvider');
  }
  return c;
}

/** Sentinel id for the live editor state — only valid as a "To" target. */
export const LATEST_ID = '__latest__';

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

interface OptionCP {
  id: string;
  createdAt: number;
  source: string;
  label?: string;
}

function renderOption(c: OptionCP): JSX.Element {
  if (c.id === LATEST_ID) {
    return (
      <option key={LATEST_ID} value={LATEST_ID}>
        Latest (live editor)
      </option>
    );
  }
  return (
    <option key={c.id} value={c.id}>
      {fmtTime(c.createdAt)} ({c.source}
      {c.label ? ` · ${c.label}` : ''})
    </option>
  );
}

export function CompareSurface(): JSX.Element | null {
  const [editor] = useLexicalComposerContext();
  const {fromId, toId, active, setFrom, setTo, exit} = useCompareMode();
  const {checkpoints} = useCheckpoints(editor);

  // Read-only while comparing; editable again on exit.
  useEffect(() => {
    editor.setEditable(!active);
  }, [editor, active]);

  // Live editor snapshot when To = "latest". Must run unconditionally (Rules
  // of Hooks) — before the early return below.
  const liveState = useMemo(
    () => (toId === LATEST_ID ? editor.getEditorState().toJSON() : null),
    [editor, toId],
  );

  if (!active || fromId === null || toId === null) {
    return null;
  }

  // Checkpoint timeline oldest→newest. To also offers the live editor state
  // ("latest") as the newest possible target; From never includes it.
  const cpTimeline = [...checkpoints].sort((a, b) => a.createdAt - b.createdAt);
  const latestEntry: OptionCP = {
    id: LATEST_ID,
    createdAt: Number.POSITIVE_INFINITY,
    source: 'live',
    label: 'Latest (live editor)',
  };
  const toTimeline: OptionCP[] = [...cpTimeline, latestEntry];
  const fromList = [...cpTimeline].reverse(); // newest-first, no latest
  const toList = [...toTimeline].reverse();   // newest-first, latest on top

  const step = (arr: OptionCP[], id: string | null, dir: number): string | null => {
    if (!id) {
      return null;
    }
    const i = arr.findIndex(c => c.id === id);
    if (i < 0) {
      return null;
    }
    const ni = i + dir;
    return ni >= 0 && ni < arr.length ? arr[ni].id : null;
  };

  const fromCp = cpTimeline.find(c => c.id === fromId);
  const toState = toId === LATEST_ID ? liveState : cpTimeline.find(c => c.id === toId)?.state;
  const ops =
    fromCp && fromCp.state && toState
      ? diffBlocks(tokenizeBlocks(fromCp.state), tokenizeBlocks(toState))
      : [];
  const changed = ops.filter(o => o.type !== 'equal').length;

  // From steps over checkpoints only; To steps over checkpoints + latest.
  const fromOlder = step(cpTimeline, fromId, -1);
  const fromNewer = step(cpTimeline, fromId, 1);
  const toOlder = step(toTimeline, toId, -1);
  const toNewer = step(toTimeline, toId, 1);

  return (
    <div className="compare-surface">
      <div className="compare-bar">
        <span className="compare-title">Comparing · read-only</span>
        <div className="compare-side">
          <span className="compare-label-text">From</span>
          <button
            type="button"
            className="cp-step"
            disabled={fromOlder === null}
            onClick={() => fromOlder && setFrom(fromOlder)}
            title="Older version"
            aria-label="From: older version">
            ‹
          </button>
          <select
            className="cp-input"
            value={fromId}
            onChange={e => setFrom(e.target.value)}>
            {fromList.map(renderOption)}
          </select>
          <button
            type="button"
            className="cp-step"
            disabled={fromNewer === null}
            onClick={() => fromNewer && setFrom(fromNewer)}
            title="Newer version"
            aria-label="From: newer version">
            ›
          </button>
        </div>
        <span className="diff-arrow">→</span>
        <div className="compare-side">
          <span className="compare-label-text">To</span>
          <button
            type="button"
            className="cp-step"
            disabled={toOlder === null}
            onClick={() => toOlder && setTo(toOlder)}
            title="Older version"
            aria-label="To: older version">
            ‹
          </button>
          <select
            className="cp-input"
            value={toId}
            onChange={e => setTo(e.target.value)}>
            {toList.map(renderOption)}
          </select>
          <button
            type="button"
            className="cp-step"
            disabled={toNewer === null}
            onClick={() => toNewer && setTo(toNewer)}
            title="Newer version"
            aria-label="To: newer version">
            ›
          </button>
        </div>
        <span className="diff-summary">
          {changed} change{changed === 1 ? '' : 's'}
        </span>
        <button type="button" className="cp-button compare-exit" onClick={exit}>
          Exit compare ✕
        </button>
      </div>
      <div className="compare-scroll">
        <div className="diff-legend">
          <span className="diff-added">added</span>
          <span className="diff-removed">removed</span>
          <span className="diff-modified">format / size</span>
          <span className="diff-block diff-block-added">⊕ block</span>
        </div>
        {changed === 0 ? (
          <div className="diff-empty">No differences.</div>
        ) : (
          <DiffView ops={ops} />
        )}
      </div>
    </div>
  );
}
