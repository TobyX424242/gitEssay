/**
 * gitEssay — editor mount.
 *
 * Forked from lexical-playground/src/Editor.tsx. Stripped: collab provider,
 * EmojiPicker/AutoEmbed/Mentions/SpeechToText/Comment/Excalidraw mounts, the
 * CharacterLimit demo, TableOfContents/ContextMenu/TreeView (optional panes,
 * re-enable behind flags later), and the settings system. Mounts only the
 * core editing plugins.
 */
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {TabIndentationPlugin} from '@lexical/react/LexicalTabIndentationPlugin';
import {CAN_USE_DOM} from '@lexical/utils';
import {type JSX, useEffect, useState} from 'react';

import CodeActionMenuPlugin from './plugins/CodeActionMenuPlugin';
import ComponentPickerPlugin from './plugins/ComponentPickerPlugin';
import DraggableBlockPlugin from './plugins/DraggableBlockPlugin';
import FloatingLinkEditorPlugin from './plugins/FloatingLinkEditorPlugin';
import FloatingTextFormatToolbarPlugin from './plugins/FloatingTextFormatToolbarPlugin';
import ShortcutsPlugin from './plugins/ShortcutsPlugin';
import TableCellActionMenuPlugin from './plugins/TableActionMenuPlugin';
import TableCellResizer from './plugins/TableCellResizer';
import TableHoverActionsV2Plugin from './plugins/TableHoverActionsV2Plugin';
import TableScrollShadowPlugin from './plugins/TableScrollShadowPlugin';
import CheckpointPlugin from './plugins/CheckpointPlugin';
import ToolbarPlugin from './plugins/ToolbarPlugin';
import {CompareSurface} from './ui/CompareMode';
import ContentEditable from './ui/ContentEditable';

export default function Editor(): JSX.Element {
  const placeholder = 'Start writing…';
  const [floatingAnchorElem, setFloatingAnchorElem] =
    useState<HTMLDivElement | null>(null);
  const [isSmallWidthViewport, setIsSmallWidthViewport] =
    useState<boolean>(false);
  const [editor] = useLexicalComposerContext();
  const [activeEditor, setActiveEditor] = useState(editor);
  const [isLinkEditMode, setIsLinkEditMode] = useState<boolean>(false);

  const onRef = (el: HTMLDivElement) => {
    if (el !== null) {
      setFloatingAnchorElem(el);
    }
  };

  useEffect(() => {
    const updateViewPortWidth = () => {
      const next =
        CAN_USE_DOM && window.matchMedia('(max-width: 1025px)').matches;
      setIsSmallWidthViewport(prev => (prev !== next ? next : prev));
    };
    updateViewPortWidth();
    window.addEventListener('resize', updateViewPortWidth);
    return () => window.removeEventListener('resize', updateViewPortWidth);
  }, []);

  return (
    <>
      <ToolbarPlugin
        editor={editor}
        activeEditor={activeEditor}
        setActiveEditor={setActiveEditor}
        setIsLinkEditMode={setIsLinkEditMode}
      />
      <ShortcutsPlugin
        editor={activeEditor}
        setIsLinkEditMode={setIsLinkEditMode}
      />
      <div className="editor-container">
        <ComponentPickerPlugin />
        <CheckpointPlugin />
        <div className="editor-scroller">
          <div className="editor" ref={onRef}>
            <ContentEditable placeholder={placeholder} />
          </div>
        </div>
        <TableCellResizer />
        <TableScrollShadowPlugin />
        <TabIndentationPlugin maxIndent={7} />
        {floatingAnchorElem && (
          <>
            <FloatingLinkEditorPlugin
              anchorElem={floatingAnchorElem}
              isLinkEditMode={isLinkEditMode}
              setIsLinkEditMode={setIsLinkEditMode}
            />
            <TableCellActionMenuPlugin
              anchorElem={floatingAnchorElem}
              cellMerge={true}
            />
          </>
        )}
        {floatingAnchorElem && !isSmallWidthViewport && (
          <>
            <DraggableBlockPlugin anchorElem={floatingAnchorElem} />
            <CodeActionMenuPlugin anchorElem={floatingAnchorElem} />
            <TableHoverActionsV2Plugin anchorElem={floatingAnchorElem} />
            <FloatingTextFormatToolbarPlugin
              anchorElem={floatingAnchorElem}
              setIsLinkEditMode={setIsLinkEditMode}
            />
          </>
        )}
        <CompareSurface />
      </div>
    </>
  );
}
