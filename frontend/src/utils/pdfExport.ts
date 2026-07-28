/**
 * gitEssay — PDF export of the current document.
 *
 * The Lexical document is rendered to a self-contained HTML string (KaTeX
 * CSS with fonts inlined as data: URLs, images inlined as data: URLs) and
 * POSTed to the backend, where WeasyPrint renders the final PDF. Server-side
 * rendering is what makes the export settings possible: @page margin boxes
 * (header / footer / page-number counters) are honored by WeasyPrint but
 * ignored by browsers, and the browser print dialog force-adds its own
 * date/title/URL headers — here nothing beyond the user's settings is added.
 *
 * Fallbacks: when the backend route is missing/501 (desktop builds ship no
 * WeasyPrint) or rendering fails, the same self-contained HTML is opened in
 * a print window and the browser's "Save as PDF" takes over (page-break
 * lines are still suppressed; margin-box settings are simply ignored there).
 */
import {$generateHtmlFromNodes} from '@lexical/html';
import katexCss from 'katex/dist/katex.min.css?inline';
import type {LexicalEditor} from 'lexical';

export type PageNumberPosition =
  | 'none'
  | 'bottom-center'
  | 'bottom-right'
  | 'top-right';

export type PdfExportSettings = {
  /** Printed centered at the top of every page; empty = no header. */
  headerText: string;
  /** Printed centered at the bottom of every page; empty = no footer. */
  footerText: string;
  pageNumbers: PageNumberPosition;
  /** 'page' → "3", 'page-of-total' → "3 / 12". */
  pageNumberFormat: 'page' | 'page-of-total';
  pageSize: 'A4' | 'Letter';
};

export const DEFAULT_PDF_SETTINGS: PdfExportSettings = {
  headerText: '',
  footerText: '',
  pageNumbers: 'none',
  pageNumberFormat: 'page',
  pageSize: 'A4',
};

const MARGIN_BOX_STYLE =
  'font-family: Georgia, "Times New Roman", "Songti SC", "SimSun", serif; ' +
  'font-size: 9pt; color: #666;';

export const PRINT_CSS = `
  body {
    font-family: Georgia, 'Times New Roman', 'Songti SC', 'SimSun', serif;
    font-size: 12pt;
    line-height: 1.65;
    color: #111;
  }
  h1 { font-size: 1.7em; } h2 { font-size: 1.45em; } h3 { font-size: 1.2em; }
  h4, h5, h6 { font-size: 1.05em; }
  img { max-width: 100%; height: auto; }
  figure { margin: 1em 0; text-align: center; }
  figcaption { font-size: 10pt; color: #555; }
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
  /* Inserted page breaks must break the page WITHOUT drawing the browser's
     default hr rule line (visibility keeps the layout box, so the forced
     break still applies while nothing is painted). */
  hr[data-lexical-page-break] {
    border: none;
    margin: 0;
    visibility: hidden;
    break-after: page;
    page-break-after: always;
  }
  @media print { a { color: inherit; } }
`;

/** Escape a user string for a CSS `content: "…"` declaration. */
function cssContent(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\a ')}"`;
}

/** Compose the @page rule from the user's settings — only what they asked
 * for is emitted (no automatic date/title anywhere). */
