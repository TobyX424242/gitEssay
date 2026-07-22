import {describe, expect, it} from 'vitest';
import {
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  ParagraphNode,
  TextNode,
  createEditor,
  type LexicalEditor,
} from 'lexical';

import {EquationNode} from '../../nodes/EquationNode';
import {applyAppendPatch, splitAppendSegments, validateAppendText} from '../patch';
import {APPEND_LATEX_NONCE, classifyPatch} from '../patchValidate';

function makeEditor(): LexicalEditor {
  return createEditor({
    nodes: [ParagraphNode, TextNode, EquationNode],
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

function docText(editor: LexicalEditor): string {
  let out = '';
  editor.getEditorState().read(() => {
    out = $getRoot()
      .getChildren()
      .map(b => b.getTextContent())
      .join('\n\n');
  });
  return out;
}

describe('validateAppendText', () => {
  it('accepts plain prose', () => {
    expect(validateAppendText('A brand-new conclusion.')).toEqual({ok: true});
  });

  it('rejects empty text', () => {
    expect('error' in validateAppendText('   ')).toBe(true);
  });

  it('rejects sentinel tokens (no inventing/cloning atomic nodes)', () => {
    expect('error' in validateAppendText('see [[CITE:ab12cd34]]')).toBe(true);
    expect('error' in validateAppendText('copy [[EQ:ab12cd34]]')).toBe(true);
  });
});

describe('applyAppendPatch', () => {
  it('appends a single paragraph at the end of the document', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['First.', 'Second.']);
    const res = await applyAppendPatch(editor, 'A brand-new conclusion.');
    expect('paragraphs' in res && res.paragraphs === 1).toBe(true);
    expect(docText(editor)).toBe('First.\n\nSecond.\n\nA brand-new conclusion.');
  });

  it('splits blank-line-separated content into multiple paragraphs', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Intro.']);
    const res = await applyAppendPatch(editor, 'New para one.\n\nNew para two.');
    expect('paragraphs' in res && res.paragraphs === 2).toBe(true);
    expect(docText(editor)).toBe('Intro.\n\nNew para one.\n\nNew para two.');
  });

  it('refuses sentinel-laden content without touching the document', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Intro.']);
    const res = await applyAppendPatch(editor, 'copied [[EQ:ab12cd34]] here');
    expect('kind' in res && res.kind === 'sentinel').toBe(true);
    expect(docText(editor)).toBe('Intro.');
  });
});

describe('classifyPatch — append edits', () => {
  it('ok for plain-prose appends', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Hello world.']);
    const cls = classifyPatch(editor, [], '', [], [{text: 'New ending.'}]);
    expect(cls.issue).toBe('ok');
  });

  it('ok for appends with parseable $$…$$ equations', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Hello world.']);
    const cls = classifyPatch(editor, [], '', [], [
      {text: 'Results follow.\n$$\n\\frac{a}{b}\n$$'} ,
    ]);
    expect(cls.issue).toBe('ok');
  });

  it('unparseable $$…$$ latex in an append → invalid-latex (retryable)', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Hello world.']);
    const cls = classifyPatch(editor, [], '', [], [
      {text: 'Results follow.\n$$\n\\frac{a}{\n$$'},
    ]);
    expect(cls.issue).toBe('invalid-latex');
    expect(cls.latexFailures).toHaveLength(1);
    expect(cls.latexFailures![0].nonce).toBe(APPEND_LATEX_NONCE);
  });

  it('sentinel in append content → invalid (structural)', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Hello world.']);
    const cls = classifyPatch(editor, [], '', [], [{text: 'x [[CITE:deadbeef]]'}]);
    expect(cls.issue).toBe('invalid');
    expect(cls.reason).toContain('must not contain');
  });

  it('empty append text → invalid', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Hello world.']);
    const cls = classifyPatch(editor, [], '', [], [{text: '  '}]);
    expect(cls.issue).toBe('invalid');
  });
});

describe('splitAppendSegments', () => {
  it('splits prose and $$…$$ equation blocks in order', () => {
    expect(
      splitAppendSegments('Intro text.\n$$\nE=mc^2\n$$\nOutro text.'),
    ).toEqual([
      {kind: 'text', text: 'Intro text.'},
      {kind: 'equation', latex: 'E=mc^2'},
      {kind: 'text', text: 'Outro text.'},
    ]);
  });

  it('treats an unterminated $$ fence as literal prose', () => {
    const segs = splitAppendSegments('Text.\n$$\nE=mc^2');
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({kind: 'text', text: 'Text.'});
    expect(segs[1].kind).toBe('text');
    expect(segs[1].kind === 'text' && segs[1].text).toContain('E=mc^2');
  });
});

describe('applyAppendPatch — with new equations', () => {
  it('appends prose as paragraphs and $$…$$ as display EquationNodes', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Intro.']);
    const res = await applyAppendPatch(
      editor,
      'Results follow.\n$$\n\\frac{a}{b}\n$$\nAs shown above.',
    );
    expect('paragraphs' in res && res.paragraphs === 3).toBe(true);
    const types: string[] = [];
    let eqLatex = '';
    editor.getEditorState().read(() => {
      for (const child of $getRoot().getChildren()) {
        types.push(child.getType());
        if (child instanceof EquationNode) {
          eqLatex = child.getEquation();
        }
      }
    });
    expect(types).toEqual(['paragraph', 'paragraph', 'equation', 'paragraph']);
    expect(eqLatex).toBe('\\frac{a}{b}');
  });

  it('refuses unparseable equation latex without touching the document', async () => {
    const editor = makeEditor();
    await setDoc(editor, ['Intro.']);
    const res = await applyAppendPatch(editor, 'Text.\n$$\n\\frac{a}{\n$$');
    expect('kind' in res && res.kind === 'invalid-latex').toBe(true);
    expect(docText(editor)).toBe('Intro.');
  });
});
