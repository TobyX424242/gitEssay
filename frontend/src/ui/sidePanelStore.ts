/**
 * gitEssay — a collapsible + resizable side-panel store (shared by the AI dock
 * and the Versions dock). Holds {open, width}, persists both to localStorage,
 * and exposes a useSyncExternalStore hook plus resize helpers (clamp + the
 * "release below this width collapses" threshold).
 *
 * Width is intentionally stored here (not as a React prop) so the resize handle
 * can update it cheaply on every pointermove without re-rendering ancestors.
 */
import {useSyncExternalStore} from 'react';

function clampWidth(w: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(w)));
}

export interface SidePanelOptions {
  storageKey: string;
  defaultOpen: boolean;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  /** A released drag at/below this width collapses the panel. */
  collapseAt: number;
}

export interface SidePanelState {
  open: boolean;
  width: number;
}

export interface SidePanelStore extends SidePanelOptions {
  /** Floor while dragging (below minWidth, above collapseAt) so a drag can reach the collapse zone. */
  dragFloor: number;
  getState(): SidePanelState;
  /** Stable ref for useSyncExternalStore (unchanged between mutations). */
  getSnapshot(): SidePanelState;
  open(): void;
  close(): void;
  toggle(): void;
  /** Persisted width, clamped to [minWidth, maxWidth]. */
  setWidth(w: number): void;
  /** Transient drag width, clamped to [dragFloor, maxWidth] (reaches collapse zone). */
  setDragWidth(w: number): void;
  clampWidth(w: number): number;
  shouldCollapse(w: number): boolean;
  subscribe(fn: () => void): () => void;
}

export function createSidePanelStore(opts: SidePanelOptions): SidePanelStore {
  const {storageKey, defaultOpen, defaultWidth, minWidth, maxWidth, collapseAt} = opts;
  // The drag floor equals the rest minimum: a dock can be dragged narrow and
  // LEFT narrow (no snap-back), so it can be "folded" and pulled back. It only
  // collapses when released at/below collapseAt (just above the floor), i.e.
  // dragged essentially shut.
  const dragFloor = minWidth;
  const listeners = new Set<() => void>();

  function load(): SidePanelState {
    try {
      const raw =
        typeof localStorage !== 'undefined'
          ? localStorage.getItem(storageKey)
          : null;
      if (raw) {
        const p = JSON.parse(raw) as Partial<SidePanelState>;
        return {
          open: typeof p.open === 'boolean' ? p.open : defaultOpen,
          width:
            typeof p.width === 'number'
              ? clampWidth(p.width, minWidth, maxWidth)
              : defaultWidth,
        };
      }
    } catch {
      // ignore
    }
    return {open: defaultOpen, width: defaultWidth};
  }

  let state: SidePanelState = load();

  function emit(): void {
    listeners.forEach(l => l());
  }
  function persist(): void {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // ignore
    }
  }
  function set(next: SidePanelState): void {
    state = next;
    persist();
    emit();
  }

  return {
    ...opts,
    dragFloor,
    getState: () => state,
    getSnapshot: () => state,
    open: () => {
      if (!state.open) {
        set({open: true, width: state.width});
      }
    },
    close: () => {
      if (state.open) {
        set({open: false, width: state.width});
      }
    },
    toggle: () => set({open: !state.open, width: state.width}),
    setWidth: w => set({open: state.open, width: clampWidth(w, minWidth, maxWidth)}),
    setDragWidth: w => set({open: state.open, width: clampWidth(w, dragFloor, maxWidth)}),
    clampWidth: w => clampWidth(w, minWidth, maxWidth),
    shouldCollapse: w => w <= collapseAt,
    subscribe: fn => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}

/** React binding: re-renders on open/width change. */
export function useSidePanel(store: SidePanelStore): SidePanelState {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
