/**
 * gitEssay — small pure helpers shared by the chat sidebar hooks/components
 * (extracted from ChatSidebar).
 */

export function msgId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `m${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function deriveTitle(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) {
    return 'New conversation';
  }
  return t.length > 40 ? `${t.slice(0, 40)}…` : t;
}

export function truncate(s: string, n: number): string {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Transient notice banner (auto-dismissed by ChatSidebar after a few seconds). */
export interface ChatNotice {
  text: string;
  key: number;
}
