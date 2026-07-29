/**
 * gitEssay — CheckpointPlugin.
 *
 * Wires the editor to the backend-backed checkpoint store, scoped to the active
 * project:
 *  - On mount / when the active project changes: fetch that project's current
 *    checkpoint and load it into the editor. A `cancelled` guard discards a
 *    stale fetch if the user switches projects again before it resolves (so a
 *    slow A→B→C switch can't clobber the editor with A's content).
 *  - On every content-changing update: debounce (3s idle) an auto-save to the
 *    active project's rolling auto slot (projectId captured per-effect so the
 *    save can never land in the wrong project). `skipIfUnchanged` suppresses
 *    no-op captures (incl. the update fired by the load itself).
 */
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {CLEAR_HISTORY_COMMAND} from 'lexical';
import {useEffect} from 'react';

import {useActiveProjectId} from '../projects/projectStore';
import {captureCheckpoint, getCurrentCheckpoint} from '../checkpoints/service';

const AUTOSAVE_DEBOUNCE_MS = 3000;

export default function CheckpointPlugin(): null {
  const [editor] = useLexicalComposerContext();
  const activeId = useActiveProjectId();

  // Flush on page close/reload to prevent losing the debounce window.
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!activeId) return;
      // Synchronous capture — beforeunload handlers must complete before unload.
      const state = editor.getEditorState();
      const serialized = JSON.stringify(state.toJSON());
      // Fire-and-forget fetch with keepalive so it completes even after unload.
      void fetch(`/api/projects/${activeId}/checkpoints`, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({source: 'auto', state: serialized}),
        keepalive: true,
      });
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [editor, activeId]);

  useEffect(() => {
    if (!activeId) {
      return;
    }
    let cancelled = false;

    // Load the project's current doc; discard if superseded by a later switch.
    void getCurrentCheckpoint(activeId).then(cp => {
      if (cancelled || !cp) {
        return;
      }
      editor.setEditorState(editor.parseEditorState(cp.state));
      editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingContent = false;

    const flush = () => {
      timer = null;
      if (cancelled || !pendingContent) {
        return;
      }
      pendingContent = false;
      void captureCheckpoint(editor, {
        source: 'auto',
        skipIfUnchanged: true,
        projectId: activeId,
      });
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
      // Flush any pending edits before cleanup — project switch or unmount
      // within the 3s debounce window would otherwise lose up to 3s of typing.
      if (pendingContent) {
        pendingContent = false;
        void captureCheckpoint(editor, {
          source: 'auto',
          skipIfUnchanged: true,
          projectId: activeId,
        });
      }
    };
  }, [editor, activeId]);

  return null;
}
