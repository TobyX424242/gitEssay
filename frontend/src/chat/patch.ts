/**
 * gitEssay — coding-agent-style patch parsing + application.
 *
 * Two output protocols coexist:
 *
 *  (A) SEARCH/REPLACE blocks (legacy, Aider/Cline convention):
 *        <<<<<<< SEARCH
 *        <verbatim passage from the document, within a single block>
 *        =======
 *        <replacement text>
 *        >>>>>>> REPLACE
 *      parsePatches() splits legacy output into prose + edits.
 *
 *  (B) The streaming agent's <thinking>/<action> protocol (current):
 *        <thinking>…step-by-step reasoning…</thinking>
 *        <action>{ "kind": "patch|ask|finish|read|search", … }</action>
 *      parseTurn() splits a finished turn into {thinking, prose, action};
 *      extractPartialAction() / stripMarkup() / extractThinking() power the
 *      LIVE streaming view (partial-aware, so raw markup never shows in prose).
 *
 * applyTextPatch locates the SEARCH text verbatim within a single top-level
 * block and splices the replacement into the covering TextNodes (the replacement
 * inherits the first node's formatting). A SEARCH is constrained to one block so
 * locating it is unambiguous; multi-block changes use multiple blocks.
 */
import {
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isTextNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from 'lexical';

import type {DiffBlock, TextRun} from '../diff/types';
import {$createCitationNode} from '../nodes/CitationNode';
import {$createEquationNode} from '../nodes/EquationNode';
import type {AssistantAction, ChatEdit} from './types';
import {
  blockInlineItems,
  citeSentinel,
  eqSentinel,
  itemsToText,
  type InlineItem,
  parseSegments,
  type Segment,
  type SentinelKind,
} from './sentinels';

const SEARCH_START = /<{4,}\s*SEARCH\b/;
const DIVIDER = /^={4,}\s*$/;
const REPLACE_END = /^>{4,}\s*(REPLACE|ENDED)\b/;

// --- agent protocol markup -------------------------------------------------
// Partial-aware: an unclosed block matches to end-of-string ($), so a streaming
// <thinking>… or <action>… tail is stripped from the live prose view before the
// closing tag arrives.
const THINKING_RE = /<thinking>([\s\S]*?)(<\/thinking>|$)/i;
const ACTION_RE = /<action>([\s\S]*?)<\/action>/i; // CLOSED only — partial stays hidden
const ACTION_RE_PARTIAL = /<action>([\s\S]*)$/i; // open tail (for stripping)
// GLOBAL variants for stripMarkup. The regexes above are first-match (non-global)
// because extractThinking/actionJson PARSE the single intended block via .exec —
// a module-level regex with the `g` flag would carry stateful lastIndex between
// calls and is wrong there. But stripMarkup must remove EVERY block: a model
// occasionally emits a second <thinking>/<action> block, and a non-global replace
// would strip only the first and leave the second as literal text in the prose.
const THINKING_RE_ALL = /<thinking>[\s\S]*?(<\/thinking>|$)/gi;
const ACTION_RE_ALL = /<action>[\s\S]*?<\/action>/gi;

/**
 * Parse model output into {prose, edits}. Tolerant of surrounding code fences.
 * Text outside SEARCH/REPLACE blocks is treated as the assistant's prose.
 */
export function parsePatches(raw: string): {prose: string; edits: ChatEdit[]} {
  const edits: ChatEdit[] = [];
  const proseParts: string[] = [];

  // Strip a single wrapping code fence if present.
  const text = raw.replace(/^```[a-zA-Z0-9]*\s*\n/, '').replace(/\n```\s*$/, '');

  const lines = text.split('\n');
  let i = 0;
  let proseStart = 0;
  while (i < lines.length) {
    if (SEARCH_START.test(lines[i])) {
      // flush prose before this block
      if (i > proseStart) {
        proseParts.push(lines.slice(proseStart, i).join('\n'));
      }
      i++;
      const searchLines: string[] = [];
      while (i < lines.length && !DIVIDER.test(lines[i])) {
        searchLines.push(lines[i]);
        i++;
      }
      // skip the divider line
      if (i < lines.length && DIVIDER.test(lines[i])) {
        i++;
      }
      const replaceLines: string[] = [];
      while (i < lines.length && !REPLACE_END.test(lines[i])) {
        replaceLines.push(lines[i]);
        i++;
      }
      // skip the end line
      if (i < lines.length && REPLACE_END.test(lines[i])) {
        i++;
      }
      const search = searchLines.join('\n').trim();
      const replace = replaceLines.join('\n').trim();
      if (search) {
        edits.push({search, replace});
      }
      proseStart = i;
    } else {
      i++;
    }
  }
  if (i > proseStart) {
    proseParts.push(lines.slice(proseStart).join('\n'));
  }

  const prose = proseParts.join('\n').trim();
  return {prose, edits};
}

// --- streaming agent protocol ---------------------------------------------
/** Tagged <thinking> content (complete OR partial-to-end) — for the live pane. */
export function extractThinking(raw: string): string {
  const m = THINKING_RE.exec(raw);
  return m ? m[1].trim() : '';
}

/**
 * Strip <thinking> and <action> markup so it never leaks into the prose bubble.
 * Complete blocks are removed; an unclosed <thinking>/<action> tail is removed
 * too (so streaming JSON / half-finished reasoning isn't shown as prose).
 */
export function stripMarkup(raw: string): string {
  let out = raw.replace(THINKING_RE_ALL, '');
  out = out.replace(ACTION_RE_ALL, '');
  out = out.replace(ACTION_RE_PARTIAL, '');
  return out.trim();
}

function asEdits(value: unknown): ChatEdit[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(e => (e && typeof e === 'object' ? e : null))
    .filter((e): e is Record<string, unknown> => !!e)
    .map(e => ({
      search: typeof e.search === 'string' ? e.search : '',
      replace: typeof e.replace === 'string' ? e.replace : '',
    }))
    .filter(e => e.search.trim().length > 0);
}

function asStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map(v => (typeof v === 'string' ? v : String(v ?? ''))).filter(s => s.length > 0)
    : [];
}

