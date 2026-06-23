/**
 * gitEssay — segment a SerializedEditorState into DiffBlocks.
 *
 * Each paragraph / heading / quote / list-item → a 'text' block (word runs +
 * block attrs). A table → a 'table' block with cells[row][col] = runs (so each
 * cell diffs independently). Image / equation / code / hr / page-break →
 * labeled blocks. Operates on plain JSON (no DOM).
 */
import type {SerializedEditorState} from 'lexical';

import type {DiffBlock, TextRun} from './types';

interface SerNode {
  type: string;
  text?: string;
  format?: number | string; // TextNode: bitmask; ElementNode: align string
  style?: string;
  url?: string;
  equation?: string;
  inline?: boolean;
  language?: string;
  src?: string;
  altText?: string;
  tag?: string;
  direction?: 'ltr' | 'rtl' | null;
  indent?: number;
  label?: string;
  children?: SerNode[];
}

function collectRuns(node: SerNode | undefined, linkUrl: string | null, runs: TextRun[]): void {
  if (!node) {
    return;
  }
  if (node.type === 'text') {
    runs.push({
      text: node.text ?? '',
      format: typeof node.format === 'number' ? node.format : 0,
      style: node.style ?? '',
      link: linkUrl,
    });
    return;
  }
  if (node.type === 'link' || node.type === 'autolink') {
    (node.children ?? []).forEach(c => collectRuns(c, node.url ?? linkUrl, runs));
    return;
  }
  if (node.type === 'equation') {
    const eq = String(node.equation ?? '').replace(/\s+/g, ' ').trim();
    runs.push({text: ` ⟨EQ: ${eq.slice(0, 16)}⟩ `, format: 0, style: '', link: null});
    return;
  }
  if (node.type === 'image') {
    runs.push({text: ' ⟨IMG⟩ ', format: 0, style: '', link: null});
    return;
  }
  if (node.type === 'citation') {
    runs.push({text: node.label ?? '', format: 0, style: '', link: null});
    return;
  }
  if (Array.isArray(node.children)) {
    node.children.forEach(c => collectRuns(c, linkUrl, runs));
  }
}

function textBlock(node: SerNode): DiffBlock {
  const runs: TextRun[] = [];
  collectRuns(node, null, runs);
  return {
    kind: 'text',
    type: node.type,
    tag: node.tag,
    align: typeof node.format === 'string' ? node.format : '',
    direction: node.direction ?? '',
    indent: node.indent ?? 0,
    runs,
  };
}

function tableBlock(node: SerNode): DiffBlock {
  const rows = (node.children ?? []).filter(r => r.type === 'tablerow');
  const cells = rows.map(row =>
    (row.children ?? [])
      .filter(c => c.type === 'tablecell')
      .map(cell => {
        const runs: TextRun[] = [];
        collectRuns(cell, null, runs);
        return runs;
      }),
  );
  return {kind: 'table', type: 'table', cells};
}

function shortenUrl(src?: string): string {
  if (!src) {
    return '(image)';
  }
  const i = src.lastIndexOf('/');
  const tail = i >= 0 ? src.slice(i + 1) : src;
  return tail.length > 24 ? tail.slice(0, 24) + '…' : tail;
}

const LIST_TYPES = new Set(['list', 'number', 'bullet', 'checklist']);

function emitBlocks(node: SerNode, out: DiffBlock[]): void {
  if (!node) {
    return;
  }
  switch (node.type) {
    case 'root':
      (node.children ?? []).forEach(c => emitBlocks(c, out));
      return;
    case 'paragraph':
    case 'heading':
    case 'quote':
      out.push(textBlock(node));
      return;
    case 'listitem':
      out.push(textBlock(node));
      // nested lists inside the item
      (node.children ?? []).forEach(c => {
        if (LIST_TYPES.has(c.type)) {
          emitBlocks(c, out);
        }
      });
      return;
    case 'list':
    case 'number':
    case 'bullet':
    case 'checklist':
      (node.children ?? []).forEach(c => emitBlocks(c, out));
      return;
    case 'table':
      out.push(tableBlock(node));
      return;
    case 'image':
      out.push({
        kind: 'image',
        type: 'image',
        label: `IMG ${node.altText ? node.altText : shortenUrl(node.src)}`,
      });
      return;
    case 'equation':
      out.push({kind: 'equation', type: 'equation', label: eqLabel(node), inline: !!node.inline});
      return;
    case 'horizontalrule':
      out.push({kind: 'hr', type: 'horizontalrule', label: 'Horizontal rule'});
      return;
    case 'page-break':
      out.push({kind: 'pagebreak', type: 'page-break', label: 'Page break'});
      return;
    case 'code':
      out.push({
        kind: 'code',
        type: 'code',
        label: `Code${node.language ? ` (${node.language})` : ''}`,
      });
      return;
    default:
      if (Array.isArray(node.children)) {
        const runs: TextRun[] = [];
        collectRuns(node, null, runs);
        if (runs.some(r => r.text !== '')) {
          out.push({kind: 'text', type: node.type, align: '', direction: '', indent: 0, runs});
        }
      }
  }
}

function eqLabel(n: SerNode): string {
  const eq = String(n.equation ?? '').replace(/\s+/g, ' ').trim();
  return `EQ ${eq.length > 24 ? eq.slice(0, 24) + '…' : eq}`;
}

export function tokenizeBlocks(
  state: SerializedEditorState | null | undefined,
): DiffBlock[] {
  const out: DiffBlock[] = [];
  if (state && state.root) {
    emitBlocks(state.root as SerNode, out);
  }
  return out;
}
