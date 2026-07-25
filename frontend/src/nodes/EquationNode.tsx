/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {
  EditorConfig,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical';
import type {JSX} from 'react';

import katex from 'katex';
import {$applyNodeReplacement, DecoratorNode, DOMExportOutput} from 'lexical';
import * as React from 'react';

import {b64EncodeUnicode} from '../utils/base64';

const EquationComponent = React.lazy(() => import('./EquationComponent'));

export type SerializedEquationNode = Spread<
  {
    equation: string;
    inline: boolean;
    /** Optional for backward compat: documents saved before this field
     * existed are LaTeX equations (they were always KaTeX-rendered). */
    latex?: boolean;
  },
  SerializedLexicalNode
>;

export class EquationNode extends DecoratorNode<JSX.Element> {
  __equation: string;
  __inline: boolean;
  /** true = content is LaTeX and renders via KaTeX; false = plain text. */
  __latex: boolean;

  static getType(): string {
    return 'equation';
  }

  static clone(node: EquationNode): EquationNode {
    return new EquationNode(
      node.__equation,
      node.__inline,
      node.__latex,
      node.__key,
    );
  }

  constructor(equation = '', inline?: boolean, latex?: boolean, key?: NodeKey) {
    super(key);
    this.__equation = equation;
    this.__inline = inline ?? false;
    this.__latex = latex ?? true;
  }

  afterCloneFrom(prevNode: this): void {
    super.afterCloneFrom(prevNode);
    this.__equation = prevNode.__equation;
    this.__inline = prevNode.__inline;
    this.__latex = prevNode.__latex;
  }

  static importJSON(serializedNode: SerializedEquationNode): EquationNode {
    return $createEquationNode(
      serializedNode.equation,
      serializedNode.inline,
      serializedNode.latex ?? true,
    ).updateFromJSON(serializedNode);
  }

  exportJSON(): SerializedEquationNode {
    return {
      ...super.exportJSON(),
      equation: this.getEquation(),
      inline: this.isInline(),
      latex: this.isLatex(),
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement(this.__inline ? 'span' : 'div');
    // EquationNodes should implement `user-action:none` in their CSS to avoid issues with deletion on Android.
    element.className = this.__latex
      ? 'editor-equation'
      : 'editor-equation editor-equation-plain';
    return element;
  }

  exportDOM(): DOMExportOutput {
    const element = document.createElement(this.__inline ? 'span' : 'div');
    // Encode the equation as base64 to avoid issues with special characters.
    // Unicode-safe: raw btoa throws InvalidCharacterError on LaTeX like ∀/∑/α.
    const equation = b64EncodeUnicode(this.__equation);
    element.setAttribute('data-lexical-equation', equation);
    element.setAttribute('data-lexical-inline', `${this.__inline}`);
    element.setAttribute('data-lexical-latex', `${this.__latex}`);
    if (this.__latex) {
      katex.render(this.__equation, element, {
        displayMode: !this.__inline, // true === block display //
        errorColor: '#cc0000',
        output: 'html',
        strict: 'warn',
        throwOnError: false,
        trust: false,
      });
    } else {
      element.textContent = this.__equation;
    }
    return {element};
  }

  updateDOM(prevNode: this): boolean {
    // If the inline/latex property changes, replace the element
    return (
      this.__inline !== prevNode.__inline || this.__latex !== prevNode.__latex
    );
  }

  getTextContent(): string {
    return this.getEquation();
  }

  isInline(): boolean {
    return this.getLatest().__inline;
  }

  isLatex(): boolean {
    return this.getLatest().__latex;
  }

  setLatex(latex: boolean): this {
    const writable = this.getWritable();
    writable.__latex = latex;
    return writable;
  }

  getEquation(): string {
    return this.getLatest().__equation;
  }

  setEquation(equation: string): this {
    const writable = this.getWritable();
    writable.__equation = equation;
    return writable;
  }

  decorate(): JSX.Element {
    return (
      <EquationComponent
        equation={this.__equation}
        inline={this.__inline}
        latex={this.__latex}
        nodeKey={this.__key}
      />
    );
  }
}

export function $createEquationNode(
  equation = '',
  inline = false,
  latex = true,
): EquationNode {
  const equationNode = new EquationNode(equation, inline, latex);
  return $applyNodeReplacement(equationNode);
}

export function $isEquationNode(
  node: LexicalNode | null | undefined,
): node is EquationNode {
  return node instanceof EquationNode;
}
