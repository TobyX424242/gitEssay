/**
 * gitEssay — block-level unified-inline diff renderer.
 *
 * Each block renders faithfully: a text block is a real <div> with its actual
 * text-align + real indent spacing (so an alignment/indent/heading-type change
 * is visible, not just structural); a table is a real <table> with per-cell
 * word diffs. Within an unchanged-attribute block, text is word-diffed (added
 * green / removed red+strike / format-size change yellow). A block whose
 * attributes changed re-renders as the old line struck + the new line added.
 */
import {type CSSProperties, type JSX} from 'react';

import {diffRuns} from './diff';
import type {BlockOp, DiffBlock, TextRun, WordOp, WordOpType} from './types';
import './diff.css';

const FMT = {
  BOLD: 1,
  ITALIC: 2,
  STRIKETHROUGH: 4,
  UNDERLINE: 8,
  CODE: 16,
  SUBSCRIPT: 32,
  SUPERSCRIPT: 64,
  HIGHLIGHT: 128,
  LOWERCASE: 256,
  UPPERCASE: 512,
  CAPITALIZE: 1024,
} as const;

function parseStyle(css?: string): CSSProperties {
  const out: CSSProperties = {};
  if (!css) {
    return out;
  }
  for (const decl of css.split(';')) {
    const idx = decl.indexOf(':');
    if (idx < 0) {
      continue;
    }
    const prop = decl.slice(0, idx).trim();
    const val = decl.slice(idx + 1).trim();
    if (prop && val) {
      (out as Record<string, string>)[
        prop.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
      ] = val;
    }
  }
  return out;
}

function runStyle(run: TextRun): CSSProperties {
  const f = run.format;
  const s: CSSProperties = {...parseStyle(run.style)};
  if (f & FMT.BOLD) {
    s.fontWeight = 700;
  }
  if (f & FMT.ITALIC) {
    s.fontStyle = 'italic';
  }
  const deco: string[] = [];
  if (f & FMT.UNDERLINE) {
    deco.push('underline');
  }
  if (f & FMT.STRIKETHROUGH) {
    deco.push('line-through');
  }
  if (run.link) {
    deco.push('underline');
  }
  if (deco.length > 0) {
    s.textDecoration = deco.join(' ');
  }
  if (f & FMT.CODE) {
    s.fontFamily = (s.fontFamily as string) || 'monospace';
  }
  if (f & FMT.SUBSCRIPT) {
    s.verticalAlign = 'sub';
    s.fontSize = 'smaller';
  }
  if (f & FMT.SUPERSCRIPT) {
    s.verticalAlign = 'super';
    s.fontSize = 'smaller';
  }
  if (f & FMT.UPPERCASE) {
    s.textTransform = 'uppercase';
  } else if (f & FMT.LOWERCASE) {
    s.textTransform = 'lowercase';
  } else if (f & FMT.CAPITALIZE) {
    s.textTransform = 'capitalize';
  }
  if (run.link) {
    s.color = (s.color as string) || 'var(--ge-accent)';
  }
  return s;
}

function attrsEqual(a: DiffBlock, b: DiffBlock): boolean {
  return (
    a.type === b.type &&
    a.tag === b.tag &&
    a.align === b.align &&
    a.direction === b.direction &&
    (a.indent ?? 0) === (b.indent ?? 0)
  );
}

function blockAttrsStyle(b: DiffBlock): CSSProperties {
  const s: CSSProperties = {};
  if (b.align) {
    s.textAlign = b.align as CSSProperties['textAlign'];
  }
  if ((b.indent ?? 0) > 0) {
    s.paddingLeft = `${(b.indent ?? 0) * 2}em`;
  }
  return s;
}

function wordClass(type: WordOpType, text: string): string | undefined {
  if (type === 'equal' || /^\s*$/.test(text)) {
    return undefined; // whitespace carries no colour
  }
  return `diff-${type}`;
}

function runsAsOps(runs: TextRun[] | undefined, type: WordOpType): WordOp[] {
  return (runs ?? []).map(run => ({type, run}));
}

function renderWordOps(ops: WordOp[], kp: string): JSX.Element[] {
  return ops.map((op, i) => (
    <span
      key={`${kp}-${i}`}
      className={wordClass(op.type, op.run.text)}
      style={runStyle(op.run)}
      title={op.run.link ?? undefined}>
      {op.run.text}
    </span>
  ));
}

