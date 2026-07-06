import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from 'lexical';

import {runAgentGraph} from '../agentClient';

/** Build a Lexical editor whose root contains the given paragraph texts. */
async function makeEditor(paras: string[]): Promise<LexicalEditor> {
  const editor = createEditor();
  await editor.update(() => {
    const root = $getRoot();
    for (const p of paras) {
      root.append($createParagraphNode().append($createTextNode(p)));
    }
  });
  return editor;
}

/** Encode an array of SSE event objects as the `data: {json}\n\n` byte stream the
 *  backend sends. */
function sseBody(events: object[]): ReadableStream<Uint8Array> {
  const text = events.map(e => `data: ${JSON.stringify(e)}\n\n`).join('');
  const enc = new TextEncoder();
  return new ReadableStream({
    start(ctrl) {
      ctrl.enqueue(enc.encode(text));
      ctrl.close();
    },
  });
}

/** A Response-shaped object with a streaming body (the only fields agentClient
 *  touches on the success path). */
function sseResponse(events: object[]): Response {
  return {ok: true, status: 200, body: sseBody(events)} as unknown as Response;
}

/** Minimal AgentGraphOpts with per-test overrides. */
function baseOpts(
  editor: LexicalEditor,
  overrides: Record<string, unknown> = {},
) {
  return {
    editor,
    projectId: 'p1',
    instruction: 'tighten the intro',
    mode: 'document' as const,
    history: [],
    signal: new AbortController().signal,
    memoryEnabled: false,
    memories: [],
    onUpdate: () => {},
    ...overrides,
  };
}

describe('runAgentGraph (LangGraph engine)', () => {
  let lastBody: any;

  beforeEach(() => {
    lastBody = undefined;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Stub fetch to return the given SSE events, capturing the request body. */
  function stubFetch(events: object[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        lastBody = JSON.parse(init.body as string);
        return sseResponse(events);
      }),
    );
  }

  it('streams text + a read step and finalizes with no terminal action', async () => {
    const editor = await makeEditor(['Intro paragraph.', 'Second para.']);
    stubFetch([
      {type: 'text', delta: 'Let me '},
      {type: 'text', delta: 'check the doc.'},
      {type: 'step', step: {kind: 'read', hits: 2, at: 0}},
      {type: 'text', delta: 'All good.'},
      {type: 'done'},
    ]);

    const msg = await runAgentGraph(baseOpts(editor) as any);

    expect(msg.text).toBe('Let me check the doc.All good.');
    expect(msg.steps?.[0]).toMatchObject({kind: 'read', hits: 2});
    expect(msg.action).toBeNull();
    expect(msg.streaming).toBe(false);
    // the live document snapshot is sent to the backend
    expect(lastBody.doc_paragraphs).toEqual(['Intro paragraph.', 'Second para.']);
    expect(lastBody.instruction).toBe('tighten the intro');
  });

  it('a patch event sets action.patch + pending edits and drops no-op edits', async () => {
    const editor = await makeEditor(['Hello world.']);
    stubFetch([
      {type: 'text', delta: 'Tightening.'},
      {
        type: 'patch',
        explanation: 'Tighten topic sentence',
        edits: [
          {search: 'Hello world.', replace: 'Hello, world.'}, // real edit
          {search: 'same', replace: 'same'}, // no-op → dropped
        ],
      },
      {type: 'done'},
    ]);

    const msg = await runAgentGraph(baseOpts(editor) as any);

    expect(msg.action).toEqual({kind: 'patch', explanation: 'Tighten topic sentence'});
    expect(msg.edits).toHaveLength(1);
    expect(msg.edits?.[0]).toMatchObject({
      search: 'Hello world.',
      replace: 'Hello, world.',
      state: 'pending',
    });
  });

  it('an all-no-op patch downgrades to an advice turn (no empty card)', async () => {
    const editor = await makeEditor(['Hello.']);
    stubFetch([
      {
        type: 'patch',
        explanation: 'no change really',
        edits: [{search: 'x', replace: 'x'}],
      },
      {type: 'done'},
    ]);

    const msg = await runAgentGraph(baseOpts(editor) as any);

    expect(msg.action).toBeNull();
    expect(msg.edits).toBeUndefined();
    expect(msg.text).toBe('No changes to apply.');
  });

  it('an ask event sets action.ask', async () => {
    const editor = await makeEditor(['Body.']);
    stubFetch([
      {type: 'ask', question: 'Formal or casual?', options: ['Formal', 'Casual']},
      {type: 'done'},
    ]);

    const msg = await runAgentGraph(baseOpts(editor) as any);

    expect(msg.action).toEqual({
      kind: 'ask',
      question: 'Formal or casual?',
      options: ['Formal', 'Casual'],
    });
  });

  it('an error event preserves streamed text and attaches the error', async () => {
    const editor = await makeEditor(['Body.']);
    stubFetch([
      {type: 'text', delta: 'Partial answer'},
      {type: 'error', message: 'tool calling not supported'},
      {type: 'done'},
    ]);

    const msg = await runAgentGraph(baseOpts(editor) as any);

    expect(msg.text).toBe('Partial answer');
    expect(msg.error).toBe('tool calling not supported');
  });

  it('a non-OK response throws the backend detail', async () => {
    const editor = await makeEditor(['Body.']);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({detail: 'AI is not configured'}),
      })),
    );

    await expect(runAgentGraph(baseOpts(editor) as any)).rejects.toThrow(
      'AI is not configured',
    );
  });

  it('an abort mid-stream preserves the partial with no error field', async () => {
    const editor = await makeEditor(['Body.']);
    const enc = new TextEncoder();
    // Enqueue some text, then error the stream with an AbortError on the next read.
    const body = new ReadableStream<Uint8Array>({
      start(ctrl) {
        ctrl.enqueue(
          enc.encode(`data: ${JSON.stringify({type: 'text', delta: 'Partial'})}\n\n`),
        );
      },
      pull(ctrl) {
        ctrl.error(new DOMException('aborted', 'AbortError'));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ok: true, status: 200, body}) as unknown as Response),
    );

    const msg = await runAgentGraph(baseOpts(editor) as any);

    expect(msg.text).toBe('Partial');
    expect(msg.error).toBeUndefined();
    expect(msg.streaming).toBe(false);
  });
});
