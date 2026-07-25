/**
 * Shared versioned pub/sub primitive for the app's module-level stores
 * (conversations, memories, literature, checkpoints). Each store bumps an
 * integer version on change so React consumers can `useSyncExternalStore`-
 * style re-read on notify. Extracted from four near-identical copies.
 */

export type Listener = () => void;

export interface VersionedStore {
  /** Bump the version and notify all subscribers. */
  emit: () => void;
  /** Subscribe to changes; returns the unsubscribe function. */
  subscribe: (fn: Listener) => () => void;
  getVersion: () => number;
}

export function createVersionedStore(): VersionedStore {
  const listeners = new Set<Listener>();
  let version = 0;
  return {
    emit() {
      version++;
      listeners.forEach(l => l());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    getVersion() {
      return version;
    },
  };
}
