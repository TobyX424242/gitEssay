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

import {chatPanel, versionsPanel} from '../chat/panelStore';
import useModal from '../hooks/useModal';
import ProjectSwitcher from '../projects/ProjectSwitcher';
import {docFromHash} from '../utils/docSerialization';
import Button from './Button';
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
  const barRef = useRef<HTMLDivElement>(null);

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
          onClick={() => importFile(editor)}
          title="Import"
          aria-label="Import editor state from JSON">
          <i className="import" />
        </button>
        <button
          type="button"
          className="app-bar-btn"
          onClick={() =>
            exportFile(editor, {
              fileName: `gitEssay ${new Date().toISOString()}`,
              source: 'gitEssay',
            })
          }
          title="Export"
          aria-label="Export editor state to JSON">
          <i className="export" />
        </button>
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
          className={`app-bar-btn${versions.open ? ' is-active' : ''}`}
          onClick={() => versionsPanel.toggle()}
          title="Versions"
          aria-label="Toggle version history">
          <i className="versions" />
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
      <div className="Modal__content">
        <Button
          onClick={() => {
            editor.dispatchCommand(CLEAR_EDITOR_COMMAND, undefined);
            editor.focus();
            onClose();
          }}>
          Clear
        </Button>{' '}
        <Button
          onClick={() => {
            editor.focus();
            onClose();
          }}>
          Cancel
        </Button>
      </div>
    </>
  );
}
