/**
 * gitEssay — T4 placeholder/sentinel tokenization for atomic academic nodes.
 *
 * Citations and equations are atomic (DecoratorNode): the cursor can't enter
 * them and a delete removes the whole node. When the document is flattened to
 * text for the LLM, these nodes MUST appear as OPAQUE, collision-resistant
 * sentinels — never as their guessable label (`[1]`, "Smith 2020") or raw
 * LaTeX — so the model treats them as indivisible units and copies them
 * verbatim into its SEARCH/REPLACE edits. `applyTextPatch` then round-trips
 * the sentinels back into real decorator nodes (PLAN §6 shared infra / §7, T4).
 *
 * Sentinel grammar (ASCII on purpose — survives every tokenizer; the doubled
 * brackets avoid colliding with prose citations like `[1]`):
 *
 *   [[CITE:ab12cd34]]   — a CitationNode (identity = citationId)
 *   [[EQ:ef567890]]     — an EquationNode (identity = inline + latex flag + equation text)
 *
 * The 8-hex nonce is a DETERMINISTIC djb2 hash of (kind, node identity), so it
 * can be RE-DERIVED from the live document at apply time — no per-turn map has
 * to be threaded through messages. Two nodes collide only on a real 32-bit
 * hash collision (astronomically rare for a single doc); `applyTextPatch`
 * detects an ambiguous multi-match and rejects rather than guessing.
 *
 * Pure helpers (djb2 / render / parse / nonce) have no Lexical dependency so
 * they unit-test cleanly; the node-walking helpers run inside a read/update.
 */
import {
  $getSelection,
  $isElementNode,
  $isNodeSelection,
  $isRangeSelection,
  $isTextNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from 'lexical';

import {$isCitationNode, type CitationNode} from '../nodes/CitationNode';
import {$isEquationNode, type EquationNode} from '../nodes/EquationNode';

const NONCE_LEN = 8;

/** Unsigned 32-bit djb2 → fixed-width lowercase hex (8 chars). */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return h.toString(16).padStart(NONCE_LEN, '0').slice(-NONCE_LEN);
}

/** Deterministic nonce for a citation, from its stable citationId (primitive). */
export function citationIdNonce(citationId: string): string {
  return djb2('C ' + citationId);
}

/** Deterministic nonce for an equation, from inline flag + latex flag + content. */
export function equationContentNonce(
  inline: boolean,
  equation: string,
  latex = true,
): string {
  return djb2(
    'E ' + (inline ? '1' : '0') + ' ' + (latex ? '1' : '0') + ' ' + equation,
  );
}

/** Deterministic nonce for a citation node (keyed on its stable citationId). */
export function citationNonce(node: CitationNode): string {
  return citationIdNonce(node.getCitationId());
}

/** Deterministic nonce for an equation node (inline + latex flag + content). */
export function equationNonce(node: EquationNode): string {
  return equationContentNonce(node.isInline(), node.getEquation(), node.isLatex());
}

export function citeSentinel(nonce: string): string {
  return `[[CITE:${nonce.toLowerCase()}]]`;
}

export function eqSentinel(nonce: string): string {
  return `[[EQ:${nonce.toLowerCase()}]]`;
}

/** Matches one sentinel token; capture 1 = CITE|EQ, capture 2 = 8 hex. */
export const SENTINEL_RE = /\[\[(CITE|EQ):([0-9a-fA-F]{8})\]\]/;

const SENTINEL_RE_G = /\[\[(CITE|EQ):([0-9a-fA-F]{8})\]\]/g;

export type SentinelKind = 'cite' | 'eq';

/** A parsed piece of model text: either prose, or a reference to an atomic node. */
export type Segment = {text: string} | {kind: SentinelKind; nonce: string};

/** Split text into prose segments + sentinel references (preserves order). */
export function parseSegments(s: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  SENTINEL_RE_G.lastIndex = 0;
  while ((m = SENTINEL_RE_G.exec(s)) !== null) {
    if (m.index > last) {
      out.push({text: s.slice(last, m.index)});
    }
    out.push({kind: m[1].toLowerCase() === 'cite' ? 'cite' : 'eq', nonce: m[2].toLowerCase()});
    last = m.index + m[0].length;
  }
  if (last < s.length) {
    out.push({text: s.slice(last)});
  }
  return out;
}

