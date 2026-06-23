/**
 * gitEssay — diff types (block-level).
 *
 * A document is segmented into BLOCKS (paragraph / heading / quote / list-item
 * / table / image / equation / …). Two block lists are LCS-diffed into BlockOps;
 * a 'modified' block is then word-diffed inside (text) or cell-diffed (table).
 * Block attributes (type / tag / align / direction / indent) are part of the
 * block identity, so a heading↔paragraph / alignment / direction / indent change
 * is detected — and the renderer applies real text-align + real indent spacing,
 * so the change is visible, not just structural.
 */
export interface TextRun {
  text: string;
  format: number; // TextNode format bitmask
  style: string; // TextNode inline CSS
  link: string | null;
}

export type BlockKind =
  | 'text'
  | 'image'
  | 'table'
  | 'equation'
  | 'code'
  | 'hr'
  | 'pagebreak';

export interface DiffBlock {
  kind: BlockKind;
  /** Element type (paragraph/heading/quote/listitem/table/…). */
  type: string;
  tag?: string; // heading tag (h1…)
  align?: string; // element format: '' | 'left' | 'center' | 'right' | 'justify' | 'start' | 'end'
  direction?: 'ltr' | 'rtl' | string;
  indent?: number;
  runs?: TextRun[]; // kind 'text'
  cells?: TextRun[][][]; // kind 'table': [row][cell] -> runs
  label?: string; // image/equation/code/…
  inline?: boolean; // equation
}

export type BlockOpType = 'equal' | 'added' | 'removed' | 'modified';

export interface BlockOp {
  type: BlockOpType;
  /** New block; for 'modified' this is the new version. */
  block: DiffBlock;
  /** Old block; for 'modified' only. */
  prev?: DiffBlock;
}

/** Word-level op inside a text run / table cell. */
export type WordOpType = 'equal' | 'added' | 'removed' | 'modified';

export interface WordOp {
  type: WordOpType;
  run: TextRun; // for 'modified' this is the new run
  prev?: TextRun; // for 'modified' only
}
