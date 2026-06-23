/**
 * gitEssay — citation badge + inline editor. Renders the citation label as a
 * styled pill; double-click to edit the label in place (Enter/blur commits,
 * Escape cancels). Rendered into the CitationNode's host <span> via decorate.
 */
import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {$getNodeByKey} from 'lexical';
import {type JSX, useEffect, useRef, useState} from 'react';

import {$isCitationNode} from './CitationNode';
import './citation.css';

export default function CitationComponent({
  nodeKey,
  label,
  citationId,
}: {
  nodeKey: string;
  label: string;
  citationId: string;
}): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const commit = () => {
    const next = value.trim() || label;
    editor.update(() => {
      const node = $getNodeByKey(nodeKey);
      if ($isCitationNode(node)) {
        node.setLabel(next);
      }
    });
    setEditing(false);
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="citation-input"
        value={value}
        size={Math.max(value.length, 3)}
        onChange={e => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <span
      className="citation-badge"
      title={`citation (${citationId}) — double-click to edit`}
      onDoubleClick={e => {
        e.stopPropagation();
        setValue(label);
        setEditing(true);
      }}>
      {label}
    </span>
  );
}
