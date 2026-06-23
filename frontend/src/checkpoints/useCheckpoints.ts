/**
 * gitEssay — React binding to the checkpoint service. Re-renders the list +
 * current pointer whenever the store changes (capture/restore).
 */
import {type LexicalEditor} from 'lexical';
import {useCallback, useEffect, useSyncExternalStore, useState} from 'react';

import {type Checkpoint} from './db';
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
  const version = useSyncExternalStore(subscribe, getVersion, getVersion);
  const [data, setData] = useState<CheckpointsData>({
    checkpoints: [],
    currentId: null,
  });

  useEffect(() => {
    let alive = true;
    Promise.all([listCheckpoints(), getCurrentId()]).then(([list, currentId]) => {
      if (alive) {
        setData({checkpoints: list, currentId});
      }
    });
    return () => {
      alive = false;
    };
  }, [editor, version]);

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
