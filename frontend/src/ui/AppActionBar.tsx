/**
 * gitEssay — fixed top app bar.
 *
 * Replaces the old bottom-right ActionsPlugin cluster. Holds the special doc
 * actions (Import / Export / Clear / Read-only) on the right, plus toggles for
 * the Versions and AI sidebars. Absorbs the #doc= hash restore and the
 * isEditorEmpty / isEditable tracking that used to live in ActionsPlugin.
 */
import {
  editorStateFromSerializedDocument,
  exportFile,
  importFile,
} from '@lexical/file';
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {
  $getRoot,
  $isParagraphNode,
  CLEAR_EDITOR_COMMAND,
  CLEAR_HISTORY_COMMAND,
  type LexicalEditor,
} from 'lexical';
import {type JSX, useEffect, useLayoutEffect, useRef, useState} from 'react';

import {chatPanel, openLeftDock, useLeftDockTab, versionsPanel} from '../chat/panelStore';
import useModal from '../hooks/useModal';
import ProjectSwitcher from '../projects/ProjectSwitcher';
import {
  importProjectArchive,
  useActiveProject,
} from '../projects/projectStore';
import {docFromHash} from '../utils/docSerialization';
import {exportDocumentAsPdf} from '../utils/pdfExport';
import Button from './Button';
import {DialogActions} from './Dialog';
import {useSidePanel} from './sidePanelStore';
import ThemeToggle from './ThemeToggle';
import './appBar.css';

