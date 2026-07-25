/**
 * gitEssay — AI long-term memory panel (extracted from ChatSidebar).
 *
 * Modal overlay for the AI's long-term, project-scoped memory: an on/off toggle,
 * the list of notes (deletable), and a box to add a note manually. The notes are
 * injected into the agent's system prompt (when on); the agent can also add
 * notes via its `remember` action.
 */
import {type JSX, useState, type KeyboardEvent} from 'react';

import {
  addMemory,
  deleteMemory,
  type Memory,
  setMemoryEnabled,
  useMemoryEnabled,
} from './memories';

/** Group memory notes for the Memory panel: project-wide first, then one
 *  section per literature item (per-paper notes the agent saved). */
function groupMemories(
  memories: Memory[],
): Array<{key: string; title: string | null; notes: Memory[]}> {
  const project = memories.filter(m => !m.literature_id);
  const byLit = new Map<string, {title: string; notes: Memory[]}>();
  for (const m of memories) {
    if (!m.literature_id) {
      continue;
    }
    const g = byLit.get(m.literature_id) ?? {
      title: m.literature_title ?? 'Literature',
      notes: [],
    };
    g.notes.push(m);
    byLit.set(m.literature_id, g);
  }
  const groups: Array<{key: string; title: string | null; notes: Memory[]}> = [];
  if (project.length > 0) {
    groups.push({key: '__project__', title: null, notes: project});
  }
  for (const [lid, g] of byLit) {
    groups.push({key: lid, title: g.title, notes: g.notes});
  }
  return groups;
}

export default function MemoryPanel({
  projectId,
  memories,
  onClose,
}: {
  projectId: string;
  memories: Memory[];
  onClose: () => void;
}): JSX.Element {
  const enabled = useMemoryEnabled();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);

  const add = async () => {
    const t = text.trim();
    if (!t) {
      return;
    }
    setSaving(true);
    try {
      await addMemory(projectId, t);
      setText('');
    } finally {
      setSaving(false);
    }
  };

  const onTextKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void add();
    }
  };

  return (
    <div className="mem-overlay" onClick={onClose}>
      <div
        className="mem-panel"
        role="dialog"
        aria-label="AI long-term memory"
        onClick={e => e.stopPropagation()}>
        <header className="mem-header">
          <span className="mem-title">Memory</span>
          <button
            type="button"
            className="mem-close"
            onClick={onClose}
            aria-label="Close">
            ✕
          </button>
        </header>

        <div className="mem-toggle-row">
          <label className="mem-switch">
            <input
              type="checkbox"
              checked={enabled}
              onChange={e => setMemoryEnabled(e.target.checked)}
            />
            <span className="mem-switch-track" />
          </label>
          <div className="mem-toggle-text">
            <div className="mem-toggle-label">Long-term memory</div>
            <div className="mem-toggle-hint">
              {enabled
                ? 'The AI reads these notes before responding and can save new ones.'
                : 'The AI will not read or save memory.'}
            </div>
          </div>
        </div>

        <div className="mem-list">
          {memories.length === 0 && (
            <div className="mem-empty">
              No notes yet. The AI saves important context here as it works —
              including notes on uploaded papers.
            </div>
          )}
          {groupMemories(memories).map(group => (
            <div className="mem-group" key={group.key}>
              {group.title !== null && (
                <div className="mem-group-title" title={group.title}>
                  📄 {group.title}
                </div>
              )}
              {group.notes.map(m => (
                <div className="mem-item" key={m.id}>
                  <div className="mem-item-body">{m.content}</div>
                  <button
                    type="button"
                    className="mem-item-del"
                    title="Delete note"
                    aria-label="Delete note"
                    onClick={() => void deleteMemory(m.id)}>
                    ✕
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>

        <div className="mem-add">
          <textarea
            className="mem-add-input"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={onTextKey}
            placeholder="Add a note for the AI… (⌘/Ctrl-Enter)"
            rows={2}
          />
          <button
            type="button"
            className="cp-button mem-add-btn"
            disabled={saving || !text.trim()}
            onClick={() => void add()}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}
