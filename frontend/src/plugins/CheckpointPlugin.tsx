/**
 * gitEssay — CheckpointPlugin.
 *
 * Wires the editor to the backend-backed checkpoint store, scoped to the active
 * project:
 *  - On mount / when the active project changes: load that project's current
 *    checkpoint into the editor (so the doc persists across reloads and project
 *    switches).
 *  - On every content-changing update: debounce (3s idle) an auto-save to the
 *    active project's rolling auto slot. `skipIfUnchanged` suppresses no-op
 *    captures (incl. the update fired by the load itself). Selection-only
 *    updates are ignored. The timer is cancelled on project switch.
 */
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useEffect} from 'react';

import {useActiveProjectId} from '../projects/projectStore';
import {captureCheckpoint, loadProjectState} from '../checkpoints/service';

const AUTOSAVE_DEBOUNCE_MS = 3000;

export default function CheckpointPlugin(): null {
  const [editor] = useLexicalComposerContext();
  const activeId = useActiveProjectId();

  useEffect(() => {
    if (!activeId) {
      return;
    }
    void loadProjectState(editor, activeId);

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingContent = false;
    let cancelled = false;

    const flush = () => {
      timer = null;
      if (cancelled || !pendingContent) {
        return;
      }
      pendingContent = false;
      void captureCheckpoint(editor, {source: 'auto', skipIfUnchanged: true});
    };

    const schedule = () => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(flush, AUTOSAVE_DEBOUNCE_MS);
    };

    const unregister = editor.registerUpdateListener(({dirtyElements, dirtyLeaves}) => {
      if (dirtyElements.size > 0 || dirtyLeaves.size > 0) {
        pendingContent = true;
        schedule();
      }
    });

    return () => {
      cancelled = true;
      unregister();
      if (timer) {
        clearTimeout(timer);
      }
    };
  }, [editor, activeId]);

  return null;
}
