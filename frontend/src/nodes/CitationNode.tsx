/**
 * gitEssay — CitationNode.
 *
 * An atomic inline node (DecoratorNode) that renders a citation marker
 * (e.g. "[1]" or "Smith 2020") as a single indivisible unit — the cursor
 * cannot enter it and a delete removes the whole thing — yet it is editable:
 * double-click opens an inline editor (see CitationComponent). It carries a
 * stable `citationId` (for a future bibliography manager) plus the display
 * label. Mirrors EquationNode. Survives HTML round-trips via data-citation*
 * attributes; survives JSON (checkpoints) via exportJSON/importJSON.
 */
import type {
  DOMExportOutput,
  EditorConfig,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical';
import type {JSX} from 'react';

import {$applyNodeReplacement, DecoratorNode} from 'lexical';
import * as React from 'react';

const CitationComponent = React.lazy(() => import('./CitationComponent'));

export type SerializedCitationNode = Spread<
  {
    label: string;
    citationId: string;
  },
  SerializedLexicalNode
>;

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `cite-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export class CitationNode extends DecoratorNode<JSX.Element> {
  __label: string;
  __citationId: string;

  static getType(): string {
    return 'citation';
  }

  static clone(node: CitationNode): CitationNode {
    return new CitationNode(node.__label, node.__citationId, node.__key);
  }

  constructor(label: string = 'cite', citationId?: string, key?: NodeKey) {
    super(key);
    this.__label = label;
    this.__citationId = citationId ?? genId();
  }

  afterCloneFrom(prev: this): void {
    super.afterCloneFrom(prev);
    this.__label = prev.__label;
    this.__citationId = prev.__citationId;
  }

  static importJSON(serializedNode: SerializedCitationNode): CitationNode {
    return $createCitationNode(
      serializedNode.label,
      serializedNode.citationId,
    ).updateFromJSON(serializedNode);
  }

  exportJSON(): SerializedCitationNode {
    return {
      ...super.exportJSON(),
      label: this.getLabel(),
      citationId: this.__citationId,
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const span = document.createElement('span');
    span.className = 'citation-node';
    return span;
  }

  updateDOM(): false {
    return false;
  }

  exportDOM(): DOMExportOutput {
    const span = document.createElement('span');
    span.setAttribute('data-citation', this.__citationId);
    span.setAttribute('data-citation-label', this.__label);
    span.textContent = this.__label;
    return {element: span};
  }

  getTextContent(): string {
    return this.getLabel();
  }

  isInline(): boolean {
    return true;
  }

  getLabel(): string {
    return this.getLatest().__label;
  }

  setLabel(label: string): this {
    this.getWritable().__label = label;
    return this;
  }

  getCitationId(): string {
    return this.getLatest().__citationId;
  }

  decorate(): JSX.Element {
    return (
      <CitationComponent
        nodeKey={this.__key}
        label={this.__label}
        citationId={this.__citationId}
      />
    );
  }
}

export function $createCitationNode(
  label = 'cite',
  citationId?: string,
): CitationNode {
  return $applyNodeReplacement(new CitationNode(label, citationId));
}

export function $isCitationNode(
  node: LexicalNode | null | undefined,
): node is CitationNode {
  return node instanceof CitationNode;
}
