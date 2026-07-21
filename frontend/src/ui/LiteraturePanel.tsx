/**
 * gitEssay — Literature panel: the project's uploaded reference library.
 *
 * Upload PDF/DOCX (picker or drag-drop) with a real per-file progress bar;
 * the backend parses with docling in the background (badge: parsing…), then a
 * summarization subagent writes a summary (badge: summarizing…). Clicking an
 * item opens a detail modal with the AI summary, the section outline, and a
 * Download button for the original file.
 */
import {type JSX, useEffect, useRef, useState} from 'react';
import {createPortal} from 'react-dom';

import Markdown from '../chat/Markdown';
import {useActiveProjectId} from '../projects/projectStore';
import {
  deleteLiterature,
  downloadUrl,
  getLiterature,
  regenerateSummary,
  reparseLiterature,
  trackUpload,
  useLiterature,
  useUploadError,
  useUploads,
  type Literature,
  type LiteratureDetail,
} from '../literature/literature';
import './LiteraturePanel.css';

const ACCEPT = '.pdf,.docx';

function statusBadge(lit: Literature): JSX.Element {
  if (lit.status === 'processing') {
    return <span className="lit-badge lit-badge--processing">parsing…</span>;
  }
  if (lit.status === 'error') {
    return (
      <span className="lit-badge lit-badge--error" title={lit.error ?? 'parse failed'}>
        failed
      </span>
    );
  }
  if (lit.summary_status === 'generating') {
    return <span className="lit-badge lit-badge--processing">summarizing…</span>;
  }
  return <span className="lit-badge lit-badge--ready">ready</span>;
}