function diffTableCells(
  oldCells: TextRun[][][],
  newCells: TextRun[][][],
): WordOp[][][] {
  const maxR = Math.max(oldCells.length, newCells.length);
  const grid: WordOp[][][] = [];
  for (let r = 0; r < maxR; r++) {
    const oR = oldCells[r];
    const nR = newCells[r];
    const maxC = Math.max(oR?.length ?? 0, nR?.length ?? 0);
    const row: WordOp[][] = [];
    for (let c = 0; c < maxC; c++) {
      const oc = oR?.[c] ?? [];
      const nc = nR?.[c] ?? [];
      if (oc.length === 0 && nc.length === 0) {
        row.push([]);
      } else if (oc.length === 0) {
        row.push(runsAsOps(nc, 'added'));
      } else if (nc.length === 0) {
        row.push(runsAsOps(oc, 'removed'));
      } else {
        row.push(diffRuns(oc, nc));
      }
    }
    grid.push(row);
  }
  return grid;
}

function renderTextBlock(op: BlockOp, kp: string): JSX.Element {
  const b = op.block;
  if (op.type === 'modified' && op.prev) {
    const prev = op.prev;
    if (!attrsEqual(prev, b)) {
      // Attribute (align/indent/type/direction) changed → strike old line,
      // add new line — each with its own real alignment + indent.
      return (
        <div key={kp}>
          <div className="diff-blockline" style={blockAttrsStyle(prev)}>
            {renderWordOps(runsAsOps(prev.runs, 'removed'), `${kp}-o`)}
          </div>
          <div className="diff-blockline" style={blockAttrsStyle(b)}>
            {renderWordOps(runsAsOps(b.runs, 'added'), `${kp}-n`)}
          </div>
        </div>
      );
    }
    return (
      <div className="diff-blockline" style={blockAttrsStyle(b)} key={kp}>
        {renderWordOps(diffRuns(prev.runs ?? [], b.runs ?? []), kp)}
      </div>
    );
  }
  const type: WordOpType =
    op.type === 'equal' ? 'equal' : op.type === 'added' ? 'added' : 'removed';
  return (
    <div className="diff-blockline" style={blockAttrsStyle(b)} key={kp}>
      {renderWordOps(runsAsOps(b.runs, type), kp)}
    </div>
  );
}

function renderTableBlock(op: BlockOp, kp: string): JSX.Element {
  const b = op.block;
  let grid: WordOp[][][];
  if (op.type === 'modified' && op.prev) {
    grid = diffTableCells(op.prev.cells ?? [], b.cells ?? []);
  } else {
    const type: WordOpType =
      op.type === 'equal' ? 'equal' : op.type === 'added' ? 'added' : 'removed';
    grid = (b.cells ?? []).map(row => row.map(cell => runsAsOps(cell, type)));
  }
  return (
    <table className="diff-table" key={kp}>
      <tbody>
        {grid.map((row, ri) => (
          <tr key={`${kp}-${ri}`}>
            {row.map((ops, ci) => (
              <td key={`${kp}-${ri}-${ci}`}>{renderWordOps(ops, `${kp}-${ri}-${ci}`)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function renderChip(op: BlockOp, kp: string): JSX.Element {
  const b = op.block;
  const sym =
    op.type === 'added' ? '⊕' : op.type === 'removed' ? '⊖' : op.type === 'modified' ? '▦' : '•';
  return (
    <div className="diff-chipline" key={kp}>
      <span
        className={`diff-block diff-block-${op.type}`}
        title={op.prev ? `was: ${op.prev.label}` : undefined}>
        {sym} {b.label}
      </span>
    </div>
  );
}

export default function DiffView({ops}: {ops: BlockOp[]}): JSX.Element {
  return (
    <div className="diff-doc">
      {ops.map((op, i) => {
        const kp = `b${i}`;
        if (op.block.kind === 'text') {
          return renderTextBlock(op, kp);
        }
        if (op.block.kind === 'table') {
          return renderTableBlock(op, kp);
        }
        return renderChip(op, kp);
      })}
    </div>
  );
}
