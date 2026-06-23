/**
 * gitEssay — ActionsPlugin (bottom-right action buttons).
 *
 * Forked from lexical-playground/src/plugins/ActionsPlugin. Stripped: the
 * markdown/html live-mode toggle (entangled with the removed PagesExtension),
 * speech-to-text, the collaboration connect/versions buttons, share-via-URL,
 * and flash messages. Keeps the genuinely useful per-doc actions: import and
 * export the canonical JSON editor state, clear, and read-only lock.
 * (Markdown/HTML *export* will return in a later phase via the
 * $convertToMarkdownString / $generateHtmlFromNodes helpers directly.)
 */
import type {LexicalEditor} from 'lexical';
import type {JSX} from 'react';

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
} from 'lexical';
import {useEffect, useState} from 'react';

import useModal from '../../hooks/useModal';
import Button from '../../ui/Button';
import CheckpointsPanel from '../../ui/CheckpointsPanel';
import {docFromHash} from '../../utils/docSerialization';

export default function ActionsPlugin(): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [isEditable, setIsEditable] = useState(() => editor.isEditable());
  const [isEditorEmpty, setIsEditorEmpty] = useState(true);
  const [modal, showModal] = useModal();
  const [showCheckpoints, setShowCheckpoints] = useState(false);

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
    <div className="actions">
      <button
        className="action-button import"
        onClick={() => importFile(editor)}
        title="Import"
        aria-label="Import editor state from JSON">
        <i className="import" />
      </button>
      <button
        className="action-button export"
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
        className="action-button clear"
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
        className={`action-button ${!isEditable ? 'unlock' : 'lock'}`}
        onClick={() => {
          editor.setEditable(!editor.isEditable());
        }}
        title="Read-Only Mode"
        aria-label={`${!isEditable ? 'Unlock' : 'Lock'} read-only mode`}>
        <i className={!isEditable ? 'unlock' : 'lock'} />
      </button>
      <button
        className="action-button"
        onClick={() => setShowCheckpoints(true)}
        title="Checkpoints"
        aria-label="Open checkpoints / version history">
        <i className="versions" />
      </button>
      {showCheckpoints && (
        <CheckpointsPanel onClose={() => setShowCheckpoints(false)} />
      )}
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
