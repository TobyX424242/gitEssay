/**
 * gitEssay — agent engine preference (localStorage).
 *
 * Which producer drives the chat sidebar's streaming agent:
 *  - 'frontend' (default): the in-browser runAgent loop over /api/chat/stream
 *  - 'langgraph' (experimental): the backend LangGraph agent over /api/agent/run
 *
 * Opt-in for now: the LangGraph engine requires a function-calling-capable model.
 * This is a UI-side preference only — the backend serves both engines, so it does
 * not round-trip through AISettings. Changing it takes effect immediately (no
 * Save needed), mirroring the memory-enabled toggle.
 */
import {useSyncExternalStore} from 'react';

export type AgentEngine = 'frontend' | 'langgraph';

const KEY = 'gitessay-agent-engine';

function readEngine(): AgentEngine {
  try {
    return localStorage.getItem(KEY) === 'langgraph' ? 'langgraph' : 'frontend';
  } catch {
    return 'frontend';
  }
}

let engine: AgentEngine = readEngine();
const listeners = new Set<() => void>();

function emit(): void {
  listeners.forEach(l => l());
}

export function subscribeAgentEngine(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function getAgentEngine(): AgentEngine {
  return engine;
}

export function setAgentEngine(v: AgentEngine): void {
  engine = v;
  try {
    localStorage.setItem(KEY, String(v));
  } catch {
    /* storage unavailable — keep in-memory only */
  }
  emit();
}

export function useAgentEngine(): AgentEngine {
  // getSnapshot returns a primitive; useSyncExternalStore re-renders on flip.
  useSyncExternalStore(
    subscribeAgentEngine,
    () => engine,
    () => engine,
  );
  return engine;
}
