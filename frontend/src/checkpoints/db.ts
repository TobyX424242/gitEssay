/**
 * gitEssay — checkpoint storage (IndexedDB via Dexie).
 *
 * A checkpoint is a named/restorable point in the document's history, stored as
 * the canonical lexical JSON tree (PLAN §5). Checkpoints form a DAG via
 * `parentId`; `meta.currentCheckpointId` is the pointer the editor currently
 * reflects. Single document for now (DOC_ID = 'default'); multi-doc is later.
 */
import Dexie, {type Table} from 'dexie';
import type {SerializedEditorState} from 'lexical';

export const DOC_ID = 'default';
/** Our document-schema version (migration guard, PLAN T9). */
export const SCHEMA_VERSION = 1;
/** The lexical version this state was captured against. */
export const LEXICAL_VERSION = '0.45.1-nightly.20260623.0';

export type CheckpointSource =
  | 'init' // baseline captured on first load
  | 'manual' // user pressed "Save checkpoint"
  | 'auto' // debounced registerUpdateListener auto-save
  | 'restore' // (reserved) created on restore — we currently branch lazily
  | 'ai-accept'; // (reserved) after an accepted AI diff (Phase 3/4)

export interface Checkpoint {
  id: string;
  docId: string;
  parentId: string | null;
  schemaVersion: number;
  lexicalVersion: string;
  state: SerializedEditorState;
  /** Precomputed flat snapshot — the Phase 3 diff basis + cheap restore preview. */
  markdown: string;
  createdAt: number;
  label?: string;
  source: CheckpointSource;
}

export interface DocMeta {
  docId: string;
  currentCheckpointId: string | null;
}

class CheckpointDB extends Dexie {
  checkpoints!: Table<Checkpoint, string>;
  meta!: Table<DocMeta, string>;

  constructor() {
    super('gitEssay');
    this.version(1).stores({
      checkpoints: 'id, docId, parentId, createdAt, source',
      meta: 'docId',
    });
    // v2: the auto checkpoint became a single rolling slot (`<docId>::auto`).
    // Purge the old per-edit auto rows + collapse duplicate 'init' baselines
    // left by the earlier scheme / StrictMode race, and repair any current
    // pointer that now dangles.
    this.version(2)
      .stores({
        checkpoints: 'id, docId, parentId, createdAt, source',
        meta: 'docId',
      })
      .upgrade(async tx => {
        const all = (await tx.table('checkpoints').toArray()) as Checkpoint[];
        const keepInitId = all
          .filter(c => c.source === 'init')
          .sort((a, b) => a.createdAt - b.createdAt)[0]?.id;
        const drop = all
          .filter(
            c =>
              c.source === 'auto' ||
              (c.source === 'init' && c.id !== keepInitId),
          )
          .map(c => c.id);
        if (drop.length > 0) {
          await tx.table('checkpoints').bulkDelete(drop);
        }

        const remaining = (await tx.table('checkpoints').toArray()) as Checkpoint[];
        const metas = (await tx.table('meta').toArray()) as DocMeta[];
        for (const m of metas) {
          const valid =
            !!m.currentCheckpointId &&
            remaining.some(c => c.id === m.currentCheckpointId);
          if (!valid) {
            const latest = remaining
              .filter(c => c.docId === m.docId)
              .sort((a, b) => b.createdAt - a.createdAt)[0];
            await tx.table('meta').put({
              docId: m.docId,
              currentCheckpointId: latest?.id ?? null,
            });
          }
        }
      });
  }
}

export const db = new CheckpointDB();
