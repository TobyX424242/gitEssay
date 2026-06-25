/**
 * gitEssay — application root.
 *
 * Forked from lexical-playground/src/App.tsx. Stripped: the entire
 * settings/SettingsContext system, the Yjs/collaboration cluster, the demo
 * plugins (Poll/Tweet/YouTube/Figma/Excalidraw/Sticky/Emoji/Mentions/etc.),
 * the dev tools (DocsPlugin/PasteLogPlugin/TestRecorderPlugin/TypingPerf),
 * shadow-DOM, and the GitHub corner. Config that the playground drove via
 * reactive settings signals is now baked directly into the extension defs
 * (this is a single-user app with no settings panel).
 */
import {$isCodeNode} from '@lexical/code';
import {
  $defaultShouldInsertAfter,
  AutoFocusExtension,
  ClearEditorExtension,
  ClickAfterLastBlockExtension,
  DecoratorTextExtension,
  HorizontalRuleExtension,
  SelectBlockExtension,
  WatchEditableExtension,
} from '@lexical/extension';
import {HistoryExtension} from '@lexical/history';
import {ClickableLinkExtension, LinkExtension} from '@lexical/link';
import {CheckListExtension, ListExtension} from '@lexical/list';
import {LexicalExtensionComposer} from '@lexical/react/LexicalExtensionComposer';
import {RichTextExtension} from '@lexical/rich-text';
import {TableExtension} from '@lexical/table';
import {configExtension, defineExtension} from 'lexical';
import {type JSX, useEffect} from 'react';

import {loadAISettings} from './rewrite/aiSettings';
import {loadProjects} from './projects/projectStore';
import {ToolbarContext} from './context/ToolbarContext';
import ChatSidebar from './chat/ChatSidebar';
import Editor from './Editor';
import AppActionBar from './ui/AppActionBar';
import CheckpointsSidebar from './ui/CheckpointsSidebar';
import {CompareModeProvider} from './ui/CompareMode';
import {PlaygroundImportExtension} from './nodes/PlaygroundImportExtension';
import PlaygroundNodes from './nodes/PlaygroundNodes';
import {PlaygroundDOMRenderExtension} from './PlaygroundDOMRenderExtension';
import {PlaygroundAutoLinkExtension} from './plugins/AutoLinkExtension';
import {CodeHighlightExtension} from './plugins/CodeHighlightExtension';
import {CitationsExtension} from './plugins/CitationsExtension';
import {CollapsibleExtension} from './plugins/CollapsibleExtension';
import {DragDropPasteExtension} from './plugins/DragDropPasteExtension';
import {EquationsExtension} from './plugins/EquationsExtension';
import {ImagesExtension} from './plugins/ImagesExtension';
import {PageBreakExtension} from './plugins/PageBreakExtension';
import {PlaygroundMarkdownShortcutsExtension} from './plugins/MarkdownShortcutsExtension';
import {TabFocusExtension} from './plugins/TabFocusExtension';
import {TerseExportExtension} from './plugins/TerseExportExtension';
import PlaygroundEditorTheme from './themes/PlaygroundEditorTheme';
import './themes/darkMode.css';
import ThemeToggle from './ui/ThemeToggle';
import './ui/sidebars.css';
import {validateUrl} from './utils/url';

/** Rich-text-only feature set: tables, images, equations, lists, code, etc. */
const PlaygroundRichTextExtension = /* @__PURE__ */ defineExtension({
  dependencies: [
    /* @__PURE__ */ configExtension(RichTextExtension, {
      escapeFormatTriggers: {
        code: {arrow: true, click: true, enter: true, onlyAtBoundary: true},
      },
    }),
    /* @__PURE__ */ configExtension(TableExtension, {
      hasCellMerge: true,
      hasCellBackgroundColor: true,
      hasHorizontalScroll: true,
    }),
    ImagesExtension,
    HorizontalRuleExtension,
    PageBreakExtension,
    TabFocusExtension,
    CollapsibleExtension,
    /* @__PURE__ */ configExtension(CodeHighlightExtension, {mode: 'prism'}),
    /* @__PURE__ */ configExtension(ListExtension, {shouldPreserveNumbering: false}),
    CheckListExtension,
    PlaygroundMarkdownShortcutsExtension,
    EquationsExtension,
    CitationsExtension,
  ],
  name: 'gitEssay/RichText',
});

/** Always-on extensions: history, links, import pipeline, export, selection. */
const AppExtension = /* @__PURE__ */ defineExtension({
  dependencies: [
    AutoFocusExtension,
    ClearEditorExtension,
    DecoratorTextExtension,
    WatchEditableExtension,
    HistoryExtension,
    DragDropPasteExtension,
    /* @__PURE__ */ configExtension(LinkExtension, {validateUrl}),
    PlaygroundAutoLinkExtension,
    ClickableLinkExtension,
    /* @__PURE__ */ configExtension(SelectBlockExtension, {cascadeSelection: true}),
    TerseExportExtension,
    /* @__PURE__ */ configExtension(ClickAfterLastBlockExtension, {
      $shouldInsertAfter: node =>
        $defaultShouldInsertAfter(node) || $isCodeNode(node),
    }),
    PlaygroundImportExtension,
    PlaygroundDOMRenderExtension,
  ],
  name: 'gitEssay',
  namespace: 'gitEssay',
  nodes: PlaygroundNodes,
  theme: PlaygroundEditorTheme,
});

const appExtension = /* @__PURE__ */ defineExtension({
  dependencies: [AppExtension, PlaygroundRichTextExtension],
  name: 'gitEssay/root',
});

export default function App(): JSX.Element {
  // Load the project list (+ resolve active) and AI settings from the backend.
  useEffect(() => {
    void loadProjects();
    void loadAISettings();
  }, []);

  return (
    <LexicalExtensionComposer extension={appExtension} contentEditable={null}>
      <ToolbarContext>
        <CompareModeProvider>
          <AppActionBar />
          <div className="editor-shell">
            <Editor />
          </div>
          <CheckpointsSidebar />
          <ChatSidebar />
          <ThemeToggle />
        </CompareModeProvider>
      </ToolbarContext>
    </LexicalExtensionComposer>
  );
}
