/**
 * gitEssay — checkpoint service.
 *
 * Pure async operations over the Dexie store + a tiny pub/sub so React can
 * re-render on change. Owns the canonical capture/restore logic (PLAN §5):
 *
 *  - AUTO checkpoints are a ROLLING SINGLETON: a single row with a stable id
 *    (`<docId>::auto`) is upserted on every auto-save, so there is ever only
 *    one auto ("the current draft"). Manual + init checkpoints are the durable
 *    history and are never auto-deleted. A manual save / restore drops the
 *    auto slot (its content is now captured at a durable point).
 *  - capture: read editor.getEditorState().toJSON() (+ markdown), link to the
 *    latest durable checkpoint via parentId, advance the current pointer.
 *  - restore: parseEditorState + setEditorState, move the current pointer;
 *    the next capture branches lazily, so history never overwrites.
 *  - bootstrapDoc: transactional + idempotent — captures the 'init' baseline
 *    only when zero checkpoints exist (safe under React StrictMode's dev
 *    double-mount) and restores the current pointer into the editor.
 */
import {$convertToMarkdownString} from '@lexical/markdown';
import {
  CLEAR_HISTORY_COMMAND,
  type LexicalEditor,
  type SerializedEditorState,
} from 'lexical';

import {PLAYGROUND_TRANSFORMERS} from '../plugins/MarkdownTransformers';
import {
  db,
  DOC_ID,
  LEXICAL_VERSION,
  SCHEMA_VERSION,
  type Checkpoint,
  type CheckpointSource,
} from './db';

function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Stable id for the single rolling auto slot of a document. */
function autoSlotId(docId: string): string {
  return `${docId}::auto`;
}

function readMarkdown(editor: LexicalEditor): string {
  try {
    return editor.getEditorState().read(() =>
      $convertToMarkdownString(PLAYGROUND_TRANSFORMERS),
    );
  } catch {
    return '';
  }
}

// --- pub/sub --------------------------------------------------------------
type Listener = () => void;
const listeners = new Set<Listener>();
let version = 0;

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
export function getVersion(): number {
  return version;
}
function emit(): void {
  version++;
  listeners.forEach(l => l());
}

// --- reads ----------------------------------------------------------------
export async function getCurrentId(docId = DOC_ID): Promise<string | null> {
  const meta = await db.meta.get(docId);
  return meta?.currentCheckpointId ?? null;
}

export async function listCheckpoints(docId = DOC_ID): Promise<Checkpoint[]> {
  const all = await db.checkpoints.where('docId').equals(docId).toArray();
  return all.sort((a, b) => b.createdAt - a.createdAt); // newest first
}

export async function getCheckpoint(id: string): Promise<Checkpoint | undefined> {
  return db.checkpoints.get(id);
}

/** Id of the most recent durable (non-auto) checkpoint, or null. */
async function latestDurableId(docId: string): Promise<string | null> {
  const durables = await db.checkpoints
    .where('docId')
    .equals(docId)
    .filter(c => c.source !== 'auto')
    .sortBy('createdAt'); // ascending
  return durables.length > 0 ? durables[durables.length - 1].id : null;
}

// --- writes ---------------------------------------------------------------
export interface CaptureOptions {
  label?: string;
  source: CheckpointSource;
  /** Skip if the editor's markdown equals the current checkpoint (auto only). */
  skipIfUnchanged?: boolean;
}

export async function captureCheckpoint(
  editor: LexicalEditor,
  opts: CaptureOptions,
): Promise<Checkpoint | null> {
  const docId = DOC_ID;
  const markdown = readMarkdown(editor);
  const currentId = await getCurrentId(docId);
  const current = currentId ? await db.checkpoints.get(currentId) : undefined;

  if (opts.skipIfUnchanged && current && current.markdown === markdown) {
    return null; // no content change since the current checkpoint
  }

  const state = editor.getEditorState().toJSON() as SerializedEditorState;
  const createdAt = Date.now();

  if (opts.source === 'auto') {
    // Rolling singleton: upsert the one auto slot (stable id).
    const slot: Checkpoint = {
      id: autoSlotId(docId),
      docId,
      parentId: await latestDurableId(docId),
      schemaVersion: SCHEMA_VERSION,
      lexicalVersion: LEXICAL_VERSION,
      state,
      markdown,
      createdAt,
      source: 'auto',
    };
    await db.transaction('rw', db.checkpoints, db.meta, async () => {
      await db.checkpoints.put(slot);
      await db.meta.put({docId, currentCheckpointId: slot.id});
    });
    emit();
    return slot;
  }

  // Durable (manual/init/…): chain off a durable parent (skip an auto slot so
  // the parent never dangles), then drop the auto slot since the draft is now
  // captured at a durable point.
  const parentId =
    current && current.source === 'auto' ? current.parentId : currentId;
  const cp: Checkpoint = {
    id: newId(),
    docId,
    parentId,
    schemaVersion: SCHEMA_VERSION,
    lexicalVersion: LEXICAL_VERSION,
    state,
    markdown,
    createdAt,
    label: opts.label,
    source: opts.source,
  };
  await db.transaction('rw', db.checkpoints, db.meta, async () => {
    await db.checkpoints.put(cp);
    await db.checkpoints.delete(autoSlotId(docId));
    await db.meta.put({docId, currentCheckpointId: cp.id});
  });
  emit();
  return cp;
}

export async function restoreCheckpoint(
  editor: LexicalEditor,
  id: string,
): Promise<void> {
  const cp = await db.checkpoints.get(id);
  if (!cp) {
    return;
  }
  editor.setEditorState(editor.parseEditorState(cp.state));
  editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  await db.transaction('rw', db.checkpoints, db.meta, async () => {
    // Going back to a durable point: abandon any pending draft slot.
    if (cp.source !== 'auto') {
      await db.checkpoints.delete(autoSlotId(cp.docId));
    }
    await db.meta.put({docId: cp.docId, currentCheckpointId: id});
  });
  emit();
}

/**
 * First-mount setup: capture an 'init' baseline iff the doc is empty
 * (transactional, so idempotent under StrictMode double-mount), then load the
 * current checkpoint so the doc persists across reloads (resumes the pending
 * auto-draft if one exists).
 */
export async function bootstrapDoc(editor: LexicalEditor): Promise<void> {
  const docId = DOC_ID;
  await db.transaction('rw', db.checkpoints, db.meta, async () => {
    const existing = await db.checkpoints.where('docId').equals(docId).count();
    let currentId = await getCurrentId(docId);
    if (existing === 0) {
      const init: Checkpoint = {
        id: newId(),
        docId,
        parentId: null,
        schemaVersion: SCHEMA_VERSION,
        lexicalVersion: LEXICAL_VERSION,
        state: editor.getEditorState().toJSON() as SerializedEditorState,
        markdown: readMarkdown(editor),
        createdAt: Date.now(),
        label: 'Initial',
        source: 'init',
      };
      await db.checkpoints.put(init);
      await db.meta.put({docId, currentCheckpointId: init.id});
      currentId = init.id;
    }
    if (currentId) {
      const cp = await db.checkpoints.get(currentId);
      if (cp) {
        editor.setEditorState(editor.parseEditorState(cp.state));
      }
    }
  });
}