/** The cleaned JSON body of a CLOSED <action>…</action> block, or null. */
function actionJson(raw: string): string | null {
  const m = ACTION_RE.exec(raw);
  if (!m) {
    return null;
  }
  return m[1]
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Parse a closed <action>{json}</action> body into an AssistantAction, or null. */
function parseAction(jsonBody: string): AssistantAction | null {
  const obj = parseJsonObject(jsonBody);
  if (!obj) {
    return null;
  }
  switch (obj.kind) {
    case 'patch':
      // Edits live on ChatMessage.edits (with per-edit state); the action only
      // carries the commit-style explanation. runAgent pulls edits via actionEdits().
      return {
        kind: 'patch',
        explanation:
          typeof obj.explanation === 'string' && obj.explanation.trim()
            ? obj.explanation.trim()
            : 'AI edit',
      };
    case 'ask':
      return {
        kind: 'ask',
        question: typeof obj.question === 'string' ? obj.question.trim() : '',
        options: asStrings(obj.options),
      };
    case 'finish':
      return {
        kind: 'finish',
        summary: typeof obj.summary === 'string' ? obj.summary.trim() : undefined,
      };
    default:
      return null;
  }
}

/** Edits declared inside a patch action body (used to populate message.edits). */
export function actionEdits(raw: string): ChatEdit[] {
  const body = actionJson(raw);
  if (!body) {
    return [];
  }
  const obj = parseJsonObject(body);
  return obj ? asEdits(obj.edits) : [];
}

/** A read/search tool action (non-terminal — drives the loop). */
export interface ToolAction {
  kind: 'read' | 'search';
  query?: string;
}

export function extractToolAction(raw: string): ToolAction | null {
  const body = actionJson(raw);
  const obj = body ? parseJsonObject(body) : null;
  if (!obj) {
    return null;
  }
  if (obj.kind === 'read') {
    return {kind: 'read', query: typeof obj.query === 'string' ? obj.query : undefined};
  }
  if (obj.kind === 'search') {
    return {kind: 'search', query: typeof obj.query === 'string' ? obj.query : ''};
  }
  return null;
}

/** A `remember` action (non-terminal — saves a long-term memory note, then continues). */
export function extractRememberAction(raw: string): {note: string} | null {
  const body = actionJson(raw);
  const obj = body ? parseJsonObject(body) : null;
  if (!obj || obj.kind !== 'remember') {
    return null;
  }
  const note = typeof obj.note === 'string' ? obj.note.trim() : '';
  return note ? {note} : null;
}

/** A terminal action ONLY once its </action> closing tag has arrived. */
export function extractPartialAction(raw: string): AssistantAction | null {
  const body = actionJson(raw);
  return body ? parseAction(body) : null;
}

/** Split a finished turn. `action` is null for a pure-advice (prose) reply. */
export function parseTurn(raw: string): {
  thinking: string;
  prose: string;
  action: AssistantAction | null;
} {
  return {
    thinking: extractThinking(raw),
    prose: stripMarkup(raw),
    action: extractPartialAction(raw),
  };
}

/** Plain text → paragraph DiffBlocks (the "new" side of an edit-card diff).
 *  Sentinel tokens ([[CITE:..]] / [[EQ:..]]) become their own kind-marked runs
 *  so the diff preview can render them as atomic chips instead of raw text. */
export function plainTextToBlocks(text: string): DiffBlock[] {
  return text
    .split(/\n\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => ({
      kind: 'text' as const,
      type: 'paragraph',
      align: '',
      direction: '',
      indent: 0,
      runs: segmentRuns(s),
    }));
}

function segmentRuns(paragraph: string): TextRun[] {
  const runs: TextRun[] = [];
  for (const seg of parseSegments(paragraph)) {
    if ('text' in seg) {
      if (seg.text) {
        runs.push({text: seg.text, format: 0, style: '', link: null});
      }
    } else {
      runs.push({
        text: seg.kind === 'cite' ? 'cite' : 'eq',
        format: 0,
        style: '',
        link: null,
        kind: seg.kind === 'cite' ? 'citation' : 'equation',
      });
    }
  }
  return runs;
}

function collectTextNodes(node: LexicalNode, out: TextNode[]): void {
  if ($isTextNode(node)) {
    out.push(node);
    return;
  }
  if ($isElementNode(node)) {
    node.getChildren().forEach(c => collectTextNodes(c, out));
  }
}

/**
 * Locate `needle` in `haystack`. Returns ORIGINAL-index ranges (never a
 * normalized-space index), so callers can splice the real text safely. Five
 * tiers, weakest-signal-last, each more tolerant of how the model transcribed
 * the passage:
 *   (1) verbatim;
 *   (2) trimmed (leading/trailing whitespace the model added);
 *   (3) a balanced wrapping quote pair stripped ("…", '…', "…", '…');
 *   (4) internal-whitespace-normalized — collapse every whitespace run to a
 *       single space in both, then map the match back to original offsets
 *       (covers reflowed line breaks, collapsed/expanded spaces);
 *   (5) punctuation-insensitive — also map curly↔straight quotes, dash
 *       variants→'-', ellipsis→'.', and drop zero-width/soft-hyphen marks.
 *       This is the tier that catches "the model swapped smart quotes for
 *       straight ones, or turned an em-dash into a hyphen" — the most common
 *       reason an otherwise-exact copy still fails to match.
 * Sentinel tokens are fixed-width, contain no whitespace or punctuation, and
 * survive every tier intact.
 */
function locate(
  haystack: string,
  needle: string,
): {start: number; end: number} | null {
  if (!needle) {
    return null;
  }
  // (1) verbatim
  const verbatim = haystack.indexOf(needle);
  if (verbatim >= 0) {
    return {start: verbatim, end: verbatim + needle.length};
  }
  const trimmed = needle.trim();
  if (!trimmed) {
    return null;
  }
  // (2) trimmed outer whitespace
  if (trimmed !== needle) {
    const j = haystack.indexOf(trimmed);
    if (j >= 0) {
      return {start: j, end: j + trimmed.length};
    }
  }
  // (3) drop a balanced wrapping quote pair the model added around the passage
  const unquoted = stripWrappingQuotes(trimmed);
  if (unquoted !== trimmed && unquoted.length > 0) {
    const k = haystack.indexOf(unquoted);
    if (k >= 0) {
      return {start: k, end: k + unquoted.length};
    }
  }
  // Tiers 4 & 5 match a normalized haystack; try both the trimmed and unquoted
  // spellings of the needle against it.
  const candidates = [trimmed, unquoted];
  // (4) internal-whitespace-normalized
  const ws = collapseWs(haystack);
  for (const cand of candidates) {
    const nNeedle = cand.replace(/\s+/g, ' ');
    if (!nNeedle) {
      continue;
    }
    const k = ws.text.indexOf(nNeedle);
    if (k >= 0) {
      const start = ws.map[k];
      const endIdx = k + nNeedle.length - 1;
      const end = (ws.map[endIdx] ?? start) + 1;
      return {start, end};
    }
  }
  // (5) punctuation/quote/dash-insensitive
  const nm = normalizeMatch(haystack);
  for (const cand of candidates) {
    const nNeedle = normalizeMatch(cand).text;
    if (!nNeedle) {
      continue;
    }
    const m = nm.text.indexOf(nNeedle);
    if (m >= 0) {
      const start = nm.map[m];
      const endIdx = m + nNeedle.length - 1;
      const end = (nm.map[endIdx] ?? start) + 1;
      return {start, end};
    }
  }
  return null;
}

/** Map a single character to its fuzzy-match equivalent (1:1), or '' to drop it. */
function normChar(c: string): string {
  switch (c) {
    // curly single quotes / apostrophe / prime
    case '‘':
    case '’':
    case '‚':
    case '‛':
    case '′':
    case 'ʼ':
      return "'";
    // curly double quotes / guillemets
    case '“':
    case '”':
    case '„':
    case '‟':
    case '«':
    case '»':
      return '"';
    // en/em/figure dashes, minus sign
    case '–':
    case '—':
    case '―':
    case '−':
      return '-';
    // ellipsis
    case '…':
      return '.';
    // zero-width / soft hyphen — drop (so "co­operative" matches "cooperative")
    case '­':
    case '​':
    case '‌':
    case '‍':
    case '﻿':
      return '';
    default:
      return c;
  }
}

/**
 * Normalize for fuzzy matching: collapse whitespace runs (incl. nbsp) to single
 * spaces, apply `normChar` (quotes/dashes/ellipsis), and drop zero-width marks.
 * `map[k]` is the ORIGINAL source index of the k-th emitted char, so a match can
 * be mapped back to real offsets for splicing.
 */
function normalizeMatch(s: string): {text: string; map: number[]} {
  let text = '';
  const map: number[] = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) {
      text += ' ';
      map.push(i);
      while (i < s.length && /\s/.test(s[i])) {
        i++;
      }
      continue;
    }
    const n = normChar(c);
    if (n) {
      text += n;
      map.push(i);
    }
    i++;
  }
  return {text, map};
}

