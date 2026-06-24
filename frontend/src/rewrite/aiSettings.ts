/**
 * gitEssay — AI provider settings (PLAN §10.6: client-side call with the user’s
 * own key). Single-user, local app → config lives in localStorage; the key is
 * stored locally in the browser and sent only to the user-configured base URL.
 *
 * Two request formats are supported (PLAN: compatible with OpenAI + Anthropic):
 *   - 'openai'    → POST {base}/chat/completions  (OpenAI, OpenRouter, vLLM, …)
 *   - 'anthropic' → POST {base}/v1/messages        (Anthropic + compatible proxies)
 *
 * The advanced params are generous by default: a large input budget so the model
 * can take in the whole selected region (and later the whole essay), and a large
 * output budget so a rewrite is never truncated (and leaves room for tool calls
 * in later phases).
 */
import {useSyncExternalStore} from 'react';

export type ProviderFormat = 'openai' | 'anthropic';

export interface AISettings {
  format: ProviderFormat;
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  /** Soft guard: the input is truncated to roughly this many tokens. */
  maxInputTokens: number;
  /** Maps to `max_tokens` on both APIs. */
  maxOutputTokens: number;
}

/** Per-format default model + base URL. */
export const DEFAULT_MODEL: Record<ProviderFormat, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
};

export const DEFAULT_BASE: Record<ProviderFormat, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

export const DEFAULT_AI_SETTINGS: AISettings = {
  format: 'openai',
  baseURL: DEFAULT_BASE.openai,
  apiKey: '',
  model: DEFAULT_MODEL.openai,
  temperature: 0.7,
  maxInputTokens: 16000,
  maxOutputTokens: 8000,
};

const STORAGE_KEY = 'gitessay-ai-settings';

// --- pub/sub so React re-renders when settings change ---------------------
type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;
let cache: AISettings | null = null;

function read(): AISettings {
  if (cache) {
    return cache;
  }
  try {
    const raw =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(STORAGE_KEY)
        : null;
    cache = raw
      ? {...DEFAULT_AI_SETTINGS, ...(JSON.parse(raw) as Partial<AISettings>)}
      : {...DEFAULT_AI_SETTINGS};
  } catch {
    cache = {...DEFAULT_AI_SETTINGS};
  }
  return cache;
}

export function loadAISettings(): AISettings {
  return read();
}

export function saveAISettings(s: AISettings): void {
  cache = s;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    // Storage unavailable (private mode) — settings live in memory only.
  }
  version++;
  listeners.forEach(l => l());
}

export function resetAISettings(): void {
  saveAISettings({...DEFAULT_AI_SETTINGS});
}

export function subscribeAI(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getAIVersion(): number {
  return version;
}

export function isConfigured(s: AISettings): boolean {
  return (
    s.baseURL.trim().length > 0 &&
    s.apiKey.trim().length > 0 &&
    s.model.trim().length > 0
  );
}

/** React binding: re-renders whenever settings are saved. */
export function useAISettings(): AISettings {
  useSyncExternalStore(subscribeAI, getAIVersion, getAIVersion);
  return read();
}

/** Convenience: is the live provider currently usable? */
export function useAIConfigured(): boolean {
  return isConfigured(useAISettings());
}
