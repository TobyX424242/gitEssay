/**
 * gitEssay — project switcher (app bar).
 *
 * Compact dropdown: switch project, + New (prompts for a name), and per-item
 * inline rename (✎) + delete (✕). The active project drives the editor doc +
 * checkpoint DAG + conversations.
 */
import {type JSX, useState} from 'react';

import {
  createProject,
  deleteProject,
  renameProject,
  setActiveProject,
  useProjects,
} from './projectStore';
import './projects.css';

export default function ProjectSwitcher(): JSX.Element {
  const {projects, activeId} = useProjects();
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const active = projects.find(p => p.id === activeId);

  const close = () => {
    setOpen(false);
    setRenaming(null);
  };

  const commitRename = (id: string, fallback: string) => {
    const value = name.trim();
    setRenaming(null);
    if (value && value !== fallback) {
      void renameProject(id, value);
    }
  };

  const onNew = () => {
    const entered = window.prompt('New project name', 'New project');
    setOpen(false);
    if (entered !== null) {
      void createProject(entered.trim() || undefined);
    }
  };

  return (
    <div className="proj-switcher">
      <button
        type="button"
        className="proj-switcher-btn"
        onClick={() => {
          setRenaming(null);
          setOpen(v => !v);
        }}
        title="Switch project"
        aria-label="Switch project"
        disabled={projects.length === 0}>
        <span className="proj-switcher-title">
          {active?.name ?? 'Projects'}
        </span>
        <span className="proj-switcher-chev">▾</span>
      </button>
      <button
        type="button"
        className="app-bar-btn proj-switcher-new"
        onClick={onNew}
        title="New project"
        aria-label="New project">
        + New
      </button>
      {open && (
        <>
          <div className="proj-switcher-backdrop" onClick={close} />
          <div className="proj-switcher-list" role="menu">
            {projects.length === 0 && (
              <div className="proj-switcher-empty">No projects.</div>
            )}
            {projects.map(p => (
              <div
                key={p.id}
                role="menuitem"
                className={`proj-item${p.id === activeId ? ' is-active' : ''}`}
                onClick={() => {
                  if (renaming !== p.id) {
                    void setActiveProject(p.id);
                    close();
                  }
                }}>
                {renaming === p.id ? (
                  <input
                    className="proj-rename"
                    autoFocus
                    value={name}
                    size={1}
                    onChange={e => setName(e.target.value)}
                    onClick={e => e.stopPropagation()}
                    onKeyDown={e => {
                      if (e.key === 'Enter') {
                        commitRename(p.id, p.name);
                      } else if (e.key === 'Escape') {
                        setRenaming(null);
                      }
                    }}
                    onBlur={() => commitRename(p.id, p.name)}
                  />
                ) : (
                  <span className="proj-item-title">{p.name}</span>
                )}
                <span className="proj-item-actions">
                  {renaming !== p.id && (
                    <button
                      type="button"
                      className="proj-item-btn"
                      title="Rename"
                      aria-label="Rename project"
                      onClick={e => {
                        e.stopPropagation();
                        setRenaming(p.id);
                        setName(p.name);
                      }}>
                      ✎
                    </button>
                  )}
                  {projects.length > 1 && (
                    <button
                      type="button"
                      className="proj-item-btn proj-item-del"
                      title="Delete project"
                      aria-label="Delete project"
                      onClick={e => {
                        e.stopPropagation();
                        if (
                          window.confirm(
                            `Delete project "${p.name}"? Its checkpoints and conversations are removed.`,
                          )
                        ) {
                          void deleteProject(p.id);
                        }
                      }}>
                      ✕
                    </button>
                  )}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