/** Strip one balanced wrapping quote pair the model may have added. */
function stripWrappingQuotes(s: string): string {
  const pairs: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['“', '”'],
    ['‘', '’'],
  ];
  for (const [open, close] of pairs) {
    if (s.length >= 2 && s.startsWith(open) && s.endsWith(close)) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** Collapse whitespace runs to single spaces; `map[i]` = original index of char i. */
function collapseWs(s: string): {text: string; map: number[]} {
  let text = '';
  const map: number[] = [];
  let i = 0;
  while (i < s.length) {
    if (/\s/.test(s[i])) {
      text += ' ';
      map.push(i);
      while (i < s.length && /\s/.test(s[i])) {
        i++;
      }
    } else {
      text += s[i];
      map.push(i);
      i++;
    }
  }
  return {text, map};
}

// --- sentinel-aware splice helpers ----------------------------------------
interface Span {
  start: number;
  end: number;
}

function itemLen(it: InlineItem): number {
  if (it.kind === 'text') {
    return it.text.length;
  }
  return (it.kind === 'cite' ? citeSentinel(it.nonce) : eqSentinel(it.nonce)).length;
}

/** Per-item char spans over the block's sentinel-laden flat text. */
function computeSpans(items: InlineItem[]): Span[] {
  const spans: Span[] = [];
  let pos = 0;
  for (const it of items) {
    const len = itemLen(it);
    spans.push({start: pos, end: pos + len});
    pos += len;
  }
  return spans;
}

function firstTouched(spans: Span[], sStart: number): number {
  for (let i = 0; i < spans.length; i++) {
    if (spans[i].end > sStart) {
      return i;
    }
  }
  return -1;
}

function lastTouched(spans: Span[], sEnd: number): number {
  for (let i = spans.length - 1; i >= 0; i--) {
    if (spans[i].start < sEnd) {
      return i;
    }
  }
  return -1;
}

/** Decorator items fully inside the search region (available to clone/remove). */
function inRegionDecos(items: InlineItem[], spans: Span[], found: Span): InlineItem[] {
  const out: InlineItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.kind === 'text') {
      continue;
    }
    if (spans[i].start >= found.start && spans[i].end <= found.end) {
      out.push(it);
    }
  }
  return out;
}

