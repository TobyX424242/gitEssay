/**
 * gitEssay — pdfExport unit tests (node env: pure string helpers only).
 */
import {describe, expect, it} from 'vitest';

import {
  DEFAULT_PDF_SETTINGS,
  pageCss,
  PRINT_CSS,
  sanitizePdfFilename,
  type PdfExportSettings,
} from '../pdfExport';

function settings(patch: Partial<PdfExportSettings>): PdfExportSettings {
  return {...DEFAULT_PDF_SETTINGS, ...patch};
}

describe('PRINT_CSS page breaks', () => {
  it('suppresses the hr rule line while keeping the forced break', () => {
    const rule = PRINT_CSS.match(
      /hr\[data-lexical-page-break\]\s*\{[^}]*\}/,
    )?.[0];
    expect(rule).toBeTruthy();
    // No painted border line, but the page still breaks.
    expect(rule).toContain('border: none');
    expect(rule).toContain('visibility: hidden');
    expect(rule).toContain('page-break-after: always');
  });
});

describe('pageCss', () => {
  it('emits no margin boxes by default (no auto date/title)', () => {
    const css = pageCss(DEFAULT_PDF_SETTINGS);
    expect(css).toContain('size: A4');
    expect(css).not.toContain('@top-center');
    expect(css).not.toContain('@bottom-center');
    expect(css).not.toContain('counter(');
  });

  it('renders header / footer text only when provided', () => {
    const css = pageCss(
      settings({headerText: 'My Header', footerText: 'draft'}),
    );
    expect(css).toContain('@top-center { content: "My Header"');
    expect(css).toContain('@bottom-center { content: "draft"');
  });

  it('escapes quotes, backslashes and newlines in content strings', () => {
    const css = pageCss(settings({headerText: 'a"b\\c\nd'}));
    expect(css).toContain('content: "a\\"b\\\\c\\a d"');
  });

  it('places page-number counters and merges a bottom-center collision', () => {
    expect(pageCss(settings({pageNumbers: 'bottom-right'}))).toContain(
      '@bottom-right { content: counter(page)',
    );
    expect(
      pageCss(
        settings({pageNumbers: 'top-right', pageNumberFormat: 'page-of-total'}),
      ),
    ).toContain('@top-right { content: counter(page) " / " counter(pages)');
    // Footer text + bottom-center page numbers share one box, joined by " · ".
    const merged = pageCss(
      settings({footerText: 'draft', pageNumbers: 'bottom-center'}),
    );
    expect(merged).toContain(
      '@bottom-center { content: "draft" " · " counter(page)',
    );
  });

  it('honours the page size', () => {
    expect(pageCss(settings({pageSize: 'Letter'}))).toContain('size: Letter');
  });
});

describe('sanitizePdfFilename', () => {
  it('appends .pdf and strips characters illegal on common filesystems', () => {
    expect(sanitizePdfFilename('论文/第1章: 草稿?')).toBe('论文_第1章_ 草稿_.pdf');
    expect(sanitizePdfFilename('notes.pdf')).toBe('notes.pdf');
    expect(sanitizePdfFilename('   ')).toBe('document.pdf');
  });
});
