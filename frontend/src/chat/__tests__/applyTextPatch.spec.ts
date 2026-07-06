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

import {$createCitationNode, CitationNode} from '../../nodes/CitationNode';
import {EquationNode, $createEquationNode} from '../../nodes/EquationNode';
import {applyTextPatch} from '../patch';
import {
  blockInlineItems,
  citeSentinel,
  citationIdNonce,
  equationContentNonce,
  eqSentinel,
  itemsToText,
} from '../sentinels';

function makeEditor(): LexicalEditor {
  return createEditor({
    nodes: [ParagraphNode, TextNode, CitationNode, EquationNode],
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

/** Flattened sentinel text of the whole doc (citations/equations → tokens). */
function docText(editor: LexicalEditor): string {
  let out = '';
  editor.getEditorState().read(() => {
    out = $getRoot()
      .getChildren()
      .map(b => itemsToText(blockInlineItems(b)))
      .join('\n\n');
  });
  return out;
}

function citations(editor: LexicalEditor): {id: string; label: string}[] {
  const out: {id: string; label: string}[] = [];
  editor.getEditorState().read(() => {
    $getRoot()
      .getChildren()
      .forEach(b => {
        blockInlineItems(b).forEach(it => {
          if (it.kind === 'cite') {
            out.push({id: it.node.getCitationId(), label: it.node.getLabel()});
          }
        });
      });
  });
  return out;
}

describe('applyTextPatch — whitespace tolerance (text path)', () => {
  it('matches when the model ADDED internal spaces', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createTextNode('Hello world.')));
    });
    const res = await applyTextPatch(editor, 'Hello   world', 'Hi world');
    expect(res.ok).toBe(true);
    expect(docText(editor)).toBe('Hi world.');
  });

  it('matches when the doc has extra spaces the model collapsed', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createTextNode('the quick  brown fox')));
    });
    // The normalized match maps back to the ORIGINAL region "quick  brown"
    // (double space included), which is then replaced wholesale by "slow brown".
    const res = await applyTextPatch(editor, 'quick brown', 'slow brown');
    expect(res.ok).toBe(true);
    expect(docText(editor)).toBe('the slow brown fox');
  });

  it('still matches verbatim first (unchanged behaviour)', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createTextNode('Hello world.')));
    });
    const res = await applyTextPatch(editor, 'Hello', 'Hi');
    expect(res.ok).toBe(true);
    expect(docText(editor)).toBe('Hi world.');
  });
});

describe('applyTextPatch — punctuation & quote tolerance (locate tiers 3–5)', () => {
  it('matches when the model swapped curly quotes for straight ones', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createTextNode('She said "hello" and left.')));
    });
    // needle uses curly quotes; doc has straight
    const res = await applyTextPatch(editor, 'She said “hello”', 'She whispered "hello"');
    expect(res.ok).toBe(true);
    expect(docText(editor)).toBe('She whispered "hello" and left.');
  });

  it('matches when the model turned an em-dash into a hyphen', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createTextNode('It was clear—very clear.')));
    });
    const res = await applyTextPatch(editor, 'clear-very clear', 'clear, very clear');
    expect(res.ok).toBe(true);
    expect(docText(editor)).toBe('It was clear, very clear.');
  });

  it('strips a balanced wrapping quote pair the model added', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createTextNode('The quick brown fox.')));
    });
    // model wrapped the passage in quotes that are not in the document
    const res = await applyTextPatch(editor, '"quick brown fox"', 'slow brown dog');
    expect(res.ok).toBe(true);
    expect(docText(editor)).toBe('The slow brown dog.');
  });

  it('matches through a soft hyphen hiding in the document word', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createTextNode('They col­laborated well.')));
    });
    const res = await applyTextPatch(editor, 'collaborated well', 'worked together well');
    expect(res.ok).toBe(true);
    expect(docText(editor)).toBe('They worked together well.');
  });

  it('still rejects a genuinely absent passage', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createTextNode('Only this text exists.')));
    });
    const res = await applyTextPatch(editor, 'a completely different passage', 'x');
    expect(res.ok).toBe(false);
    expect(docText(editor)).toBe('Only this text exists.'); // unchanged
  });
});