/**
 * Validating reconciliation (PLAN §6/T4): every sentinel in `replace` must
 * resolve to an in-region decorator of the same kind+nonce, each consumed at
 * most once. This forbids the model from inventing, cloning, or smuggling in
 * an atomic node — only a sentinel that was actually in the SEARCH passage may
 * appear in REPLACE (kept), and dropping one is an authorized delete.
 */
function validateReplace(
  segs: Segment[],
  regionDecos: InlineItem[],
): {ok: boolean; reason?: string} {
  // Decorator items only (text items carry no nonce); build a consume-once pool.
  const pool = regionDecos.flatMap(d =>
    d.kind === 'text' ? [] : [{kind: d.kind, nonce: d.nonce}],
  );
  for (const seg of segs) {
    if ('text' in seg) {
      continue;
    }
    const idx = pool.findIndex(p => p.kind === seg.kind && p.nonce === seg.nonce);
    if (idx < 0) {
      return {
        ok: false,
        reason:
          seg.kind === 'cite'
            ? 'edit references a citation that is not in the search passage'
            : 'edit references an equation that is not in the search passage',
      };
    }
    pool.splice(idx, 1);
  }
  return {ok: true};
}

function parentKey(node: LexicalNode): string | undefined {
  return node.getParent()?.getKey();
}