export default function LiteraturePanel(): JSX.Element {
  const pid = useActiveProjectId();
  const items = useLiterature(pid);
  const uploads = useUploads();
  const uploadError = useUploadError();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  // Delete confirmation: an in-app modal (not window.confirm, which is blocked/
  // ugly in some webviews and clashes with the app's design).
  const [pendingDelete, setPendingDelete] = useState<Literature | null>(null);

  const upload = (files: FileList | File[]) => {
    if (!pid) {
      return;
    }
    for (const file of Array.from(files)) {
      trackUpload(pid, file);
    }
  };

  const onReparse = (lit: Literature) => {
    reparseLiterature(lit.id).catch(e =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  const onDelete = (lit: Literature) => setPendingDelete(lit);

  const confirmDelete = () => {
    const lit = pendingDelete;
    setPendingDelete(null);
    if (!lit) {
      return;
    }
    deleteLiterature(lit.id).catch(e =>
      setError(e instanceof Error ? e.message : String(e)),
    );
  };

  return (
    <div
      className={`lit-panel${dragOver ? ' is-dragover' : ''}`}
      onDragOver={e => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={e => {
        e.preventDefault();
        setDragOver(false);
        upload(e.dataTransfer.files);
      }}>
      <button
        type="button"
        className={`lit-dropzone${dragOver ? ' is-dragover' : ''}`}
        disabled={!pid}
        onClick={() => fileRef.current?.click()}>
        <span className="lit-dropzone-icon">📥</span>
        <span className="lit-dropzone-text">
          Drag &amp; drop PDF / DOCX here
          <span className="lit-dropzone-sub">or click to browse — anywhere in the app works too</span>
        </span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={e => {
          if (e.target.files) {
            upload(e.target.files);
          }
          e.target.value = '';
        }}
      />
      {uploads.map(f => (
        <div className="lit-upload" key={f.name}>
          <div className="lit-upload-name" title={f.name}>
            {f.frac >= 1 ? `${f.name} — uploaded, queued for parsing` : f.name}
          </div>
          <div className="lit-progress">
            <div className="lit-progress-fill" style={{width: `${Math.round(f.frac * 100)}%`}} />
          </div>
          <span className="lit-progress-pct">{Math.round(f.frac * 100)}%</span>
        </div>
      ))}
      {(error ?? uploadError) && (
        <div className="lit-note lit-note--error">⚠ {error ?? uploadError}</div>
      )}
      {items.length === 0 && uploads.length === 0 ? (
        <div className="lit-empty">
          No references yet. Drop a PDF or DOCX here — the agent can then search,
          read, and cite it, and take per-paper notes.
        </div>
      ) : (
        <ul className="lit-list">
          {items.map(lit => (
            <li key={lit.id} className="lit-item">
              <button
                type="button"
                className="lit-item-body"
                onClick={() => setDetailId(lit.id)}
                title="Open details & summary">
                <div className="lit-item-title" title={lit.title}>
                  {lit.title}
                </div>
                <div className="lit-item-sub">
                  {statusBadge(lit)}
                  {lit.status === 'ready' && (
                    <span className="lit-meta">
                      {lit.page_count}p · {lit.chunk_count} chunks · {lit.image_count}{' '}
                      figs
                      {lit.note_count > 0 && ` · ${lit.note_count} notes`}
                    </span>
                  )}
                </div>
                {lit.status === 'processing' && (
                  <div className="lit-progress lit-progress--parse">
                    {lit.progress !== null ? (
                      <>
                        <div
                          className="lit-progress-fill"
                          style={{width: `${Math.round(lit.progress * 100)}%`}}
                        />
                        <span className="lit-progress-pct">
                          {Math.round(lit.progress * 100)}%
                        </span>
                      </>
                    ) : (
                      <div className="lit-progress-fill lit-progress-fill--indet" />
                    )}
                  </div>
                )}
                {lit.status === 'error' && lit.error && (
                  <div className="lit-item-error" title={lit.error}>
                    {lit.error}
                  </div>
                )}
              </button>
              {lit.status === 'error' && (
                <button
                  type="button"
                  className="cp-close lit-retry"
                  title="Retry parsing (the original file is still on disk)"
                  aria-label={`Retry parsing ${lit.title}`}
                  onClick={() => onReparse(lit)}>
                  ↻
                </button>
              )}
              <button
                type="button"
                className="cp-close lit-delete"
                title="Delete this reference"
                aria-label={`Delete ${lit.title}`}
                onClick={() => onDelete(lit)}>
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}
      {dragOver && <div className="lit-drop-hint">Drop to upload</div>}
      {/* Modals are portaled to <body>: the dock's collapse animation keeps a
          `transform` on an ancestor, which would otherwise trap the
          position:fixed overlay inside the narrow dock. */}
      {detailId &&
        createPortal(
          <LiteratureDetailModal lid={detailId} onClose={() => setDetailId(null)} />,
          document.body,
        )}
      {pendingDelete &&
        createPortal(
          <DeleteConfirmModal
            lit={pendingDelete}
            onConfirm={confirmDelete}
            onCancel={() => setPendingDelete(null)}
          />,
          document.body,
        )}
    </div>
  );
}

/** Modern in-app delete confirmation (replaces window.confirm). */
function DeleteConfirmModal({
  lit,
  onConfirm,
  onCancel,
}: {
  lit: Literature;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // Escape cancels; focus the confirm button on open for keyboard users.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey);
    confirmRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="mem-overlay" onClick={onCancel}>
      <div
        className="mem-panel lit-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-label="Delete reference"
        onClick={e => e.stopPropagation()}>
        <header className="mem-header">
          <span className="mem-title">Delete reference?</span>
          <button
            type="button"
            className="mem-close"
            onClick={onCancel}
            aria-label="Cancel">
            ✕
          </button>
        </header>
        <div className="lit-confirm-body">
          <p className="lit-confirm-title" title={lit.title}>
            《{lit.title}》
          </p>
          <p className="lit-confirm-sub">
            Its parsed chunks, figures, and attached notes are removed too. This
            can't be undone.
          </p>
        </div>
        <footer className="lit-confirm-footer">
          <button type="button" className="cp-button cp-button--ghost" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="cp-button lit-confirm-delete"
            ref={confirmRef}
            onClick={onConfirm}>
            Delete
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Detail modal: AI summary + outline + original-file download. */
function LiteratureDetailModal({
  lid,
  onClose,
}: {
  lid: string;
  onClose: () => void;
}): JSX.Element {
  const [detail, setDetail] = useState<LiteratureDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumped to re-run the fetch+poll effect (e.g. after Regenerate — the poll
  // loop has already stopped by then, so without this the modal would show the
  // stale summary until it was closed and reopened).
  const [refreshKey, setRefreshKey] = useState(0);

  // Refresh while the summary is still being generated.
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      getLiterature(lid)
        .then(d => {
          if (!alive) {
            return;
          }
          setDetail(d);
          if (d.summary_status === 'generating' || d.status === 'processing') {
            timer = setTimeout(tick, 2500);
          }
        })
        .catch(e => alive && setError(e instanceof Error ? e.message : String(e)));
    };
    tick();
    return () => {
      alive = false;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [lid, refreshKey]);

  const onRegenerate = () => {
    // Immediate feedback: flip the badge to "summarizing…" and hide the stale
    // summary, then restart the poll loop once the backend has flipped state.
    setDetail(d => (d ? {...d, summary_status: 'generating', summary: null} : d));
    regenerateSummary(lid)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setRefreshKey(k => k + 1));
  };

  return (
    <div className="mem-overlay" onClick={onClose}>
      <div
        className="mem-panel lit-detail"
        role="dialog"
        aria-label="Literature details"
        onClick={e => e.stopPropagation()}>
        <header className="mem-header">
          <span className="mem-title" title={detail?.title}>
            {detail?.title ?? '…'}
          </span>
          <button type="button" className="mem-close" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        {error && <div className="lit-note lit-note--error">⚠ {error}</div>}
        {!detail ? (
          <div className="lit-empty">Loading…</div>
        ) : (
          <div className="lit-detail-body">
            <div className="lit-detail-meta">
              {statusBadge(detail)}
              <span className="lit-meta">
                {detail.filename} · {detail.page_count}p · {detail.chunk_count} chunks ·{' '}
                {detail.image_count} figures
                {detail.note_count > 0 && ` · ${detail.note_count} notes`}
                {detail.embed_status === 'failed' &&
                  ' · embeddings failed (keyword search only)'}
              </span>
            </div>
            {detail.status === 'error' && (
              <div className="lit-note lit-note--error">Parse failed: {detail.error}</div>
            )}

            <div className="lit-detail-section">
              <div className="lit-detail-heading">AI summary</div>
              {detail.summary_status === 'generating' && (
                <div className="lit-note">✍ Writing the summary…</div>
              )}
              {detail.summary ? (
                <div className="lit-summary">
                  <Markdown>{detail.summary}</Markdown>
                </div>
              ) : detail.summary_status === 'skipped' ? (
                <div className="lit-note">
                  Summary skipped — the AI provider wasn't configured when this was
                  parsed. Configure it, then regenerate.
                </div>
              ) : detail.summary_status === 'failed' ? (
                <div className="lit-note lit-note--error">
                  Summary generation failed. You can try again.
                </div>
              ) : null}
            </div>

            {detail.outline.length > 0 && (
              <div className="lit-detail-section">
                <div className="lit-detail-heading">Section outline</div>
                <ol className="lit-outline">
                  {detail.outline.map(h => (
                    <li key={h}>{h}</li>
                  ))}
                </ol>
              </div>
            )}
          </div>
        )}
        <footer className="lit-detail-footer">
          {detail && (
            <>
              {detail.status === 'error' && (
                <button
                  type="button"
                  className="cp-button"
                  title="Re-run parsing from the original file"
                  onClick={() =>
                    reparseLiterature(lid).catch(e =>
                      setError(e instanceof Error ? e.message : String(e)),
                    )
                  }>
                  ↻ Retry parse
                </button>
              )}
              <a
                className="cp-button"
                href={downloadUrl(detail)}
                download={detail.filename}
                title="Download the original file">
                ⬇ Original {detail.filename.endsWith('.docx') ? 'DOCX' : 'PDF'}
              </a>
              {(detail.summary_status === 'failed' ||
                detail.summary_status === 'skipped' ||
                detail.summary_status === 'ready') && (
                <button
                  type="button"
                  className="cp-button cp-button--ghost"
                  onClick={onRegenerate}>
                  ↻ Regenerate summary
                </button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
