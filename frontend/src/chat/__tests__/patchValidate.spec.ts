import {describe, it, expect} from 'vitest';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  ParagraphNode,
  TextNode,
  createEditor,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';

import {textContains} from '../patch';
import {
  classifyPatch,
  MAX_PATCH_ATTEMPTS,
  patchFeedback,
  withPatchFailure,
} from '../patchValidate';
import type {ChatEdit, ChatMessage} from '../types';

function makeEditor(): LexicalEditor {
  return createEditor({
    nodes: [ParagraphNode, TextNode],
    onError(err) {
      throw err;
    },
  });
}

async function setDoc(editor: LexicalEditor, paras: string[]): Promise<void> {
  await editor.update(() => {
    const root = $getRoot();
    root.clear();
    paras.forEach(p => root.append($createParagraphNode().append($createTextNode(p))));
  });
}

const edit = (search: string, replace = 'x'): ChatEdit => ({search, replace});
const patchMsg = (edits: ChatEdit[]): ChatMessage => ({
  id: 'm1',
  role: 'assistant',
  text: 'prose',
  action: {kind: 'patch', explanation: 'lbl'},
  edits: edits.map(e => ({...e, state: 'pending' as const})),
});

describe('textContains (tolerant)', () => {
  it('matches verbatim and tolerates whitespace/quote differences', () => {
    expect(textContains('abc def', 'abc')).toBe(true);
    expect(textContains('abc def', 'xyz')).toBe(false);
    expect(textContains('abc  def', 'abc def')).toBe(true); // collapsed spaces
    expect(textContains('She said “hi”', 'She said "hi"')).toBe(true); // curly→straight
  });
});

describe('classifyPatch', () => {
  it('returns ok when every search is in the live doc', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Hello world.', 'Second para.']);
    expect(classifyPatch(editor, [edit('Hello world.'), edit('Second')], 'Hello world. Second para.')).toBe('ok');
  });

  it('returns mis-copy when a search is in neither live nor snapshot', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Hello world.']);
    // "Helo world" is a typo the model made — not in live, not in snapshot
    expect(classifyPatch(editor, [edit('Helo world')], 'Hello world.')).toBe('mis-copy');
  });

  it('returns stale when a search WAS in the snapshot but is gone from live', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Goodbye now.']); // the doc was edited since the AI saw it
    expect(classifyPatch(editor, [edit('Hello world.')], 'Hello world. Something.')).toBe('stale');
  });

  it('mixed ok + mis-copy → mis-copy (retry the whole patch)', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Hello world.']);
    expect(
      classifyPatch(editor, [edit('Hello'), edit('Helo')], 'Hello world.'),
    ).toBe('mis-copy');
  });

  it('stale wins over mis-copy (the doc changed → patch cannot complete)', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Changed.']);
    expect(
      classifyPatch(
        editor,
        [edit('Helo'), edit('Hello world.')], // mis-copy + stale
        'Hello world.',
      ),
    ).toBe('stale');
  });
});

describe('patchFeedback / withPatchFailure', () => {
  it('feedback names the failing passages and asks for a verbatim copy', () => {
    const f = patchFeedback([edit('Helo world'), edit('Second')]);
    expect(f).toContain('not found verbatim');
    expect(f).toContain('"Helo world"');
    expect(f).toContain('SHORTEST unique span');
  });

  it('withPatchFailure(ignored) drops the card and labels the failure', () => {
    const out = withPatchFailure(patchMsg([edit('a')]), 'ignored', 'snap');
    expect(out.patchFailure).toBe('ignored');
    expect(out.action).toBeNull();
    expect(out.edits).toBeUndefined();
    expect(out.snapshot).toBe('snap');
    expect(out.text).toBe('prose'); // original prose preserved (card carries the note)
  });

  it('withPatchFailure(stale) keeps prose and marks the failure', () => {
    const out = withPatchFailure(patchMsg([edit('a')]), 'stale', 'snap');
    expect(out.patchFailure).toBe('stale');
    expect(out.action).toBeNull();
    expect(out.edits).toBeUndefined();
  });
});
