/**
 * gitEssay — LLM gateway client.
 *
 * The OpenAI/Anthropic request adapters live on the BACKEND (app/ai.py); the API
 * key is server-side. This is the thin frontend client: `callModel` posts
 * {system, user} to /api/chat (the provider's settings are applied server-side),
 * and `testConnection` posts the form values to /api/ai/test.
 *
 * `streamChat` POSTs a multi-turn {system, messages} to /api/chat/stream and
 * consumes the SSE event stream (thinking/text/done/error) for the agent loop.
 */
import type {AISettings} from './aiSettings';
import {toApiBody} from './aiSettings';
import {api} from '../utils/api';

/** settings are ignored (the backend uses its stored settings). */
export async function callModel(
  _settings: AISettings,
  msg: {system: string; user: string},
): Promise<string> {
  const res = await api.post<{content: string}>('/chat', msg);
  return res.content;
}

export async function testConnection(
  s: AISettings,
): Promise<{ok: boolean; message: string}> {
  return api.post<{ok: boolean; message: string}>('/ai/test', toApiBody(s));
}

export type ChatRole = 'user' | 'assistant';

/** One turn in the agent conversation sent to the streaming gateway. */
export interface ChatTurn {
  role: ChatRole;
  content: string;
}

export interface StreamHandlers {
  /** Reasoning delta (native reasoning_content / Anthropic thinking, when present). */
  onThinking?: (delta: string) => void;
  /** Visible content delta (prose + action markup). */
  onText?: (delta: string) => void;
  signal?: AbortSignal;
}

/**
 * Stream one model turn. Resolves on `done`; throws on a non-OK response or an
 * `error` event (the error carries the backend's message). Aborting `signal`
 * rejects with an AbortError — callers may treat that as a clean stop.
 */
export async function streamChat(
  req: {system: string; messages: ChatTurn[]},
  h: StreamHandlers,
): Promise<void> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify(req),
    signal: h.signal,
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      message = data.detail || data.message || message;
    } catch {
      // non-JSON error body
    }
    throw new Error(message);
  }
  if (!res.body) {
    throw new Error('streaming is not supported by this transport');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const {done, value} = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, {stream: true});
    // SSE events are separated by a blank line. Each event may itself span
    // multiple `data:` continuations, but our backend emits one per event.
    let sep: number;
    while ((sep = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = chunk
        .split('\n')
        .find(l => l.startsWith('data:'));
      if (!dataLine) {
        continue;
      }
      const payload = dataLine.slice('data:'.length).trim();
      if (!payload) {
        continue;
      }
      let ev: {type: string; delta?: string; message?: string};
      try {
        ev = JSON.parse(payload);
      } catch {
        continue;
      }
      if (ev.type === 'thinking' && ev.delta) {
        h.onThinking?.(ev.delta);
      } else if (ev.type === 'text' && ev.delta) {
        h.onText?.(ev.delta);
      } else if (ev.type === 'error') {
        throw new Error(ev.message ?? 'stream error');
      }
      // 'done' falls through; the reader will return done=true next.
    }
  }
}
