/**
 * gitEssay — project switcher (app bar).
 *
 * The bar button shows the active project and opens a small modal window
 * (same useModal chrome as the Clear/Import/Export dialogs): click a project
 * to switch, inline rename (✎), delete (✕), and create a project from the
 * footer row. The active project drives the editor doc + checkpoint DAG +
 * conversations.
 */
import {type JSX, useState} from 'react';

import useModal from '../hooks/useModal';
import Button from '../ui/Button';
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
  const [modal, showModal] = useModal();
  const active = projects.find(p => p.id === activeId);

  return (
    <div className="proj-switcher">
      <button
        type="button"
        className="proj-switcher-btn"
        onClick={() =>
          showModal(
            'Projects',
            onClose => <ProjectList onClose={onClose} />,
            true,
          )
        }
        title="Switch project"
        aria-label="Switch project">
        <span className="proj-switcher-title">
          {active?.name ?? 'Projects'}
        </span>
        <span className="proj-switcher-chev">▾</span>
      </button>
      {modal}
    </div>
  );
}

function ProjectList({onClose}: {onClose: () => void}): JSX.Element {
  const {projects, activeId} = useProjects();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [newName, setNewName] = useState('');

  const commitRename = (id: string, fallback: string) => {
    const value = name.trim();
    setRenaming(null);
    if (value && value !== fallback) {
      void renameProject(id, value);
    }
  };

  const onCreate = () => {
    const value = newName.trim();
    setNewName('');
    // createProject makes the new project active — close the window on it.
    void createProject(value || undefined).then(onClose);
  };

  return (
    <>
      <div className="proj-modal-list">
        {projects.length === 0 && (
          <div className="proj-switcher-empty">No projects yet.</div>
        )}
        {projects.map(p => (
          <div
            key={p.id}
            className={`proj-item${p.id === activeId ? ' is-active' : ''}`}
            onClick={() => {
              if (renaming !== p.id) {
                void setActiveProject(p.id);
                onClose();
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
      <div className="proj-new-row">
        <input
          className="proj-new-input"
          placeholder="New project name"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              onCreate();
            }
          }}
        />
        <Button primary onClick={onCreate}>
          New project
        </Button>
      </div>
    </>
  );
}
