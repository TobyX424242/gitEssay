/**
 * gitEssay — checkpoint service (backend-backed).
 *
 * Thin async ops over the FastAPI API + a pub/sub so React re-renders. The DAG
 * semantics (rolling auto singleton, manual chaining, current pointer) live on
 * the backend; this just sends the editor state/markdown and maps responses.
 * Operations default to the active project (projectStore).
 */
import {$convertToMarkdownString} from '@lexical/markdown';
import {
  CLEAR_HISTORY_COMMAND,
  type LexicalEditor,
  type SerializedEditorState,
} from 'lexical';

import {PLAYGROUND_TRANSFORMERS} from '../plugins/MarkdownTransformers';
import {getActiveProjectId} from '../projects/projectStore';
import {api} from '../utils/api';
import type {Checkpoint, CheckpointSource} from './types';

export type {Checkpoint, CheckpointSource} from './types';

// --- pub/sub ---------------------------------------------------------------
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

function readMarkdown(editor: LexicalEditor): string {
  try {
    return editor.getEditorState().read(() =>
      $convertToMarkdownString(PLAYGROUND_TRANSFORMERS),
    );
  } catch {
    return '';
  }
}

interface ApiCheckpoint {
  id: string;
  project_id: string;
  parent_id: string | null;
  schema_version: number;
  lexical_version: string;
  state: SerializedEditorState;
  markdown: string;
  source: CheckpointSource;
  label: string | null;
  created_at: number;
}

function map(c: ApiCheckpoint): Checkpoint {
  return {
    id: c.id,
    projectId: c.project_id,
    parentId: c.parent_id,
    schemaVersion: c.schema_version,
    lexicalVersion: c.lexical_version,
    state: c.state,
    markdown: c.markdown,
    source: c.source,
    label: c.label ?? undefined,
    createdAt: c.created_at,
  };
}

// --- reads -----------------------------------------------------------------
export async function listCheckpoints(projectId: string): Promise<Checkpoint[]> {
  const rows = await api.get<ApiCheckpoint[]>(
    `/projects/${projectId}/checkpoints`,
  );
  return rows.map(map);
}

export async function getCurrentId(projectId: string): Promise<string | null> {
  const c = await api.get<ApiCheckpoint | null>(`/projects/${projectId}/current`);
  return c?.id ?? null;
}

// --- writes ----------------------------------------------------------------
export interface CaptureOptions {
  /** Defaults to the active project. */
  projectId?: string;
  label?: string;
  source: CheckpointSource;
  skipIfUnchanged?: boolean;
}

export async function captureCheckpoint(
  editor: LexicalEditor,
  opts: CaptureOptions,
): Promise<Checkpoint | null> {
  const projectId = opts.projectId ?? getActiveProjectId();
  if (!projectId) {
    return null;
  }
  const state = editor.getEditorState().toJSON() as SerializedEditorState;
  const markdown = readMarkdown(editor);
  const c = await api.post<ApiCheckpoint | null>(
    `/projects/${projectId}/checkpoints`,
    {
      state,
      markdown,
      label: opts.label ?? null,
      source: opts.source,
      skip_if_unchanged: opts.skipIfUnchanged ?? false,
    },
  );
  emit();
  return c ? map(c) : null;
}

export async function restoreCheckpoint(
  editor: LexicalEditor,
  id: string,
  projectId?: string,
): Promise<void> {
  const pid = projectId ?? getActiveProjectId();
  if (!pid) {
    return;
  }
  const c = await api.post<ApiCheckpoint>(
    `/projects/${pid}/checkpoints/${id}/restore`,
  );
  if (c) {
    editor.setEditorState(editor.parseEditorState(c.state));
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  }
  emit();
}

/** Load a project's current checkpoint into the editor (used on project open). */
export async function loadProjectState(
  editor: LexicalEditor,
  projectId: string,
): Promise<void> {
  const c = await api.get<ApiCheckpoint | null>(`/projects/${projectId}/current`);
  if (c) {
    editor.setEditorState(editor.parseEditorState(c.state));
    editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
  }
}
