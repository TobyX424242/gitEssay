/**
 * gitEssay — checkpoint types (frontend view of the backend's Checkpoint).
 *
 * The backend stores the Lexical SerializedEditorState as opaque JSON; the
 * frontend round-trips it (parseEditorState / toJSON) without the backend ever
 * parsing it. `projectId` scopes a checkpoint to its owning project.
 */
import type {SerializedEditorState} from 'lexical';

export type CheckpointSource =
  | 'init'
  | 'manual'
  | 'auto'
  | 'restore'
  | 'ai-accept';

export interface Checkpoint {
  id: string;
  projectId: string;
  parentId: string | null;
  state: SerializedEditorState;
  createdAt: number;
  label?: string;
  source: CheckpointSource;
}

/** List view of a checkpoint: metadata only. The (potentially huge) editor
 * state is fetched per-checkpoint via fetchCheckpoint when actually needed
 * (compare mode), keeping list refreshes after every auto-save cheap. */
export type CheckpointMeta = Omit<Checkpoint, 'state'>;
