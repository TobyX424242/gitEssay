/**
 * gitEssay — shared LLM HTTP client (PLAN §10.6).
 *
 * One place for the OpenAI- and Anthropic-compatible request adapters, reused by
 * the chat provider and the settings "Test" button. The provider picks the
 * format from AISettings; this file only knows how to turn {system, user} into a
 * model completion string over HTTP.
 *
 *   openai    → POST {base}/chat/completions   (Authorization: Bearer <key>)
 *   anthropic → POST {base}/v1/messages        (x-api-key + dangerous-browser-access)
 */
import type {AISettings} from './aiSettings';

/**
 * Resolve the chat endpoint from a user base URL, tolerant of both conventions:
 * OpenAI users typically include `/v1` (https://api.openai.com/v1); Anthropic
 * users typically don't (https://api.anthropic.com).
 */
export function endpoint(s: AISettings): string {
  const base = s.baseURL.trim().replace(/\/+$/, '');
  if (s.format === 'anthropic') {
    if (base.endsWith('/v1/messages')) {
      return base;
    }
    if (base.endsWith('/v1')) {
      return `${base}/messages`;
    }
    return `${base}/v1/messages`;
  }
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

/** Rough char→token estimate. */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Soft-guard the input against the configured token budget, on a boundary. */
export function fitInput(text: string, maxTokens: number): string {
  if (maxTokens <= 0 || approxTokens(text) <= maxTokens) {
    return text;
  }
  const cap = maxTokens * 4;
  const cut = text.slice(0, cap);
  const brk = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('. '));
  const body = brk > cap * 0.5 ? cut.slice(0, brk) : cut;
  return `${body.trimEnd()}\n\n[…input truncated to fit the token budget…]`;
}

/** Strip accidental code fences / surrounding whitespace from model output. */
export function clean(content: string): string {
  let c = content.trim();
  c = c.replace(/^```[a-zA-Z0-9]*\n?/, '').replace(/\n?```$/, '');
  return c.trim();
}

async function readError(res: Response): Promise<string> {
  const raw = await res.text().catch(() => '');
  return raw.slice(0, 500);
}

async function callOpenAI(
  s: AISettings,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetch(endpoint(s), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${s.apiKey}`,
    },
    body: JSON.stringify({
      model: s.model,
      messages: [
        {role: 'system', content: system},
        {role: 'user', content: fitInput(user, s.maxInputTokens)},
      ],
      temperature: s.temperature,
      max_tokens: s.maxOutputTokens,
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await readError(res)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(
      `The model returned no text (finish_reason: ${data?.choices?.[0]?.finish_reason ?? 'unknown'}).`,
    );
  }
  return content;
}

async function callAnthropic(
  s: AISettings,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetch(endpoint(s), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': s.apiKey,
      'anthropic-version': '2023-06-01',
      // Anthropic only allows direct browser calls with this header set.
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: s.model,
      system,
      messages: [{role: 'user', content: fitInput(user, s.maxInputTokens)}],
      temperature: s.temperature,
      max_tokens: s.maxOutputTokens,
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await readError(res)}`);
  }
  const data = await res.json();
  const blocks: Array<{type?: string; text?: string}> = Array.isArray(
    data?.content,
  )
    ? data.content
    : [];
  const content = blocks
    .filter(b => b.type === 'text')
    .map(b => b.text ?? '')
    .join('');
  if (content.trim() === '') {
    throw new Error(
      `The model returned no text (stop_reason: ${data?.stop_reason ?? 'unknown'}).`,
    );
  }
  return content;
}

/** Send a {system, user} turn to the configured model; returns the raw reply. */
export async function callModel(
  s: AISettings,
  msg: {system: string; user: string},
): Promise<string> {
  return s.format === 'anthropic'
    ? callAnthropic(s, msg.system, msg.user)
    : callOpenAI(s, msg.system, msg.user);
}

/**
 * Lightweight connectivity check: a tiny ping with a small output budget.
 * Used by the settings panel's Test button.
 */
export async function testConnection(
  s: AISettings,
): Promise<{ok: boolean; message: string}> {
  try {
    const out = await callModel(
      {...s, maxOutputTokens: 32},
      {
        system: 'You are a connectivity test. Reply with the single word OK.',
        user: 'ping',
      },
    );
    return {ok: true, message: `OK — ${s.format}/${s.model} replied (${out.length} chars).`};
  } catch (e) {
    return {ok: false, message: e instanceof Error ? e.message : String(e)};
  }
}