// --- node walking ----------------------------------------------------------
/**
 * One inline item in a block's flattened text: a text run, or an atomic
 * citation/equation node (carrying its data so it can be cloned losslessly).
 * The `node` back-reference lets `applyTextPatch` splice the live tree.
 */
export type InlineItem =
  | {kind: 'text'; text: string; node: TextNode}
  | {kind: 'cite'; nonce: string; node: CitationNode}
  | {kind: 'eq'; nonce: string; node: EquationNode};

/** Recurse a node's subtree in document order, collecting inline items. */
function collectInto(node: LexicalNode, out: InlineItem[]): void {
  if ($isTextNode(node)) {
    const t = node.getTextContent();
    if (t) {
      out.push({kind: 'text', text: t, node});
    }
    return;
  }
  if ($isCitationNode(node)) {
    out.push({kind: 'cite', nonce: citationNonce(node), node});
    return;
  }
  if ($isEquationNode(node)) {
    out.push({kind: 'eq', nonce: equationNonce(node), node});
    return;
  }
  if ($isElementNode(node)) {
    node.getChildren().forEach(c => collectInto(c, out));
  }
  // Other leaf nodes (inline images, etc.) contribute nothing to inline text.
}

/** Inline items for a top-level block, in document order. */
export function blockInlineItems(block: LexicalNode): InlineItem[] {
  const out: InlineItem[] = [];
  if ($isElementNode(block)) {
    block.getChildren().forEach(c => collectInto(c, out));
  } else {
    collectInto(block, out);
  }
  return out;
}

/** The sentinel-laden text for one block (what the LLM sees / locate matches). */
export function blockSentinelText(block: LexicalNode): string {
  return itemsToText(blockInlineItems(block));
}

/** Compose inline items into their sentinel-laden flat string. */
export function itemsToText(items: InlineItem[]): string {
  let out = '';
  for (const it of items) {
    if (it.kind === 'text') {
      out += it.text;
    } else if (it.kind === 'cite') {
      out += citeSentinel(it.nonce);
    } else {
      out += eqSentinel(it.nonce);
    }
  }
  return out;
}

/**
 * The current non-collapsed selection as sentinel-laden text (selection mode's
 * edit target). Returns null when there is nothing referenceable. Boundary text
 * nodes are clamped to the anchor/focus offsets; atomic nodes fully inside the
 * selection become sentinels — consistent with `blockSentinelText`, so a patch
 * the model writes against this text locates correctly in the live document.
 *
 * A NODE selection of equation(s) (e.g. the user clicked an equation block) is
 * also referenceable: it becomes just the equation token(s), so clicking a
 * formula and asking the AI about it targets exactly that equation.
 */
export function selectionToSentinelText(editor: LexicalEditor): string | null {
  let out: string | null = null;
  editor.getEditorState().read(() => {
    const sel = $getSelection();
    if ($isNodeSelection(sel)) {
      const tokens = sel
        .getNodes()
        .filter($isEquationNode)
        .map(n => eqSentinel(equationNonce(n)));
      out = tokens.length > 0 ? tokens.join(' ') : null;
      return;
    }
    if (!$isRangeSelection(sel) || sel.isCollapsed()) {
      return;
    }
    const nodes = sel.getNodes();
    if (nodes.length === 0) {
      return;
    }
    const backward = sel.isBackward();
    const startKey = (backward ? sel.focus : sel.anchor).key;
    const startOff = (backward ? sel.focus : sel.anchor).offset;
    const endKey = (backward ? sel.anchor : sel.focus).key;
    const endOff = (backward ? sel.anchor : sel.focus).offset;

    const parts: string[] = [];
    for (const node of nodes) {
      if ($isTextNode(node)) {
        let s = node.getTextContent();
        if (node.getKey() === startKey) {
          s = s.slice(startOff);
        }
        if (node.getKey() === endKey) {
          s = s.slice(0, s.length - (node.getTextContent().length - endOff));
        }
        if (s) {
          parts.push(s);
        }
        continue;
      }
      if ($isCitationNode(node)) {
        parts.push(citeSentinel(citationNonce(node)));
        continue;
      }
      if ($isEquationNode(node)) {
        parts.push(eqSentinel(equationNonce(node)));
        continue;
      }
      if ($isElementNode(node)) {
        // A block element fully inside the selection: include its sentinel text.
        parts.push(blockSentinelText(node));
      }
    }
    out = parts.join('');
  });
  return out;
}

// Re-export the element type for callers that build block lists.
export type {ElementNode};
