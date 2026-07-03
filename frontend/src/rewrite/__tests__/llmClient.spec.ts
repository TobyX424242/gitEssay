import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {streamChat} from '../llmClient';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

function mockStreamBody(
  chunks: Uint8Array[],
  opts: {close?: boolean; onCancel?: () => void} = {},
): ReadableStream<Uint8Array> {
  const {close = true, onCancel} = opts;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(c);
      }
      if (close) {
        controller.close();
      }
    },
    cancel() {
      onCancel?.();
    },
  });
}

describe('streamChat', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('routes text/thinking deltas and resolves on stream end', async () => {
    const body = mockStreamBody([
      enc('data: {"type":"thinking","delta":"think"}\n\n'),
      enc('data: {"type":"text","delta":"Hello"}\n\n'),
      enc('data: {"type":"text","delta":" world"}\n\n'),
    ]);
    globalThis.fetch = vi.fn().mockResolvedValue({ok: true, body} as never);

    const text: string[] = [];
    const think: string[] = [];
    await streamChat({system: '', messages: []}, {
      onText: d => text.push(d),
      onThinking: d => think.push(d),
    });

    expect(text.join('')).toBe('Hello world');
    expect(think.join('')).toBe('think');
  });

  it('#5 on an `error` event: rejects AND cancels the reader (no leak)', async () => {
    let cancelled = false;
    const body = mockStreamBody(
      [
        enc('data: {"type":"text","delta":"partial"}\n\n'),
        enc('data: {"type":"error","message":"provider timeout"}\n\n'),
      ],
      {close: false, onCancel: () => {
        cancelled = true;
      }},
    );
    globalThis.fetch = vi.fn().mockResolvedValue({ok: true, body} as never);

    await expect(
      streamChat({system: '', messages: []}, {}),
    ).rejects.toThrow('provider timeout');
    expect(cancelled).toBe(true);
  });

  it('throws the backend detail on a non-OK response (no body read)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({detail: 'boom'}),
    } as never);

    await expect(streamChat({system: '', messages: []}, {})).rejects.toThrow('boom');
  });

  it('does not cancel/leak when the stream completes normally', async () => {
    let cancelled = false;
    const body = mockStreamBody(
      [enc('data: {"type":"text","delta":"ok"}\n\n')],
      () => {
        cancelled = true;
      },
    );
    globalThis.fetch = vi.fn().mockResolvedValue({ok: true, body} as never);

    await streamChat({system: '', messages: []}, {
      onText: () => {},
    });
    // Normal completion reaches EOF and releases the reader on its own — cancel
    // must NOT have run (it's only for the failure path).
    expect(cancelled).toBe(false);
  });
});
