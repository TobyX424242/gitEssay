import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  createEditor,
  type LexicalEditor,
} from 'lexical';

vi.mock('../../rewrite/llmClient', () => ({
  streamChat: vi.fn(),
}));

// Imported AFTER vi.mock so the mock replaces the module providers.ts depends on.
import {streamChat} from '../../rewrite/llmClient';
import {runAgent} from '../providers';

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

/** Minimal RunAgentOpts with per-test overrides. */
function baseOpts(editor: LexicalEditor, overrides: Record<string, unknown> = {}) {
  return {
    editor,
    instruction: 'do something',
    mode: 'document' as const,
    history: [],
    signal: new AbortController().signal,
    onUpdate: () => {},
    memoryEnabled: false,
    memories: [],
    ...overrides,
  };
}

describe('runAgent', () => {
  beforeEach(() => {
    vi.mocked(streamChat).mockReset();
  });

  it('#8 a repeat FULL read returns a back-reference, not the doc body', async () => {
    const editor = await makeEditor(['Para one', 'Para two', 'Para three']);
    const calls: string[] = [];

    vi.mocked(streamChat).mockImplementation(async (req: any, h: any) => {
      calls.push(req.messages[req.messages.length - 1].content);
      const turn = calls.length;
      if (turn <= 2) {
        h.onText?.('<action>{"kind":"read"}</action>');
      } else {
        h.onText?.('<action>{"kind":"finish","summary":"done"}</action>');
      }
    });

    // selection mode: the full doc is NOT in the initial message, so the FIRST
    // read injects it and the SECOND read must be de-duplicated.
    await runAgent(
      baseOpts(editor, {mode: 'selection', selectionText: 'selected text'}) as any,
    );

    expect(calls[1]).toContain('Para one'); // first read injected the doc
    expect(calls[2]).toContain('already in this conversation');
    expect(calls[2]).not.toContain('Para one'); // second read de-duplicated
  });

  it('#8 a repeat QUERY read/search returns a back-reference', async () => {
    const editor = await makeEditor(['cats are great', 'dogs are fine', 'cats meow']);
    const calls: string[] = [];

    vi.mocked(streamChat).mockImplementation(async (req: any, h: any) => {
      calls.push(req.messages[req.messages.length - 1].content);
      const turn = calls.length;
      if (turn <= 2) {
        h.onText?.('<action>{"kind":"search","query":"cats"}</action>');
      } else {
        h.onText?.('<action>{"kind":"finish","summary":"x"}</action>');
      }
    });

    await runAgent(baseOpts(editor) as any);

    expect(calls[1]).toContain('cats are great'); // first search injected matches
    expect(calls[2]).toContain('Same 2 matches');
    expect(calls[2]).toContain('earlier search');
    expect(calls[2]).not.toContain('cats are great'); // de-duplicated
  });

  it('#3 a failed onRemember does NOT abort the run', async () => {
    const editor = await makeEditor(['Hello']);
    let rememberCalls = 0;
    let turn = 0;

    vi.mocked(streamChat).mockImplementation(async (_req: any, h: any) => {
      turn += 1;
      if (turn === 1) {
        h.onText?.(
          '<action>{"kind":"remember","note":"user likes concise prose"}</action>',
        );
      } else {
        h.onText?.('<action>{"kind":"finish","summary":"done"}</action>');
      }
    });

    const msg = await runAgent(
      baseOpts(editor, {
        memoryEnabled: true,
        onRemember: async () => {
          rememberCalls += 1;
          throw new Error('storage down');
        },
      }) as any,
    );

    expect(rememberCalls).toBe(1); // attempted, error isolated
    expect(msg.action?.kind).toBe('finish'); // run continued despite the failure
    expect(msg.error).toBeUndefined();
  });

  it('#4 a non-abort error mid-stream preserves the partial and attaches the error', async () => {
    const editor = await makeEditor(['Hello']);

    vi.mocked(streamChat).mockImplementation(async (_req: any, h: any) => {
      h.onText?.('Here is my answer so far. ');
      throw new Error('provider timeout');
    });

    const msg = await runAgent(baseOpts(editor) as any);

    expect(msg.text).toContain('Here is my answer so far');
    expect(msg.error).toBe('provider timeout');
  });

  it('#4 abort preserves the partial WITHOUT an error field', async () => {
    const editor = await makeEditor(['Hello']);
    const ac = new AbortController();

    vi.mocked(streamChat).mockImplementation(async (_req: any, h: any) => {
      h.onText?.('Partial answer');
      ac.abort();
      throw new DOMException('aborted', 'AbortError');
    });

    const msg = await runAgent(baseOpts(editor, {signal: ac.signal}) as any);

    expect(msg.text).toContain('Partial answer');
    expect(msg.error).toBeUndefined();
  });
});
