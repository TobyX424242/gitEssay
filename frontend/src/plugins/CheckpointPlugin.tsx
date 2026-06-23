/**
 * gitEssay — CheckpointPlugin.
 *
 * Side-effect-only plugin that wires the canonical commit signal
 * (`editor.registerUpdateListener`) to the checkpoint store:
 *  - On mount: `bootstrapDoc` (transactional/idempotent — safe under React
 *    StrictMode's dev double-mount; won't create a duplicate 'init') restores
 *    the current checkpoint so the doc persists across reloads.
 *  - On every content-changing update: debounce (3s idle) an auto-save into the
 *    single rolling auto slot (source 'auto'). `skipIfUnchanged` suppresses
 *    no-op captures (incl. the update fired by bootstrap/restore itself).
 *    Selection-only updates are ignored.
 */
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {useEffect} from 'react';

import {bootstrapDoc, captureCheckpoint} from '../checkpoints/service';

const AUTOSAVE_DEBOUNCE_MS = 3000;

export default function CheckpointPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let pendingContent = false;
    let cancelled = false;

    void bootstrapDoc(editor);

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
  }, [editor]);

  return null;
}
