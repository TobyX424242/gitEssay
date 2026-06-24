/**
 * gitEssay — AI conversation store (IndexedDB via Dexie).
 *
 * Multiple, named, switchable conversations that persist across reloads, plus an
 * active-conversation pointer. Mirrors the checkpoints service pattern
 * (src/checkpoints/{db,service,useCheckpoints}.ts): pure async ops over a Dexie
 * table + a tiny pub/sub so React re-renders via useSyncExternalStore.
 *
 * Mutations re-read the conversation before writing, so callers don't race on
 * stale in-memory message arrays (e.g. a retry that resolves after the user
 * switched conversations still lands in the right place).
 */
import Dexie, {type Table} from 'dexie';
import {useEffect, useState, useSyncExternalStore} from 'react';

import type {ChatEditState, ChatMessage} from './types';

export interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface ChatMeta {
  key: string;
  activeConversationId: string | null;
}

class ChatDB extends Dexie {
  conversations!: Table<Conversation, string>;
  chatMeta!: Table<ChatMeta, string>;

  constructor() {
    super('gitEssayChat');
    this.version(1).stores({
      conversations: 'id, updatedAt',
      chatMeta: 'key',
    });
  }
}

export const chatDB = new ChatDB();

const META_KEY = 'active';

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
export async function listConversations(): Promise<Conversation[]> {
  const all = await chatDB.conversations.toArray();
  return all.sort((a, b) => b.updatedAt - a.updatedAt); // newest first
}

export async function getActiveConversationId(): Promise<string | null> {
  const m = await chatDB.chatMeta.get(META_KEY);
  return m?.activeConversationId ?? null;
}

// --- writes ----------------------------------------------------------------
export async function setActiveConversation(id: string): Promise<void> {
  await chatDB.chatMeta.put({key: META_KEY, activeConversationId: id});
  emit();
}

export async function createConversation(
  title = 'New conversation',
): Promise<Conversation> {
  const now = Date.now();
  const conv: Conversation = {
    id: newId(),
    title,
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  await chatDB.transaction('rw', chatDB.conversations, chatDB.chatMeta, async () => {
    await chatDB.conversations.put(conv);
    await chatDB.chatMeta.put({key: META_KEY, activeConversationId: conv.id});
  });
  emit();
  return conv;
}

/** Append turns (and optionally rename) to a conversation; re-reads to avoid staleness. */
export async function appendMessages(
  convId: string,
  msgs: ChatMessage[],
  title?: string,
): Promise<void> {
  const conv = await chatDB.conversations.get(convId);
  if (!conv) {
    return;
  }
  await chatDB.conversations.put({
    ...conv,
    messages: [...conv.messages, ...msgs],
    title: title ?? conv.title,
    updatedAt: Date.now(),
  });
  emit();
}

/** Replace a single message (used by retry); re-reads to avoid staleness. */
export async function replaceMessage(
  convId: string,
  msgId: string,
  next: ChatMessage,
): Promise<void> {
  const conv = await chatDB.conversations.get(convId);
  if (!conv) {
    return;
  }
  await chatDB.conversations.put({
    ...conv,
    messages: conv.messages.map(m => (m.id === msgId ? next : m)),
    updatedAt: Date.now(),
  });
  emit();
}

/** Update an edit's accept/reject state on a message. */
export async function setEditState(
  convId: string,
  msgId: string,
  editIdx: number,
  state: ChatEditState,
): Promise<void> {
  const conv = await chatDB.conversations.get(convId);
  if (!conv || !conv.messages) {
    return;
  }
  const messages = conv.messages.map(m =>
    m.id === msgId && m.edits
      ? {...m, edits: m.edits.map((e, i) => (i === editIdx ? {...e, state} : e))}
      : m,
  );
  await chatDB.conversations.put({...conv, messages, updatedAt: Date.now()});
  emit();
}

export async function deleteConversation(id: string): Promise<void> {
  const meta = await chatDB.chatMeta.get(META_KEY);
  await chatDB.conversations.delete(id);
  if (meta?.activeConversationId === id) {
    const remaining = (await chatDB.conversations.toArray()).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    if (remaining.length > 0) {
      await chatDB.chatMeta.put({key: META_KEY, activeConversationId: remaining[0].id});
    } else {
      await createConversation(); // always keep one
    }
  }
  emit();
}

/** Ensure at least one conversation exists and the active pointer is valid. */
export async function bootstrapConversations(): Promise<void> {
  const count = await chatDB.conversations.count();
  if (count === 0) {
    await createConversation();
    return;
  }
  const activeId = await getActiveConversationId();
  const activeExists = activeId ? Boolean(await chatDB.conversations.get(activeId)) : false;
  if (!activeExists) {
    const remaining = (await chatDB.conversations.toArray()).sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    if (remaining[0]) {
      await setActiveConversation(remaining[0].id);
    }
  }
}

// --- React binding ---------------------------------------------------------
export interface ConversationsData {
  conversations: Conversation[];
  activeId: string | null;
  active: Conversation | null;
}

export function useConversations(): ConversationsData {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  const [data, setData] = useState<ConversationsData>({
    conversations: [],
    activeId: null,
    active: null,
  });

  useEffect(() => {
    let alive = true;
    Promise.all([listConversations(), getActiveConversationId()]).then(
      ([list, activeId]) => {
        if (!alive) {
          return;
        }
        const validActive =
          activeId && list.some(c => c.id === activeId)
            ? activeId
            : (list[0]?.id ?? null);
        setData({
          conversations: list,
          activeId: validActive,
          active: list.find(c => c.id === validActive) ?? null,
        });
      },
    );
    return () => {
      alive = false;
    };
  }, [v]);

  return data;
}
