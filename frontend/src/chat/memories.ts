/**
 * gitEssay — AI long-term, project-scoped memory (the AI's running notes about a
 * project) + the user-facing enable/disable toggle.
 *
 * The notes themselves are stored backend-side (`/api/projects/{pid}/memories`)
 * and injected into the agent's system prompt by runAgent. Whether to use memory
 * at all is a user preference kept in localStorage (the backend just stores and
 * serves notes; the frontend gates injection + the `remember` action on this flag).
 */
import {useEffect, useSyncExternalStore, useState} from 'react';

import {api} from '../utils/api';

export interface Memory {
  id: string;
  project_id: string;
  content: string;
  created_at: number;
}

interface ApiMemory {
  id: string;
  project_id: string;
  content: string;
  created_at: number;
}

// --- memories list (per active project) ------------------------------------
type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

function emit(): void {
  version++;
  listeners.forEach(l => l());
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function getVersion(): number {
  return version;
}

export async function loadMemories(pid: string): Promise<Memory[]> {
  const rows = await api.get<ApiMemory[]>(`/projects/${pid}/memories`);
  return rows;
}

export async function addMemory(pid: string, content: string): Promise<Memory> {
  const m = await api.post<ApiMemory>(`/projects/${pid}/memories`, {content});
  emit(); // bump version so useMemories refetches
  return m;
}

export async function deleteMemory(id: string): Promise<void> {
  await api.del(`/memories/${id}`);
  emit();
}

/**
 * Reactively read the active project's memories. Refetches when the project or
 * the store version changes (add/delete bump the version).
 */
export function useMemories(pid: string | null): Memory[] {
  // `v` bumps on add/delete (emit), so the effect refetches reactively.
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  const [data, setData] = useState<Memory[]>([]);

  useEffect(() => {
    if (!pid) {
      setData([]);
      return;
    }
    let alive = true;
    loadMemories(pid)
      .then(rows => {
        if (alive) {
          setData(rows);
        }
      })
      .catch(() => {
        if (alive) {
          setData([]);
        }
      });
    return () => {
      alive = false;
    };
  }, [pid, v]);

  return data;
}

// --- enable/disable toggle (localStorage preference) -----------------------
const MEM_KEY = 'gitessay-memory-enabled';

function readEnabled(): boolean {
  try {
    return localStorage.getItem(MEM_KEY) !== 'false'; // default: on
  } catch {
    return true;
  }
}

let enabled = readEnabled();
const prefListeners = new Set<Listener>();

function emitPref(): void {
  prefListeners.forEach(l => l());
}

function subscribePref(fn: Listener): () => void {
  prefListeners.add(fn);
  return () => {
    prefListeners.delete(fn);
  };
}

export function isMemoryEnabled(): boolean {
  return enabled;
}

export function setMemoryEnabled(v: boolean): void {
  enabled = v;
  try {
    localStorage.setItem(MEM_KEY, String(v));
  } catch {
    /* storage unavailable — keep in-memory only */
  }
  emitPref();
}

export function useMemoryEnabled(): boolean {
  // getSnapshot returns a boolean primitive; useSyncExternalStore compares with
  // Object.is, so this re-renders exactly when the value flips.
  useSyncExternalStore(
    subscribePref,
    () => enabled,
    () => enabled,
  );
  return enabled;
}