export interface PatchResult {
  ok: boolean;
  reason?: string;
}

interface PatchDecision {
  blockKey: string;
  start: number;
  end: number;
  path: 'text' | 'sentinel';
  /** When set, the edit was located but is invalid (validation/structure). */
  reason?: string;
}

/**
 * Locate `search` within a single top-level block and replace it with `replace`.
 *
 * Two splice paths:
 *  - `text`  — the search passage contains no atomic node. Reuses the proven
 *    text-node splice (works even when the text is nested, e.g. inside a link).
 *  - `sentinel` — the passage spans a citation/equation. Requires every touched
 *    node to be a direct child of the block (the realistic prose case), so the
 *    decorator can be cloned/removed predictably. `replace`'s sentinels are
 *    validated against the in-region decorators (see `validateReplace`).
 *
 * Locating + the validity decision run in a synchronous read (authoritative
 * before any mutation); the splice runs in an `editor.update`. The update
 * re-derives items (the read's node refs are invalid in the update state); the
 * state is unchanged between the two, so the same offsets locate the same range.
 */
export function applyTextPatch(
  editor: LexicalEditor,
  search: string,
  replace: string,
): Promise<PatchResult> {
  const needle = search.trim();
  if (needle.length === 0) {
    return Promise.resolve({ok: false, reason: 'empty search text'});
  }
  const replaceSegs = parseSegments(replace);

  // Phase 1 (read): locate, choose the path, validate sentinels.
  let decision: PatchDecision | null = null;
  editor.getEditorState().read(() => {
    for (const block of $getRoot().getChildren()) {
      const items = blockInlineItems(block);
      if (items.length === 0) {
        continue;
      }
      const text = itemsToText(items);
      const found = locate(text, needle);
      if (!found) {
        continue;
      }
      const spans = computeSpans(items);
      const a = firstTouched(spans, found.start);
      const b = lastTouched(spans, found.end);
      if (a < 0 || b < 0) {
        continue;
      }
      const blockKey = block.getKey();
      const touched = items.slice(a, b + 1);
      const hasDeco = touched.some(it => it.kind !== 'text');

      let path: 'text' | 'sentinel' = 'text';
      if (hasDeco) {
        const flat = touched.every(it => parentKey(it.node) === blockKey);
        if (!flat) {
          decision = {
            blockKey,
            start: found.start,
            end: found.end,
            path: 'sentinel',
            reason:
              'edit spans nested formatting around a citation/equation — select a simpler passage',
          };
          return;
        }
        path = 'sentinel';
      }

      const regionDecos = inRegionDecos(items, spans, found);
      const v = validateReplace(replaceSegs, regionDecos);
      if (!v.ok) {
        decision = {blockKey, start: found.start, end: found.end, path, reason: v.reason};
        return;
      }
      decision = {blockKey, start: found.start, end: found.end, path};
      return;
    }
  });

  if (!decision) {
    return Promise.resolve({ok: false, reason: 'passage not found in the document'});
  }
  if (decision.reason) {
    return Promise.resolve({ok: false, reason: decision.reason});
  }

  // Phase 2 (update): execute the chosen splice.
  const d = decision;
  const replaceText = replaceSegs.map(s => ('text' in s ? s.text : '')).join('');
  editor.update(() => {
    const block = $getNodeByKey(d.blockKey);
    if (!$isElementNode(block)) {
      return;
    }
    if (d.path === 'sentinel') {
      sentinelSplice(block, needle, replaceSegs);
    } else {
      textSplice(block, needle, replaceText);
    }
  });
  return Promise.resolve({ok: true});
}

