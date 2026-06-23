/**
 * gitEssay — block-level diff + intra-block word diff.
 *
 * diffBlocks: LCS over canonical block keys (kind + structural attrs +
 * content). Adjacent remove+add of the same kind/type collapses into a single
 * 'modified' block (then rendered with an intra-diff). NodeKeys are not used
 * (D1) — matching is purely by content/position via the LCS.
 *
 * diffRuns: word-level LCS over text runs (split into word/whitespace/punct
 * tokens) with the same remove+add → 'modified' merge, so a single word
 * add/remove/replace or a same-word format/size/colour change is isolated.
 */
import {diffArrays} from 'diff';

import type {BlockOp, DiffBlock, TextRun, WordOp} from './types';

const SEP = '\x1f';

// --- block-level ----------------------------------------------------------
function runKey(r: TextRun): string {
  return `${r.text}${SEP}${r.format}${SEP}${r.style}${SEP}${r.link ?? ''}`;
}
function runsKey(runs?: TextRun[]): string {
  return (runs ?? []).map(runKey).join(SEP);
}
function cellsKey(cells?: TextRun[][][]): string {
  if (!cells) {
    return '';
  }
  return cells
    .map(row => row.map(cell => runsKey(cell)).join(','))
    .join(';');
}

function blockKey(b: DiffBlock): string {
  const attrs =
    `${b.kind}${SEP}${b.type}${SEP}${b.tag ?? ''}${SEP}${b.align ?? ''}` +
    `${SEP}${b.direction ?? ''}${SEP}${b.indent ?? 0}`;
  if (b.kind === 'text') {
    return `${attrs}${SEP}${runsKey(b.runs)}`;
  }
  if (b.kind === 'table') {
    return `${attrs}${SEP}${cellsKey(b.cells)}`;
  }
  return `${attrs}${SEP}${b.label ?? ''}`;
}

type RawBlockOp = {type: 'equal' | 'removed' | 'added'; block: DiffBlock};

export function diffBlocks(oldB: DiffBlock[], newB: DiffBlock[]): BlockOp[] {
  const parts = diffArrays(oldB.map(blockKey), newB.map(blockKey));
  const raw: RawBlockOp[] = [];
  let oi = 0;
  let ni = 0;
  for (const part of parts) {
    const n = part.value.length;
    if (part.added) {
      for (let i = 0; i < n; i++) {
        raw.push({type: 'added', block: newB[ni + i]});
      }
      ni += n;
    } else if (part.removed) {
      for (let i = 0; i < n; i++) {
        raw.push({type: 'removed', block: oldB[oi + i]});
      }
      oi += n;
    } else {
      for (let i = 0; i < n; i++) {
        raw.push({type: 'equal', block: oldB[oi + i]});
      }
      oi += n;
      ni += n;
    }
  }

  const out: BlockOp[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i].type === 'removed') {
      const removed: DiffBlock[] = [];
      while (i < raw.length && raw[i].type === 'removed') {
        removed.push(raw[i].block);
        i++;
      }
      const added: DiffBlock[] = [];
      while (i < raw.length && raw[i].type === 'added') {
        added.push(raw[i].block);
        i++;
      }
      const used = new Set<number>();
      for (const r of removed) {
        const ai = added.findIndex(
          (a, idx) => !used.has(idx) && a.kind === r.kind && a.type === r.type,
        );
        if (ai >= 0) {
          used.add(ai);
          out.push({type: 'modified', block: added[ai], prev: r});
        } else {
          out.push({type: 'removed', block: r});
        }
      }
      added.forEach((a, idx) => {
        if (!used.has(idx)) {
          out.push({type: 'added', block: a});
        }
      });
    } else if (raw[i].type === 'added') {
      out.push({type: 'added', block: raw[i].block});
      i++;
    } else {
      out.push({type: 'equal', block: raw[i].block});
      i++;
    }
  }
  return out;
}

// --- word-level (intra-block) --------------------------------------------
const WORD_RE = /[\wÀ-ɏ]+|\s+|[^\s\wÀ-ɏ]+/g;

interface WordToken {
  key: string;
  match: string;
  run: TextRun;
}

function runToTokens(r: TextRun): WordToken[] {
  const out: WordToken[] = [];
  if (!r.text) {
    return out;
  }
  const parts = r.text.match(WORD_RE);
  if (!parts) {
    return out;
  }
  for (const seg of parts) {
    out.push({
      key: `t${SEP}${seg}${SEP}${r.format}${SEP}${r.style}${SEP}${r.link ?? ''}`,
      match: `T${SEP}${seg}`,
      run: {...r, text: seg},
    });
  }
  return out;
}

type RawWordOp = {type: 'equal' | 'removed' | 'added'; t: WordToken};

export function diffRuns(oldRuns: TextRun[], newRuns: TextRun[]): WordOp[] {
  const oldT = oldRuns.flatMap(runToTokens);
  const newT = newRuns.flatMap(runToTokens);
  const parts = diffArrays(
    oldT.map(t => t.key),
    newT.map(t => t.key),
  );
  const raw: RawWordOp[] = [];
  let oi = 0;
  let ni = 0;
  for (const part of parts) {
    const n = part.value.length;
    if (part.added) {
      for (let i = 0; i < n; i++) {
        raw.push({type: 'added', t: newT[ni + i]});
      }
      ni += n;
    } else if (part.removed) {
      for (let i = 0; i < n; i++) {
        raw.push({type: 'removed', t: oldT[oi + i]});
      }
      oi += n;
    } else {
      for (let i = 0; i < n; i++) {
        raw.push({type: 'equal', t: oldT[oi + i]});
      }
      oi += n;
      ni += n;
    }
  }

  const out: WordOp[] = [];
  let i = 0;
  while (i < raw.length) {
    if (raw[i].type === 'removed') {
      const removed: WordToken[] = [];
      while (i < raw.length && raw[i].type === 'removed') {
        removed.push(raw[i].t);
        i++;
      }
      const added: WordToken[] = [];
      while (i < raw.length && raw[i].type === 'added') {
        added.push(raw[i].t);
        i++;
      }
      const used = new Set<number>();
      for (const r of removed) {
        const ai = added.findIndex(
          (a, idx) => !used.has(idx) && a.match === r.match,
        );
        if (ai >= 0) {
          used.add(ai);
          out.push({type: 'modified', run: added[ai].run, prev: r.run});
        } else {
          out.push({type: 'removed', run: r.run});
        }
      }
      added.forEach((a, idx) => {
        if (!used.has(idx)) {
          out.push({type: 'added', run: a.run});
        }
      });
    } else if (raw[i].type === 'added') {
      out.push({type: 'added', run: raw[i].t.run});
      i++;
    } else {
      out.push({type: 'equal', run: raw[i].t.run});
      i++;
    }
  }
  return out;
}
