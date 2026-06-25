/**
 * gitEssay — LLM gateway client.
 *
 * The OpenAI/Anthropic request adapters live on the BACKEND (app/ai.py); the API
 * key is server-side. This is the thin frontend client: `callModel` posts
 * {system, user} to /api/chat (the provider's settings are applied server-side),
 * and `testConnection` posts the form values to /api/ai/test.
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
