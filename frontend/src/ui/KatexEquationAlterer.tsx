/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 */

import type {JSX} from 'react';

import './KatexEquationAlterer.css';

import {useLexicalComposerContext} from '@lexical/react/LexicalComposerContext';
import {LexicalErrorBoundary} from '@lexical/react/LexicalErrorBoundary';
import * as React from 'react';
import {useCallback, useState} from 'react';

import Button from '../ui/Button';
import KatexRenderer from './KatexRenderer';

type Props = {
  initialEquation?: string;
  onConfirm: (equation: string, inline: boolean, latex: boolean) => void;
};

export default function KatexEquationAlterer({
  onConfirm,
  initialEquation = '',
}: Props): JSX.Element {
  const [editor] = useLexicalComposerContext();
  const [equation, setEquation] = useState<string>(initialEquation);
  // LaTeX on (default): the content is parsed/rendered by KaTeX. Off: the
  // content is kept as plain text and shown verbatim.
  const [latex, setLatex] = useState<boolean>(true);

  // The dialog always inserts a DISPLAY (block) equation: there is no
  // "one line" option anymore — a single-line input can't hold multi-line
  // LaTeX (\begin{equation}…\end{equation} etc.) and silently broke it.
  const onClick = useCallback(() => {
    onConfirm(equation, false, latex);
  }, [onConfirm, equation, latex]);

  return (
    <>
      <div className="KatexEquationAlterer_defaultRow">
        <span>LaTeX</span>
        <label
          className="mem-switch KatexEquationAlterer_switch"
          title={
            latex
              ? 'LaTeX on — the content is rendered by KaTeX'
              : 'LaTeX off — the content is shown as plain text'
          }>
          <input
            type="checkbox"
            checked={latex}
            onChange={() => setLatex(v => !v)}
            data-test-id="equation-latex-checkbox"
          />
          <span className="mem-switch-track" />
        </label>
      </div>
      <div className="KatexEquationAlterer_defaultRow">Equation </div>
      <div className="KatexEquationAlterer_centerRow">
        <textarea
          onChange={event => {
            setEquation(event.target.value);
          }}
          value={equation}
          className="KatexEquationAlterer_textArea"
          data-test-id="equation-input"
          rows={4}
        />
      </div>
      <div className="KatexEquationAlterer_defaultRow">Visualization </div>
      {latex ? (
        <div className="KatexEquationAlterer_preview">
          <LexicalErrorBoundary onError={e => editor._onError(e)} fallback={null}>
            <KatexRenderer
              equation={equation}
              inline={false}
              onDoubleClick={() => null}
            />
          </LexicalErrorBoundary>
        </div>
      ) : (
        <div className="KatexEquationAlterer_preview KatexEquationAlterer_plainPreview">
          {equation || ' '}
        </div>
      )}
      <div className="KatexEquationAlterer_dialogActions">
        <Button primary onClick={onClick} data-test-id="equation-submit-btn">
          Confirm
        </Button>
      </div>
    </>
  );
}
