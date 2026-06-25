/**
 * gitEssay — AI conversation store (backend-backed, per project).
 *
 * Same exported surface as the old Dexie version so ChatSidebar is unchanged:
 * useConversations() + the message ops (appendMessages / replaceMessage /
 * setEditState / create / delete / setActive / bootstrap). The active
 * conversation is the project's `active_conversation_id`.
 */
import {useEffect, useState, useSyncExternalStore} from 'react';

import {
  getActiveProjectId,
  useActiveProjectId,
  useProjects,
} from '../projects/projectStore';
import {api} from '../utils/api';
import type {ChatEditState, ChatMessage} from './types';

export interface Conversation {
  id: string;
  project_id: string;
  title: string;
  messages: ChatMessage[];
  created_at: number;
  updated_at: number;
}

interface ApiConversation {
  id: string;
  project_id: string;
  title: string;
  messages: ChatMessage[];
  created_at: number;
  updated_at: number;
}

// --- pub/sub ---------------------------------------------------------------
type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

function emit(): void {
  version++;
  listeners.forEach(l => l());
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getVersion(): number {
  return version;
}

// --- reads -----------------------------------------------------------------
async function listConversations(projectId: string): Promise<Conversation[]> {
  const rows = await api.get<ApiConversation[]>(
    `/projects/${projectId}/conversations`,
  );
  return rows;
}

// --- writes ----------------------------------------------------------------
export async function createConversation(
  title?: string,
): Promise<Conversation | null> {
  const pid = getActiveProjectId();
  if (!pid) {
    return null;
  }
  const c = await api.post<ApiConversation>(`/projects/${pid}/conversations`, {
    title: title ?? null,
  });
  emit();
  return c;
}

export async function setActiveConversation(id: string): Promise<void> {
  const pid = getActiveProjectId();
  if (!pid) {
    return;
  }
  await api.post(`/projects/${pid}/conversations/active`, {id});
  emit();
}

export async function appendMessages(
  convId: string,
  msgs: ChatMessage[],
  title?: string,
): Promise<void> {
  await api.post(`/conversations/${convId}/messages`, {
    messages: msgs,
    title: title ?? null,
  });
  emit();
}

export async function replaceMessage(
  convId: string,
  msgId: string,
  next: ChatMessage,
): Promise<void> {
  await api.put(`/conversations/${convId}/messages/${msgId}`, {message: next});
  emit();
}

export async function setEditState(
  convId: string,
  msgId: string,
  editIdx: number,
  state: ChatEditState,
): Promise<void> {
  await api.patch(`/conversations/${convId}/messages/${msgId}/edits/${editIdx}`, {
    state,
  });
  emit();
}

export async function deleteConversation(id: string): Promise<void> {
  await api.del(`/conversations/${id}`);
  emit();
}

/** Ensure the active project has at least one conversation. */
export async function bootstrapConversations(): Promise<void> {
  const pid = getActiveProjectId();
  if (!pid) {
    return;
  }
  const list = await listConversations(pid);
  if (list.length === 0) {
    await createConversation();
  }
}

// --- React binding ---------------------------------------------------------
export interface ConversationsData {
  conversations: Conversation[];
  activeId: string | null;
  active: Conversation | null;
}

export function useConversations(): ConversationsData {
  const activeProjectId = useActiveProjectId();
  const {projects} = useProjects();
  const activeProject = projects.find(p => p.id === activeProjectId);
  const activeConvId = activeProject?.active_conversation_id ?? null;
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);

  const [data, setData] = useState<ConversationsData>({
    conversations: [],
    activeId: null,
    active: null,
  });

  useEffect(() => {
    if (!activeProjectId) {
      return;
    }
    let alive = true;
    listConversations(activeProjectId).then(list => {
      if (!alive) {
        return;
      }
      const stored = activeProject?.active_conversation_id;
      const activeId =
        stored && list.some(c => c.id === stored)
          ? stored
          : (list[0]?.id ?? null);
      setData({
        conversations: list,
        activeId,
        active: list.find(c => c.id === activeId) ?? null,
      });
    });
    return () => {
      alive = false;
    };
  }, [activeProjectId, activeConvId, v]);

  return data;
}
