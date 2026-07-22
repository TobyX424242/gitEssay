import {describe, expect, it} from 'vitest';
import {
  $createNodeSelection,
  $createParagraphNode,
  $createTextNode,
  $getRoot,
  $setSelection,
  ParagraphNode,
  TextNode,
  createEditor,
  type ElementNode,
  type LexicalEditor,
} from 'lexical';

import {$createEquationNode, EquationNode} from '../../nodes/EquationNode';
import {docEquations} from '../agentClient';
import {
  applyEquationPatch,
  findEquationsByNonce,
  validateLatex,
} from '../patch';
import {
  blockInlineItems,
  equationContentNonce,
  eqSentinel,
  selectionToSentinelText,
} from '../sentinels';

function makeEditor(): LexicalEditor {
  return createEditor({
    nodes: [ParagraphNode, TextNode, EquationNode],
    onError(err) {
      throw err;
    },
  });
}

async function setDoc(editor: LexicalEditor, build: (root: ElementNode) => void): Promise<void> {
  await editor.update(() => {
    const root = $getRoot();
    root.clear();
    build(root as ElementNode);
  });
}

/** All equations in the doc: {equation, inline, latex}. */
function equations(editor: LexicalEditor): {equation: string; inline: boolean; latex: boolean}[] {
  const out: {equation: string; inline: boolean; latex: boolean}[] = [];
  editor.getEditorState().read(() => {
    for (const b of $getRoot().getChildren()) {
      for (const it of blockInlineItems(b)) {
        if (it.kind === 'eq') {
          out.push({
            equation: it.node.getEquation(),
            inline: it.node.isInline(),
            latex: it.node.isLatex(),
          });
        }
      }
    }
  });
  return out;
}

describe('validateLatex', () => {
  it('accepts parseable LaTeX', () => {
    expect(validateLatex('E=mc^2')).toEqual({ok: true});
    expect(validateLatex('\\frac{a}{b}')).toEqual({ok: true});
    expect(validateLatex('\\sum_{i=1}^{n} x_i')).toEqual({ok: true});
  });

  it('rejects unparseable LaTeX with the KaTeX error', () => {
    const r = validateLatex('\\frac{a}{');
    expect('error' in r && r.ok === false).toBe(true);
    if ('error' in r) {
      expect(r.error.length).toBeGreaterThan(0);
    }
  });

  it('rejects empty source', () => {
    expect('error' in validateLatex('   ')).toBe(true);
  });

  it('rejects forged sentinel tokens inside the LaTeX', () => {
    expect('error' in validateLatex('x + [[EQ:ab12cd34]]')).toBe(true);
    expect('error' in validateLatex('[[CITE:ab12cd34]]')).toBe(true);
  });
});

describe('docEquations / findEquationsByNonce', () => {
  it('lists only LaTeX equations with nonce + raw source', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append(
        $createParagraphNode().append(
          $createTextNode('inline '),
          $createEquationNode('E=mc^2', true, true),
          $createTextNode(' plain '),
          $createEquationNode('E = mc^2 (text)', true, false),
        ),
      );
      root.append($createEquationNode('\\frac{a}{b}', false, true));
    });
    const eqs = docEquations(editor);
    expect(eqs).toHaveLength(2);
    expect(eqs[0]).toEqual({
      nonce: equationContentNonce(true, 'E=mc^2', true),
      inline: true,
      latex: 'E=mc^2',
    });
    expect(eqs[1].inline).toBe(false);
    expect(eqs[1].latex).toBe('\\frac{a}{b}');
    expect(eqs[1].nonce).toBe(equationContentNonce(false, '\\frac{a}{b}', true));
  });

  it('findEquationsByNonce matches a live LaTeX equation and ignores non-LaTeX ones', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append(
        $createParagraphNode().append(
          $createEquationNode('x^2', true, true),
          $createEquationNode('x^2', true, false), // same text, non-LaTeX
        ),
      );
    });
    const latexMatches = findEquationsByNonce(editor, '');
    expect(latexMatches).toHaveLength(0);
    const eqs = docEquations(editor);
    expect(eqs).toHaveLength(1); // only the LaTeX one is addressable
    const found = findEquationsByNonce(editor, eqs[0].nonce);
    expect(found).toHaveLength(1);
    expect(found[0].equation).toBe('x^2');
  });
});

describe('applyEquationPatch', () => {
  it('replaces the LaTeX source and returns prevLatex', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createEquationNode('E=mc^2', true, true)));
    });
    const nonce = docEquations(editor)[0].nonce;
    const res = await applyEquationPatch(editor, nonce, 'E=mc^{2} + 1');
    expect('prevLatex' in res && res.prevLatex === 'E=mc^2').toBe(true);
    expect(equations(editor)).toEqual([{equation: 'E=mc^{2} + 1', inline: true, latex: true}]);
    // The nonce is content-derived, so it changes with the edit.
    expect(docEquations(editor)[0].nonce).not.toBe(nonce);
  });

  it('refuses an unknown nonce without touching the document', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createEquationNode('x', true, true)));
    });
    const res = await applyEquationPatch(editor, 'deadbeef', 'y');
    expect('kind' in res && res.kind === 'not-found').toBe(true);
    expect(equations(editor)[0].equation).toBe('x');
  });

  it('refuses unparseable LaTeX without touching the document', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createEquationNode('x', true, true)));
    });
    const nonce = docEquations(editor)[0].nonce;
    const res = await applyEquationPatch(editor, nonce, '\\frac{a}{');
    expect('kind' in res && res.kind === 'invalid-latex').toBe(true);
    expect(equations(editor)[0].equation).toBe('x');
  });

  it('refuses an ambiguous nonce (two identical equations)', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createEquationNode('x', true, true)));
      root.append($createParagraphNode().append($createEquationNode('x', true, true)));
    });
    const nonce = docEquations(editor)[0].nonce;
    const res = await applyEquationPatch(editor, nonce, 'y');
    expect('kind' in res && res.kind === 'ambiguous').toBe(true);
    expect(equations(editor).map(e => e.equation)).toEqual(['x', 'x']);
  });

  it('works on block (display) equations too', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createEquationNode('\\frac{a}{b}', false, true));
    });
    const nonce = docEquations(editor)[0].nonce;
    const res = await applyEquationPatch(editor, nonce, '\\frac{c}{d}');
    expect('prevLatex' in res && res.prevLatex === '\\frac{a}{b}').toBe(true);
    expect(equations(editor)).toEqual([{equation: '\\frac{c}{d}', inline: false, latex: true}]);
  });
});


describe('selectionToSentinelText — clicked equation references the AI', () => {
  it('a node selection of an equation becomes its [[EQ:nonce]] token', async () => {
    const editor = makeEditor();
    let key = '';
    await setDoc(editor, root => {
      const eq = $createEquationNode('E=mc^2', true, true);
      key = eq.getKey();
      root.append(
        $createParagraphNode().append($createTextNode('Energy is '), eq),
      );
    });
    await editor.update(() => {
      const sel = $createNodeSelection();
      sel.add(key);
      $setSelection(sel);
    });
    expect(selectionToSentinelText(editor)).toBe(
      eqSentinel(equationContentNonce(true, 'E=mc^2', true)),
    );
  });

  it('a node selection without equations is not referenceable', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createTextNode('plain')));
    });
    await editor.update(() => {
      $setSelection($createNodeSelection());
    });
    expect(selectionToSentinelText(editor)).toBeNull();
  });
});
