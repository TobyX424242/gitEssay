/**
 * gitEssay — project store (backend-backed).
 *
 * A Project owns a document + its checkpoint DAG + its conversations. The
 * "active project" is the one currently loaded in the editor; checkpoints and
 * conversations are scoped to it. The active id is remembered in localStorage.
 */
import {useSyncExternalStore} from 'react';

import {api} from '../utils/api';

export interface Project {
  id: string;
  name: string;
  current_checkpoint_id: string | null;
  active_conversation_id: string | null;
  created_at: number;
  updated_at: number;
}

const LS_KEY = 'gitessay-active-project';

let projects: Project[] = [];
let activeId: string | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  listeners.forEach(l => l());
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getVersion(): number {
  return version;
}

export function getActiveProjectId(): string | null {
  return activeId;
}

/** Fetch the project list from the backend and resolve the active project. */
export async function loadProjects(): Promise<void> {
  projects = await api.get<Project[]>('/projects');
  const stored =
    typeof localStorage !== 'undefined' ? localStorage.getItem(LS_KEY) : null;
  const valid = stored ? projects.some(p => p.id === stored) : false;
  activeId = valid ? stored : (projects[0]?.id ?? null);
  if (activeId && typeof localStorage !== 'undefined') {
    localStorage.setItem(LS_KEY, activeId);
  }
  emit();
}

export async function createProject(name?: string): Promise<Project> {
  const p = await api.post<Project>('/projects', name ? {name} : {});
  projects = [p, ...projects];
  activeId = p.id;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(LS_KEY, p.id);
  }
  emit();
  return p;
}

export async function renameProject(id: string, name: string): Promise<void> {
  const p = await api.patch<Project>(`/projects/${id}`, {name});
  projects = projects.map(x => (x.id === id ? p : x));
  emit();
}

export async function deleteProject(id: string): Promise<void> {
  await api.del(`/projects/${id}`);
  projects = projects.filter(p => p.id !== id);
  if (activeId === id) {
    activeId = projects[0]?.id ?? null;
    if (activeId && typeof localStorage !== 'undefined') {
      localStorage.setItem(LS_KEY, activeId);
    }
  }
  emit();
}

export async function setActiveProject(id: string): Promise<void> {
  activeId = id;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(LS_KEY, id);
  }
  emit();
}

export function useProjects(): {projects: Project[]; activeId: string | null} {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return {projects, activeId};
}

export function useActiveProjectId(): string | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return activeId;
}

export function useActiveProject(): Project | null {
  useSyncExternalStore(subscribe, getVersion, getVersion);
  return projects.find(p => p.id === activeId) ?? null;
}
