/**
 * gitEssay — CitationsExtension. Registers the CitationNode, the
 * INSERT_CITATION_COMMAND (insert at cursor OR convert the current text
 * selection into a citation), and the DOM import rule (paste fidelity).
 *
 * INSERT_CITATION_COMMAND payload is optional: if a text range is selected and
 * no label is given, the selected text becomes the citation label (convert);
 * otherwise the given label (or 'cite') is inserted inline (insert).
 */
import {defineImportRule, DOMImportExtension, sel} from '@lexical/html';
import {$insertNodeIntoLeaf, $wrapNodeInElement} from '@lexical/utils';
import {
  $createParagraphNode,
  $getSelection,
  $isRangeSelection,
  $isRootOrShadowRoot,
  COMMAND_PRIORITY_EDITOR,
  configExtension,
  createCommand,
  defineExtension,
  type LexicalCommand,
  type LexicalEditor,
} from 'lexical';
import {type JSX, useState} from 'react';

import {$createCitationNode, CitationNode} from '../../nodes/CitationNode';
import Button from '../../ui/Button';

export interface CitationPayload {
  label?: string;
  citationId?: string;
}

export const INSERT_CITATION_COMMAND: LexicalCommand<CitationPayload | undefined> =
  /* @__PURE__ */ createCommand('INSERT_CITATION_COMMAND');

const CitationImportRule = /* @__PURE__ */ defineImportRule({
  $import: (_ctx, el, $next) => {
    const id = el.getAttribute('data-citation');
    if (!id) {
      return $next();
    }
    const label = el.getAttribute('data-citation-label') || el.textContent || 'cite';
    return [$createCitationNode(label, id)];
  },
  match: sel.tag('span').attr('data-citation', true),
  name: 'gitEssay/citation',
});

export const CitationsExtension = /* @__PURE__ */ defineExtension({
  dependencies: [
    /* @__PURE__ */ configExtension(DOMImportExtension, {
      rules: [CitationImportRule],
    }),
  ],
  name: 'gitEssay/Citations',
  nodes: [CitationNode],
  register: editor =>
    editor.registerCommand<CitationPayload | undefined>(
      INSERT_CITATION_COMMAND,
      payload => {
        const selection = $getSelection();
        const hasRange = $isRangeSelection(selection) && !selection.isCollapsed();
        let label = payload?.label;
        if (!label && hasRange) {
          label = selection.getTextContent();
        }
        const node = $createCitationNode(label || 'cite', payload?.citationId);

        if (hasRange) {
          selection.insertNodes([node]); // convert selection → citation
        } else {
          $insertNodeIntoLeaf(node);
          if ($isRootOrShadowRoot(node.getParent())) {
            $wrapNodeInElement(node, $createParagraphNode).selectEnd();
          }
        }
        return true;
      },
      COMMAND_PRIORITY_EDITOR,
    ),
});

export function InsertCitationDialog({
  activeEditor,
  onClose,
}: {
  activeEditor: LexicalEditor;
  onClose: () => void;
}): JSX.Element {
  const [label, setLabel] = useState('');
  const confirm = () => {
    activeEditor.dispatchCommand(INSERT_CITATION_COMMAND, {
      label: label.trim() || 'cite',
    });
    onClose();
  };
  return (
    <div style={{display: 'flex', flexDirection: 'column', gap: 12}}>
      <input
        className="cp-input"
        autoFocus
        placeholder="Citation text (e.g. Smith 2020, or [1])"
        value={label}
        onChange={e => setLabel(e.target.value)}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            confirm();
          }
        }}
      />
      <div className="Modal__content">
        <Button onClick={confirm}>Insert</Button>{' '}
        <Button onClick={onClose}>Cancel</Button>
      </div>
    </div>
  );
}
