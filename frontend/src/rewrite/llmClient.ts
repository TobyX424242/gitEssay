/**
 * gitEssay — LLM settings client.
 *
 * The OpenAI/Anthropic request adapters live on the BACKEND (app/ai.py); the
 * API key is server-side. This is the thin frontend client: `testConnection`
 * posts the form values to /api/ai/test. The agent itself runs on the LangGraph
 * backend and streams via chat/agentClient.ts (/api/agent/run).
 */
import type {AISettings} from './aiSettings';
import {toApiBody} from './aiSettings';
import {api} from '../utils/api';

export async function testConnection(
  s: AISettings,
): Promise<{ok: boolean; message: string}> {
  return api.post<{ok: boolean; message: string}>('/ai/test', toApiBody(s));
}

export type ChatRole = 'user' | 'assistant';

/** One conversation turn as sent to the agent backend (history mapping). */
export interface ChatTurn {
  role: ChatRole;
  content: string;
}
