/**
 * gitEssay — "Export as PDF" settings dialog.
 *
 * Second-level modal opened from the Export menu's "PDF (.pdf)" option.
 * Collects exactly what should appear on the printed pages (header, footer,
 * page numbers, page size) — nothing else (no date/title) is ever added to
 * the PDF. The settings persist across sessions; Export asks for a save
 * location first (while the click's user activation is still valid), then
 * renders the PDF on the backend and writes it there.
 */
import type {JSX} from 'react';

import type {LexicalEditor} from 'lexical';
import {useState} from 'react';

import {
  DEFAULT_PDF_SETTINGS,
  exportDocumentAsPdf,
  pickPdfSaveLocation,
  sanitizePdfFilename,
  type PdfExportSettings,
} from '../utils/pdfExport';
import Button from './Button';
import {DialogActions} from './Dialog';
import Select from './Select';
import TextInput from './TextInput';

const STORAGE_KEY = 'gitessay-pdf-export-settings';

function loadSettings(): PdfExportSettings {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw) {
      return {...DEFAULT_PDF_SETTINGS, ...JSON.parse(raw)};
    }
  } catch {
    // corrupted storage — fall through to defaults
  }
  return DEFAULT_PDF_SETTINGS;
}

export default function PdfExportDialog({
  editor,
  documentName,
  onClose,
}: {
  editor: LexicalEditor;
  documentName: string;
  onClose: () => void;
}): JSX.Element {
  const [settings, setSettings] = useState<PdfExportSettings>(loadSettings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = <K extends keyof PdfExportSettings>(
    key: K,
    value: PdfExportSettings[K],
  ) => setSettings(prev => ({...prev, [key]: value}));

  const onExport = async () => {
    const filename = sanitizePdfFilename(documentName);
    setBusy(true);
    setError(null);
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      // persistence is best-effort
    }
    try {
      // Ask for the save location FIRST: showSaveFilePicker requires the
      // click's transient user activation, which expires while the PDF is
      // being rendered server-side.
      const handle = await pickPdfSaveLocation(filename);
      await exportDocumentAsPdf(editor, filename, settings, handle);
      onClose();
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        // User cancelled the save dialog — not an error, keep the dialog.
        return;
      }
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="pdf-export-dialog">
      <TextInput
        label="Header"
        value={settings.headerText}
        placeholder="Shown at the top of every page — leave empty for none"
        onChange={v => update('headerText', v)}
        data-test-id="pdf-export-header"
      />
      <TextInput
        label="Footer"
        value={settings.footerText}
        placeholder="Shown at the bottom of every page — leave empty for none"
        onChange={v => update('footerText', v)}
        data-test-id="pdf-export-footer"
      />
      <Select
        label="Page numbers"
        value={settings.pageNumbers}
        onChange={e =>
          update(
            'pageNumbers',
            e.target.value as PdfExportSettings['pageNumbers'],
          )
        }
        data-test-id="pdf-export-page-numbers">
        <option value="none">None</option>
        <option value="bottom-center">Bottom center</option>
        <option value="bottom-right">Bottom right</option>
        <option value="top-right">Top right</option>
      </Select>
      {settings.pageNumbers !== 'none' && (
        <Select
          label="Page number format"
          value={settings.pageNumberFormat}
          onChange={e =>
            update(
              'pageNumberFormat',
              e.target.value as PdfExportSettings['pageNumberFormat'],
            )
          }
          data-test-id="pdf-export-page-number-format">
          <option value="page">1, 2, 3…</option>
          <option value="page-of-total">1 / 12, 2 / 12…</option>
        </Select>
      )}
      <Select
        label="Page size"
        value={settings.pageSize}
        onChange={e =>
          update('pageSize', e.target.value as PdfExportSettings['pageSize'])
        }
        data-test-id="pdf-export-page-size">
        <option value="A4">A4</option>
        <option value="Letter">Letter</option>
      </Select>
      {error && <div className="pdf-export-error">{error}</div>}
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button primary onClick={onExport} disabled={busy}>
          {busy ? 'Exporting…' : 'Export'}
        </Button>
      </DialogActions>
    </div>
  );
}
