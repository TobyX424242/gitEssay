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
  $getNodeByKey,
  $getRoot,
  $isElementNode,
  $isTextNode,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type TextNode,
} from 'lexical';

import type {DiffBlock} from '../diff/types';
import type {AssistantAction, ChatEdit} from './types';

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

/** Plain text → paragraph DiffBlocks (the "new" side of an edit-card diff). */
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
      runs: [{text: s, format: 0, style: '', link: null}],
    }));
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
 * Locate `needle` in `haystack`. Returns original-index range — never a
 * normalized-space index, so callers can splice safely. Tries the verbatim text
 * first, then a trimmed variant (covers leading/trailing whitespace the model
 * may have added). Internal whitespace must match; the prompt requires verbatim.
 */
function locate(
  haystack: string,
  needle: string,
): {start: number; end: number} | null {
  if (!needle) {
    return null;
  }
  const i = haystack.indexOf(needle);
  if (i >= 0) {
    return {start: i, end: i + needle.length};
  }
  const trimmed = needle.trim();
  if (trimmed && trimmed !== needle) {
    const j = haystack.indexOf(trimmed);
    if (j >= 0) {
      return {start: j, end: j + trimmed.length};
    }
  }
  return null;
}

export interface PatchResult {
  ok: boolean;
  reason?: string;
}

interface PatchTarget {
  blockKey: string;
  /** char offset into the block's concatenated text-node text. */
  start: number;
  end: number;
}

/**
 * Synchronously locate `needle` within a single top-level block. Runs in a read
 * (definitely synchronous), so the result is authoritative before we mutate.
 */
function findPatchTarget(editor: LexicalEditor, needle: string): PatchTarget | null {
  let target: PatchTarget | null = null;
  editor.getEditorState().read(() => {
    for (const block of $getRoot().getChildren()) {
      const tns: TextNode[] = [];
      collectTextNodes(block, tns);
      if (tns.length === 0) {
        continue;
      }
      let concat = '';
      for (const tn of tns) {
        concat += tn.getTextContent();
      }
      const found = locate(concat, needle);
      if (found) {
        target = {blockKey: block.getKey(), start: found.start, end: found.end};
        return;
      }
    }
  });
  return target;
}

/**
 * Locate `search` verbatim within a single top-level block and replace it with
 * `replace`. Locating happens in a synchronous read; the splice happens in an
 * `editor.update` (which returns void in this Lexical version, so we do NOT
 * chain on it — we report success from the synchronous locate). The replacement
 * inherits the first covering node's formatting.
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
  const target = findPatchTarget(editor, needle);
  if (!target) {
    return Promise.resolve({ok: false, reason: 'passage not found in the document'});
  }
  editor.update(() => {
    const block = $getNodeByKey(target.blockKey);
    if (!$isElementNode(block)) {
      return;
    }
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
    // The same editor state as the locate pass, so target offsets are valid.
    const idx = target.start;
    const end = target.end;
    let firstIdx = -1;
    let lastIdx = -1;
    for (let k = 0; k < tns.length; k++) {
      const a = starts[k];
      const b = a + lens[k];
      if (firstIdx === -1 && idx < b) {
        firstIdx = k;
      }
      if (end > a) {
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
    firstNode.setTextContent(prefix + replace + suffix);
    for (let k = firstIdx + 1; k <= lastIdx; k++) {
      tns[k].remove();
    }
  });
  return Promise.resolve({ok: true});
}
