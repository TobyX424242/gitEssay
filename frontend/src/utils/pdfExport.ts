/**
 * gitEssay — PDF export of the current document.
 *
 * Renders the Lexical document to standalone HTML (equations pre-rendered by
 * KaTeX at export time) and opens it in a print window, where the browser's
 * own "Save as PDF" produces a true vector-text PDF — no heavy server-side
 * HTML→PDF dependency, and identical output in dev, Docker and desktop builds.
 */
import {$generateHtmlFromNodes} from '@lexical/html';
import katexCss from 'katex/dist/katex.min.css?inline';
import type {LexicalEditor} from 'lexical';

const PRINT_CSS = `
  @page { margin: 2.2cm 2cm; }
  body {
    font-family: Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif;
    font-size: 12pt;
    line-height: 1.65;
    color: #111;
    max-width: 780px;
    margin: 0 auto;
  }
  h1 { font-size: 1.7em; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; }
  h4, h5, h6 { font-size: 1.05em; }
  img { max-width: 100%; height: auto; }
  pre, code { font-family: 'SF Mono', Menlo, Consolas, monospace; }
  pre {
    background: #f4f4f4; padding: 10px 12px; border-radius: 6px;
    white-space: pre-wrap; word-break: break-word; font-size: 10pt;
  }
  blockquote {
    margin: 0 0 0 4px; padding-left: 14px;
    border-left: 3px solid #ccc; color: #444;
  }
  table { border-collapse: collapse; width: 100%; }
  td, th { border: 1px solid #bbb; padding: 5px 8px; }
  a { color: #1a56db; text-decoration: none; }
  .editor-equation { text-align: center; }
  .editor-equation.editor-equation-plain { font-family: inherit; }
  mark { padding: 0 1px; }
  @media print { a { color: inherit; } }
`;

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function exportDocumentAsPdf(editor: LexicalEditor, title: string): void {
  const body = editor.read(() => $generateHtmlFromNodes(editor));
  const win = window.open('', '_blank');
  if (!win) {
    throw new Error('the browser blocked the print window (allow pop-ups)');
  }
  win.document.write(`<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(title)}</title>
    <style>${katexCss}</style>
    <style>${PRINT_CSS}</style>
  </head>
  <body>${body}</body>
</html>`);
  win.document.close();
  win.focus();
  // Give KaTeX fonts and any images a moment to load before opening the
  // print dialog, otherwise the first page can render with fallback fonts.
  win.setTimeout(() => {
    win.print();
  }, 600);
}
