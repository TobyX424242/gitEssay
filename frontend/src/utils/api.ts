/**
 * gitEssay — tiny API client for the FastAPI backend.
 *
 * In dev, Vite proxies `/api` → http://localhost:8000 (see vite.config.ts), so
 * the frontend calls same-origin `/api/...` with no CORS concerns. Errors are
 * turned into thrown `Error`s carrying the backend's `detail`/`message`.
 */
const BASE = '/api';

// Fail requests that hang forever (backend stuck, dead connection) instead of
// leaving the UI pending indefinitely.
const REQUEST_TIMEOUT_MS = 30_000;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // FormData bodies must NOT carry a manual Content-Type — the browser sets
  // multipart/form-data with its boundary.
  const isForm = init?.body instanceof FormData;
  const method = (init?.method ?? 'GET').toUpperCase();
  // One silent retry for idempotent GETs: a dropped connection on app load
  // (project list, settings) should heal itself instead of showing an error.
  const maxAttempts = method === 'GET' ? 2 : 1;

  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        ...init,
        signal: AbortSignal.any([
          ...(init?.signal ? [init.signal] : []),
          AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ]),
        headers: {
          ...(isForm ? {} : {'Content-Type': 'application/json'}),
          ...(init?.headers ?? {}),
        },
      });
    } catch (err) {
      // fetch itself threw: network failure or our 30s timeout. Safe to retry
      // for GETs; non-GETs exit immediately (maxAttempts=1).
      lastError = err;
      continue;
    }
    // A server response (even 4xx/5xx) is a definitive answer — never retried.
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
    if (res.status === 204) {
      return null as T;
    }
    return (await res.json()) as T;
  }
  throw lastError;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  /** Multipart upload (file attachments) — the browser sets the boundary. */
  postForm: <T>(path: string, form: FormData) =>
    request<T>(path, {method: 'POST', body: form}),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PUT',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, {
      method: 'PATCH',
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  del: <T>(path: string) => request<T>(path, {method: 'DELETE'}),
};