/** Text-only splice (no atomic nodes in the passage). Nesting-safe. */
function textSplice(block: ElementNode, needle: string, replaceText: string): void {
  const tns: TextNode[] = [];
  collectTextNodes(block, tns);
  if (tns.length === 0) {
    return;
  }
  const lens = tns.map(t => t.getTextContent().length);
  const starts: number[] = [];
  let concat = '';
  for (let k = 0; k < tns.length; k++) {
    starts.push(concat.length);
    concat += tns[k].getTextContent();
  }
  const found = locate(concat, needle);
  if (!found) {
    return;
  }
  const idx = found.start;
  const end = found.end;
  let firstIdx = -1;
  let lastIdx = -1;
  for (let k = 0; k < tns.length; k++) {
    const s = starts[k];
    const e = s + lens[k];
    if (firstIdx === -1 && idx < e) {
      firstIdx = k;
    }
    if (end > s) {
      lastIdx = k;
    }
  }
  if (firstIdx < 0 || lastIdx < 0) {
    return;
  }
  const firstNode = tns[firstIdx];
  const lastNode = tns[lastIdx];
  const prefix = firstNode.getTextContent().slice(0, idx - starts[firstIdx]);
  const suffix = lastNode.getTextContent().slice(end - starts[lastIdx]);
  firstNode.setTextContent(prefix + replaceText + suffix);
  for (let k = firstIdx + 1; k <= lastIdx; k++) {
    tns[k].remove();
  }
}

/**
 * Sentinel splice (the passage spans citations/equations). The touched nodes
 * are direct children of the block, so we rebuild the inline sequence: keep the
 * partial prefix/suffix text nodes (re-texted), clone the in-region decorator
 * nodes the model chose to keep, drop the ones it omitted, and insert the rest.
 */