describe('applyTextPatch — sentinel-aware citation handling', () => {
  const nonce = citationIdNonce('c1');
  const cite = citeSentinel(nonce);

  async function docWithCite(editor: LexicalEditor): Promise<void> {
    await setDoc(editor, root => {
      root.append(
        $createParagraphNode()
          .append($createTextNode('Some claim '))
          .append($createCitationNode('Smith 2020', 'c1'))
          .append($createTextNode(' is strong.')),
      );
    });
  }

  it('preserves a citation kept verbatim across a rewrite', async () => {
    const editor = makeEditor();
    await docWithCite(editor);
    const search = `Some claim ${cite} is strong.`;
    const replace = `A stronger claim ${cite} follows.`;
    const res = await applyTextPatch(editor, search, replace);
    expect(res.ok).toBe(true);
    // Exactly one citation, same identity + label (not cloned, not corrupted).
    expect(citations(editor)).toEqual([{id: 'c1', label: 'Smith 2020'}]);
    expect(docText(editor)).toBe(`A stronger claim ${cite} follows.`);
  });

  it('removes a citation the model dropped (authorized delete)', async () => {
    const editor = makeEditor();
    await docWithCite(editor);
    const search = `claim ${cite} is`;
    const replace = 'claim is';
    const res = await applyTextPatch(editor, search, replace);
    expect(res.ok).toBe(true);
    expect(citations(editor)).toEqual([]);
    expect(docText(editor)).toBe('Some claim is strong.');
  });

  it('locates a passage that spans a citation (was UNLOCATABLE before T4)', async () => {
    const editor = makeEditor();
    await docWithCite(editor);
    // search crosses the citation boundary — pre-T4 collectTextNodes skipped
    // the decorator, so this could never match.
    const search = `claim ${cite} is strong`;
    const replace = `claim ${cite} was strong`;
    const res = await applyTextPatch(editor, search, replace);
    expect(res.ok).toBe(true);
    expect(citations(editor)).toEqual([{id: 'c1', label: 'Smith 2020'}]);
    expect(docText(editor)).toBe(`Some claim ${cite} was strong.`);
  });
});

describe('applyTextPatch — validating reconciliation (T4)', () => {
  it('rejects a replace that invents a citation not in the search', async () => {
    const editor = makeEditor();
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createTextNode('Hello world.')));
    });
    const foreign = citeSentinel(citationIdNonce('made-up'));
    const res = await applyTextPatch(editor, 'Hello', `Hi ${foreign} world`);
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/citation/);
    expect(docText(editor)).toBe('Hello world.'); // unchanged
  });

  it('rejects smuggling in a citation that lives elsewhere in the doc', async () => {
    const editor = makeEditor();
    const other = citeSentinel(citationIdNonce('c2'));
    await setDoc(editor, root => {
      root.append($createParagraphNode().append($createTextNode('Edit me here.')));
      root.append(
        $createParagraphNode()
          .append($createTextNode('Other '))
          .append($createCitationNode('Jones 2021', 'c2')),
      );
    });
    // search/replace targets the FIRST paragraph (no citation), but replace
    // references the citation from the SECOND — must be rejected (no cloning).
    const res = await applyTextPatch(editor, 'Edit me', `Edited ${other} me`);
    expect(res.ok).toBe(false);
    expect(docText(editor)).toBe(`Edit me here.\n\nOther ${other}`);
  });

  it('rejects a replace that duplicates a citation (sentinel twice)', async () => {
    const editor = makeEditor();
    const nonce = citationIdNonce('c1');
    const cite = citeSentinel(nonce);
    await setDoc(editor, root => {
      root.append(
        $createParagraphNode()
          .append($createTextNode('x '))
          .append($createCitationNode('Smith 2020', 'c1'))
          .append($createTextNode(' y')),
      );
    });
    const res = await applyTextPatch(
      editor,
      `x ${cite} y`,
      `x ${cite} ${cite} y`,
    );
    expect(res.ok).toBe(false);
    expect(citations(editor)).toHaveLength(1); // unchanged
  });

  it('preserves an inline equation kept verbatim', async () => {
    const editor = makeEditor();
    const eq = equationContentNonce(true, 'E=mc^2');
    const token = eqSentinel(eq);
    await setDoc(editor, root => {
      root.append(
        $createParagraphNode()
          .append($createTextNode('Energy is '))
          .append($createEquationNode('E=mc^2', true))
          .append($createTextNode(' here.')),
      );
    });
    const res = await applyTextPatch(
      editor,
      `Energy is ${token} here.`,
      `Mass-energy: ${token} shown.`,
    );
    expect(res.ok).toBe(true);
    expect(docText(editor)).toBe(`Mass-energy: ${token} shown.`);
  });
});