export default function AppActionBar(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [isEditable, setIsEditable] = useState(() => editor.isEditable());
  const [isEditorEmpty, setIsEditorEmpty] = useState(true);
  const [modal, showModal] = useModal();
  const chat = useSidePanel(chatPanel);
  const versions = useSidePanel(versionsPanel);
  const leftTab = useLeftDockTab();
  const barRef = useRef<HTMLDivElement>(null);
  const activeProject = useActiveProject();
  const archiveInputRef = useRef<HTMLInputElement>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);

  // Download the full project archive via a temporary anchor (the backend
  // sets Content-Disposition with the project-named filename).
  const downloadProjectArchive = () => {
    if (!activeProject) {
      return;
    }
    const a = document.createElement('a');
    a.href = `/api/projects/${activeProject.id}/export`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const onArchivePicked = async (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = event.target.files?.[0];
    event.target.value = ''; // allow re-picking the same file
    if (!file) {
      return;
    }
    setArchiveBusy(true);
    try {
      const imported = await importProjectArchive(file);
      showModal('Project imported', onClose => (
        <>
          The archive was restored as project <strong>{imported.name}</strong>{' '}
          and is now active.
          <DialogActions>
            <Button primary onClick={onClose}>
              OK
            </Button>
          </DialogActions>
        </>
      ));
    } catch (err) {
      showModal('Import failed', onClose => (
        <>
          {err instanceof Error ? err.message : String(err)}
          <DialogActions>
            <Button primary onClick={onClose}>
              OK
            </Button>
          </DialogActions>
        </>
      ));
    } finally {
      setArchiveBusy(false);
    }
  };

  // Publish the app bar's live height so the sticky formatting toolbar (and
  // anything else that uses --app-bar-h) sticks just below it. The bar grows
  // when its overflow row wrap-expands (⋮); this keeps the toolbar tracking.
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) {
      return;
    }
    const sync = () => {
      const h = bar.getBoundingClientRect().height;
      if (h > 0) {
        document.documentElement.style.setProperty('--app-bar-h', `${h}px`);
      }
    };
    const ro = new ResizeObserver(sync);
    ro.observe(bar);
    sync();
    return () => {
      ro.disconnect();
      document.documentElement.style.removeProperty('--app-bar-h');
    };
  }, []);

  // Restore editor state from a #doc= share hash if present.
  useEffect(() => {
    docFromHash(window.location.hash).then(doc => {
      if (doc && doc.source === 'Playground') {
        editor.setEditorState(editorStateFromSerializedDocument(editor, doc));
        editor.dispatchCommand(CLEAR_HISTORY_COMMAND, undefined);
      }
    });
  }, [editor]);

  useEffect(() => {
    return editor.registerEditableListener(setIsEditable);
  }, [editor]);

  useEffect(() => {
    return editor.registerUpdateListener(() => {
      editor.read('latest', () => {
        const root = $getRoot();
        const children = root.getChildren();
        if (children.length > 1) {
          setIsEditorEmpty(false);
          return;
        }
        if ($isParagraphNode(children[0])) {
          setIsEditorEmpty(children[0].getChildren().length === 0);
        } else {
          setIsEditorEmpty(false);
        }
      });
    });
  }, [editor]);

  return (
    <div className="app-bar" ref={barRef}>
      <div className="app-bar-left">
        <span className="app-bar-title">gitEssay</span>
        <ProjectSwitcher />
      </div>
      <div className="app-bar-actions">
        <button
          type="button"
          className="app-bar-btn"
          disabled={archiveBusy}
          onClick={() =>
            showModal(
              'Import',
              onClose => (
                <OptionList
                  onClose={onClose}
                  items={[
                    {
                      label: 'Document only (.json)',
                      desc: 'Load a single document file into the editor.',
                      onSelect: () => importFile(editor),
                    },
                    {
                      label: 'Project archive (.zip)',
                      desc: 'Restore a full project — document, versions, chat and literature.',
                      onSelect: () => archiveInputRef.current?.click(),
                    },
                  ]}
                />
              ),
              true,
            )
          }
          title="Import"
          aria-label="Import">
          <i className="import" />
        </button>
        <button
          type="button"
          className="app-bar-btn"
          onClick={() =>
            showModal(
              'Export',
              onClose => (
                <OptionList
                  onClose={onClose}
                  items={[
                    {
                      label: 'Document only (.json)',
                      desc: 'Save just this document — you can re-import it later.',
                      onSelect: () =>
                        exportFile(editor, {
                          fileName: `gitEssay ${new Date().toISOString()}`,
                          source: 'gitEssay',
                        }),
                    },
                    {
                      label: 'PDF (.pdf)',
                      desc: 'A printable snapshot of this document.',
                      disabled: isEditorEmpty,
                      onSelect: () =>
                        exportDocumentAsPdf(
                          editor,
                          activeProject?.name ?? 'gitEssay document',
                        ),
                    },
                    {
                      label: 'Project archive (.zip)',
                      desc: 'Full backup of the active project — document, versions, chat and literature.',
                      disabled: !activeProject,
                      onSelect: downloadProjectArchive,
                    },
                  ]}
                />
              ),
              true,
            )
          }
          title="Export"
          aria-label="Export">
          <i className="export" />
        </button>
        <input
          ref={archiveInputRef}
          type="file"
          accept=".zip,application/zip"
          style={{display: 'none'}}
          onChange={onArchivePicked}
        />
        <button
          type="button"
          className="app-bar-btn"
          disabled={isEditorEmpty}
          onClick={() => {
            showModal('Clear editor', onClose => (
              <ShowClearDialog editor={editor} onClose={onClose} />
            ));
          }}
          title="Clear"
          aria-label="Clear editor contents">
          <i className="clear" />
        </button>
        <button
          type="button"
          className="app-bar-btn"
          onClick={() => editor.setEditable(!editor.isEditable())}
          title="Read-Only Mode"
          aria-label={`${!isEditable ? 'Unlock' : 'Lock'} read-only mode`}>
          <i className={!isEditable ? 'unlock' : 'lock'} />
        </button>
        <span className="app-bar-divider" />
        <button
          type="button"
          className={`app-bar-btn${versions.open && leftTab === 'versions' ? ' is-active' : ''}`}
          onClick={() => {
            if (versions.open && leftTab === 'versions') {
              versionsPanel.close();
            } else {
              openLeftDock('versions');
            }
          }}
          title="Versions"
          aria-label="Toggle version history">
          <i className="versions" />
        </button>
        <button
          type="button"
          className={`app-bar-btn${versions.open && leftTab === 'literature' ? ' is-active' : ''}`}
          onClick={() => {
            if (versions.open && leftTab === 'literature') {
              versionsPanel.close();
            } else {
              openLeftDock('literature');
            }
          }}
          title="Literature"
          aria-label="Toggle literature library">
          <i className="literature" />
        </button>
        <button
          type="button"
          className={`app-bar-btn${chat.open ? ' is-active' : ''}`}
          onClick={() => chatPanel.toggle()}
          title="AI chat"
          aria-label="Toggle AI chat sidebar">
          <i className="rewrite" />
        </button>
        <span className="app-bar-divider" />
        <ThemeToggle />
      </div>
      {modal}
    </div>
  );
}

type OptionItem = {
  label: string;
  desc: string;
  onSelect: () => void;
  disabled?: boolean;
};

/** Option rows inside an Import/Export modal window (useModal chrome, same
 * look as the Clear dialog). Picking an option closes the modal first. */
function OptionList({
  items,
  onClose,
}: {
  items: OptionItem[];
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="app-bar-option-list">
      {items.map(item => (
        <button
          key={item.label}
          type="button"
          className="app-bar-option"
          disabled={item.disabled}
          onClick={() => {
            onClose();
            item.onSelect();
          }}>
          <span className="app-bar-option-label">{item.label}</span>
          <span className="app-bar-option-desc">{item.desc}</span>
        </button>
      ))}
    </div>
  );
}

function ShowClearDialog({
  editor,
  onClose,
}: {
  editor: LexicalEditor;
  onClose: () => void;
}): JSX.Element {
  return (
    <>
      Are you sure you want to clear the editor?
      <DialogActions>
        <Button
          onClick={() => {
            editor.focus();
            onClose();
          }}>
          Cancel
        </Button>
        <Button
          primary
          onClick={() => {
            editor.dispatchCommand(CLEAR_EDITOR_COMMAND, undefined);
            editor.focus();
            onClose();
          }}>
          Clear
        </Button>
      </DialogActions>
    </>
  );
}