function sentinelSplice(block: ElementNode, needle: string, segs: Segment[]): void {
  const items = blockInlineItems(block);
  if (items.length === 0) {
    return;
  }
  const text = itemsToText(items);
  const found = locate(text, needle);
  if (!found) {
    return;
  }
  const spans = computeSpans(items);
  const a = firstTouched(spans, found.start);
  const b = lastTouched(spans, found.end);
  if (a < 0 || b < 0) {
    return;
  }
  const aItem = items[a];
  const bItem = items[b];

  // Only text items can carry a partial prefix/suffix (decorators are atomic).
  let prefixItem =
    aItem.kind === 'text' && spans[a].start < found.start ? aItem : null;
  let suffixItem =
    bItem.kind === 'text' && spans[b].end > found.end ? bItem : null;
  const prefixText =
    prefixItem && prefixItem.kind === 'text'
      ? prefixItem.text.slice(0, found.start - spans[a].start)
      : '';
  const suffixText =
    suffixItem && suffixItem.kind === 'text'
      ? suffixItem.text.slice(found.end - spans[b].start)
      : '';
  if (prefixText === '') {
    prefixItem = null;
  }
  if (suffixText === '') {
    suffixItem = null;
  }

  const touched = items.slice(a, b + 1);
  const firstTextItem =
    prefixItem ?? suffixItem ?? touched.find(it => it.kind === 'text');
  const firstFormat = firstTextItem?.kind === 'text' ? firstTextItem.node.getFormat() : 0;

  // In-region decorator pool; consume one per sentinel in `replace`.
  const pool: InlineItem[] = touched.filter(it => it.kind !== 'text');
  const cloneDeco = (kind: SentinelKind, nonce: string): LexicalNode | null => {
    const idx = pool.findIndex(it => it.kind === kind && it.nonce === nonce);
    if (idx < 0) {
      return null;
    }
    // Reconstruct a fresh node carrying the same identity (citation id / LaTeX),
    // via the type-safe factories rather than the loosely-typed instance clone.
    const got = pool.splice(idx, 1)[0];
    if (got.kind === 'cite') {
      return $createCitationNode(got.node.getLabel(), got.node.getCitationId());
    }
    if (got.kind === 'eq') {
      return $createEquationNode(got.node.getEquation(), got.node.isInline());
    }
    return null;
  };

  const sameCarrier =
    !!prefixItem && !!suffixItem && prefixItem.node.getKey() === suffixItem.node.getKey();

  const newNodes: LexicalNode[] = [];
  let firstReplaceTextDone = false;
  const makeText = (s: string, format: number): TextNode => {
    const n = $createTextNode(s);
    n.setFormat(format);
    return n;
  };
  for (const seg of segs) {
    if ('text' in seg) {
      if (seg.text.length === 0) {
        continue;
      }
      const fmt = firstReplaceTextDone ? 0 : firstFormat;
      firstReplaceTextDone = true;
      newNodes.push(makeText(seg.text, fmt));
    } else {
      const clone = cloneDeco(seg.kind, seg.nonce);
      if (clone) {
        newNodes.push(clone);
      }
    }
  }
  if (sameCarrier && suffixText) {
    // The single carrier now holds the prefix; the suffix rides at the tail.
    newNodes.push(makeText(suffixText, firstFormat));
  }

  // Re-text the kept carriers, then remove everything else in the touched range.
  if (prefixItem && prefixItem.kind === 'text') {
    prefixItem.node.setTextContent(prefixText);
  }
  if (suffixItem && suffixItem.kind === 'text' && !sameCarrier) {
    suffixItem.node.setTextContent(suffixText);
  }
  const removeNodes = touched
    .filter(it => it !== prefixItem && it !== suffixItem)
    .map(it => it.node);

  // Insert the replacement nodes at the right gap, then drop the consumed nodes.
  if (prefixItem) {
    let after: LexicalNode = prefixItem.node;
    removeNodes.forEach(n => n.remove());
    for (const n of newNodes) {
      after.insertAfter(n);
      after = n;
    }
  } else if (suffixItem) {
    removeNodes.forEach(n => n.remove());
    for (const n of newNodes) {
      suffixItem.node.insertBefore(n);
    }
  } else {
    // Whole range is inner — insert before the first touched node (it gets
    // removed too, but the new nodes stay as its preceding siblings).
    const ref = touched[0].node;
    for (const n of newNodes) {
      ref.insertBefore(n);
    }
    removeNodes.forEach(n => n.remove());
  }
}
