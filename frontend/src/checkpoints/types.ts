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
  schemaVersion: number;
  lexicalVersion: string;
  state: SerializedEditorState;
  markdown: string;
  createdAt: number;
  label?: string;
  source: CheckpointSource;
}
