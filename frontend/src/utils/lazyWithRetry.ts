/**
 * gitEssay — React.lazy with a one-shot reload fallback.
 *
 * After a deploy, an open tab can hold an old index.html referencing hashed
 * chunks that no longer exist on the server; the dynamic import then fails
 * with a chunk-load error. Reloading once fetches the fresh HTML + chunks.
 * A sessionStorage flag makes sure we reload at most once per session (a real
 * bug would otherwise loop forever).
 */
import {type ComponentType, type LazyExoticComponent, lazy} from 'react';

const RELOAD_FLAG = 'gitEssay:chunk-reload';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{default: T}>,
): LazyExoticComponent<T> {
  return lazy(async () => {
    try {
      const module = await factory();
      // Loaded fine — clear the flag so the NEXT deploy can trigger a reload.
      sessionStorage.removeItem(RELOAD_FLAG);
      return module;
    } catch (err) {
      if (typeof window !== 'undefined' && !sessionStorage.getItem(RELOAD_FLAG)) {
        sessionStorage.setItem(RELOAD_FLAG, '1');
        window.location.reload();
        // Never resolve — the page is reloading anyway.
        return new Promise<never>(() => {});
      }
      throw err;
    }
  });
}
