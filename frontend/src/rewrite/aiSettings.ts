/**
 * gitEssay — AI provider settings (backend-backed).
 *
 * The API key lives on the backend (never in the browser). The frontend reads a
 * MASKED view (api_key="" + has_key) and writes by PUT; sending api_key=null (an
 * empty field) keeps the existing key. useAISettings() re-renders after a save.
 */
import {useSyncExternalStore} from 'react';

import {api} from '../utils/api';

export type ProviderFormat = 'openai' | 'anthropic';

export interface AISettings {
  format: ProviderFormat;
  baseURL: string;
  /** Empty in the masked read; what the user types in the settings form. */
  apiKey: string;
  /** Whether a key is stored server-side. */
  hasKey: boolean;
  model: string;
  temperature: number;
  maxInputTokens: number;
  maxOutputTokens: number;
}

export const DEFAULT_MODEL: Record<ProviderFormat, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-3-5-sonnet-latest',
};

export const DEFAULT_BASE: Record<ProviderFormat, string> = {
  openai: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com',
};

const DEFAULTS: AISettings = {
  format: 'openai',
  baseURL: DEFAULT_BASE.openai,
  apiKey: '',
  hasKey: false,
  model: DEFAULT_MODEL.openai,
  temperature: 0.7,
  maxInputTokens: 16000,
  maxOutputTokens: 8000,
};

interface ApiSettings {
  provider_format: string;
  base_url: string;
  model: string;
  temperature: number;
  max_input_tokens: number;
  max_output_tokens: number;
  has_key: boolean;
  api_key: string;
}

function mapIn(a: ApiSettings): AISettings {
  return {
    format: a.provider_format === 'anthropic' ? 'anthropic' : 'openai',
    baseURL: a.base_url,
    apiKey: '',
    hasKey: a.has_key,
    model: a.model,
    temperature: a.temperature,
    maxInputTokens: a.max_input_tokens,
    maxOutputTokens: a.max_output_tokens,
  };
}

/** Snake-case body for PUT /ai/settings and POST /ai/test (api_key=null keeps existing). */
export function toApiBody(s: AISettings): Record<string, unknown> {
  return {
    provider_format: s.format,
    base_url: s.baseURL,
    model: s.model,
    temperature: s.temperature,
    max_input_tokens: s.maxInputTokens,
    max_output_tokens: s.maxOutputTokens,
    api_key: s.apiKey ? s.apiKey : null,
  };
}

// --- cache + pub/sub -------------------------------------------------------
let cache: AISettings = {...DEFAULTS};
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  listeners.forEach(l => l());
}

export function subscribeAI(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getAIVersion(): number {
  return version;
}

export async function loadAISettings(): Promise<AISettings> {
  const a = await api.get<ApiSettings>('/ai/settings');
  cache = mapIn(a);
  emit();
  return cache;
}

export async function saveAISettings(s: AISettings): Promise<void> {
  const a = await api.put<ApiSettings>('/ai/settings', toApiBody(s));
  cache = mapIn(a);
  emit();
}

export function isConfigured(s: AISettings): boolean {
  return !!s.baseURL.trim() && !!s.model.trim() && s.hasKey;
}

export function useAISettings(): AISettings {
  useSyncExternalStore(subscribeAI, getAIVersion, getAIVersion);
  return cache;
}

export function useAIConfigured(): boolean {
  return isConfigured(useAISettings());
}