export function pageCss(settings: PdfExportSettings): string {
  const boxes: string[] = [];
  const pageCounter =
    settings.pageNumberFormat === 'page-of-total'
      ? 'counter(page) " / " counter(pages)'
      : 'counter(page)';

  let bottomCenter = settings.footerText ? cssContent(settings.footerText) : '';
  if (settings.pageNumbers === 'bottom-center') {
    bottomCenter = bottomCenter
      ? `${bottomCenter} " · " ${pageCounter}`
      : pageCounter;
  }
  if (settings.headerText) {
    boxes.push(`@top-center { content: ${cssContent(settings.headerText)}; ${MARGIN_BOX_STYLE} }`);
  }
  if (bottomCenter) {
    boxes.push(`@bottom-center { content: ${bottomCenter}; ${MARGIN_BOX_STYLE} }`);
  }
  if (settings.pageNumbers === 'bottom-right') {
    boxes.push(`@bottom-right { content: ${pageCounter}; ${MARGIN_BOX_STYLE} }`);
  } else if (settings.pageNumbers === 'top-right') {
    boxes.push(`@top-right { content: ${pageCounter}; ${MARGIN_BOX_STYLE} }`);
  }
  return `@page { size: ${settings.pageSize}; margin: 2.2cm 2cm; ${boxes.join(' ')} }`;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Fetch every relative url(...) in a stylesheet and swap in a data: URL, so
 * the HTML is renderable without any base URL (WeasyPrint gets no network
 * access to the dev server / docker nginx). */
async function inlineCssUrls(css: string): Promise<string> {
  const refs = new Set<string>();
  for (const m of css.matchAll(/url\((['"]?)(?!data:)([^'")]+)\1\)/g)) {
    refs.add(m[2]);
  }
  const resolved = new Map<string, string>();
  await Promise.all(
    [...refs].map(async ref => {
      try {
        const res = await fetch(new URL(ref, window.location.href));
        if (res.ok) {
          resolved.set(ref, await blobToDataUrl(await res.blob()));
        }
      } catch {
        // Leave the original reference — worst case a fallback font is used.
      }
    }),
  );
  return css.replace(
    /url\((['"]?)([^'")]+)\1\)/g,
    (match, quote: string, ref: string) =>
      resolved.has(ref) ? `url(${quote}${resolved.get(ref)}${quote})` : match,
  );
}

// KaTeX ships woff2+woff+ttf per font; WeasyPrint and every modern browser
// handle woff2, so the other two formats are stripped before inlining to
// keep the payload small. Inlined once and cached for the session.
let katexPrintCssPromise: Promise<string> | null = null;
function inlinedKatexCss(): Promise<string> {
  if (!katexPrintCssPromise) {
    const woff2Only = katexCss.replace(
      /,?\s*url\([^)]+\)\s*format\("(?:woff|truetype)"\)/g,
      '',
    );
    katexPrintCssPromise = inlineCssUrls(woff2Only);
  }
  return katexPrintCssPromise;
}

/** Download every <img> and swap its src for a data: URL (images may be
 * same-origin /api/… URLs the backend cannot reach from its container). */
async function inlineImages(bodyHtml: string): Promise<string> {
  const doc = new DOMParser().parseFromString(bodyHtml, 'text/html');
  await Promise.all(
    [...doc.images]
      .filter(img => img.src && !img.src.startsWith('data:'))
      .map(async img => {
        try {
          const res = await fetch(img.src);
          if (res.ok) {
            img.src = await blobToDataUrl(await res.blob());
          }
        } catch {
          // Keep the original src — a broken image shouldn't block export.
        }
      }),
  );
  return doc.body.innerHTML;
}

/** Render the editor to a fully self-contained HTML document. */
export async function buildExportHtml(
  editor: LexicalEditor,
  title: string,
  settings: PdfExportSettings,
): Promise<string> {
  const body = editor.read(() => $generateHtmlFromNodes(editor));
  const [katex, inlinedBody] = await Promise.all([
    inlinedKatexCss(),
    inlineImages(body),
  ]);
  const escapedTitle = title
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>${escapedTitle}</title>
    <style>${katex}</style>
    <style>${pageCss(settings)}</style>
    <style>${PRINT_CSS}</style>
  </head>
  <body>${inlinedBody}</body>
</html>`;
}

// --- save-location handling ------------------------------------------------

type WritableFileHandle = {
  createWritable: () => Promise<{
    write: (data: Blob) => Promise<void>;
    close: () => Promise<void>;
  }>;
};

function getSaveFilePicker():
  | ((options: {
      suggestedName: string;
      types: {description: string; accept: Record<string, string[]>}[];
    }) => Promise<WritableFileHandle>)
  | null {
  const candidate = (
    window as unknown as {showSaveFilePicker?: unknown}
  ).showSaveFilePicker;
  return typeof candidate === 'function'
    ? (candidate as (...args: never[]) => Promise<WritableFileHandle>).bind(
        window,
      )
    : null;
}

export function sanitizePdfFilename(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  const base = cleaned || 'document';
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}

/** Ask where to save (Chromium's File System Access API). Returns null when
 * the API doesn't exist; rethrows AbortError so the caller can treat it as
 * a silent cancel. Must be called straight from the click handler — the
 * transient user activation expires while the PDF renders. */
export async function pickPdfSaveLocation(
  suggestedName: string,
): Promise<WritableFileHandle | null> {
  const picker = getSaveFilePicker();
  if (!picker) {
    return null;
  }
  return picker({
    suggestedName,
    types: [{description: 'PDF document', accept: {'application/pdf': ['.pdf']}}],
  });
}

/** POST the HTML to the backend and return the rendered PDF bytes. Throws
 * when the route is unavailable (501 on desktop builds) or rendering fails. */
async function renderPdfOnServer(html: string, filename: string): Promise<Blob> {
  const res = await fetch('/api/export/pdf', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({html, filename}),
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = await res.json();
      if (typeof data.detail === 'string') {
        detail = data.detail;
      }
    } catch {
      // non-JSON error body — keep the status text
    }
    throw new Error(detail || `HTTP ${res.status}`);
  }
  return res.blob();
}

/** Degraded path for installations without server-side rendering (desktop
 * build): open the self-contained HTML in a print window and let the
 * browser's "Save as PDF" produce the file. */
function openPrintWindow(html: string): void {
  const win = window.open('', '_blank');
  if (!win) {
    throw new Error('the browser blocked the print window (allow pop-ups)');
  }
  win.document.write(html);
  win.document.close();
  win.focus();
  // Give any not-yet-loaded resources a moment before opening the print
  // dialog, otherwise the first page can render with fallback fonts.
  win.setTimeout(() => {
    win.print();
  }, 600);
}

/**
 * Export the document as a fully rendered PDF.
 *
 * @param saveHandle result of pickPdfSaveLocation — null triggers a plain
 *                   browser download instead of writing to a picked location.
 */
export async function exportDocumentAsPdf(
  editor: LexicalEditor,
  filename: string,
  settings: PdfExportSettings,
  saveHandle: WritableFileHandle | null,
): Promise<void> {
  const html = await buildExportHtml(editor, filename, settings);
  let pdf: Blob;
  try {
    pdf = await renderPdfOnServer(html, filename);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('server-side PDF export failed, using print window:', err);
    openPrintWindow(html);
    return;
  }
  if (saveHandle) {
    const writable = await saveHandle.createWritable();
    await writable.write(pdf);
    await writable.close();
    return;
  }
  const url = URL.createObjectURL(pdf);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
