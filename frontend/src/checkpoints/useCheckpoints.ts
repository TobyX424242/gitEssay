/**
 * gitEssay — React binding to the checkpoint service, scoped to the active
 * project. Re-renders the list + current pointer on capture/restore and when
 * the active project changes.
 */
import {type LexicalEditor} from 'lexical';
import {useCallback, useEffect, useState, useSyncExternalStore} from 'react';

import {useActiveProjectId} from '../projects/projectStore';
import type {Checkpoint} from './types';
import {
  captureCheckpoint,
  getCurrentId,
  getVersion,
  listCheckpoints,
  restoreCheckpoint,
  subscribe,
} from './service';

interface CheckpointsData {
  checkpoints: Checkpoint[];
  currentId: string | null;
}

export function useCheckpoints(editor: LexicalEditor): CheckpointsData & {
  save: (label?: string) => Promise<void>;
  restore: (id: string) => Promise<void>;
} {
  const activeId = useActiveProjectId();
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);
  const [data, setData] = useState<CheckpointsData>({
    checkpoints: [],
    currentId: null,
  });

  useEffect(() => {
    if (!activeId) {
      setData({checkpoints: [], currentId: null});
      return;
    }
    let alive = true;
    Promise.all([listCheckpoints(activeId), getCurrentId(activeId)]).then(
      ([list, currentId]) => {
        if (alive) {
          setData({checkpoints: list, currentId});
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [activeId, version]);

  const save = useCallback(
    (label?: string) => captureCheckpoint(editor, {source: 'manual', label}),
    [editor],
  );
  const restore = useCallback(
    (id: string) => restoreCheckpoint(editor, id),
    [editor],
  );

  return {...data, save, restore};
}
