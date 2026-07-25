/**
 * gitEssay — literature library (uploaded PDF/DOCX references).
 *
 * Uploads are parsed backend-side with docling (chunks + FTS/embedding index +
 * extracted figures), so an item appears as `processing` first and flips to
 * `ready` (or `error`) when the background parse finishes — useLiterature polls
 * while anything is still processing. The LangGraph agent reaches the content
 * through its literature tools; this module backs the library panel UI.
 */
import {useEffect, useSyncExternalStore, useState} from 'react';

import {api} from '../utils/api';
import {createVersionedStore} from '../utils/store';

export type LiteratureStatus = 'processing' | 'ready' | 'error';

/** Lifecycle of the auto-generated AI summary (backend, post-parse). */
export type SummaryStatus = 'none' | 'generating' | 'ready' | 'failed' | 'skipped';

/** Embedding indexing outcome (failed = keyword search only). */
export type EmbedStatus = 'none' | 'disabled' | 'ok' | 'failed';

/** Engine that produced the parsed chunks (null = DOCX / pre-migration row). */
export type ParseEngine = 'edgeparse' | 'docling' | null;

/** Auditor verdict on the extraction quality (none = not audited). */
export type ParseConfidence = 'none' | 'reliable' | 'partial' | 'unreliable';

/** Live stage of the two-tier PDF parse while status === 'processing'. */
export type ParsePhase = 'fast_extract' | 'evaluating' | 'ocr_fallback' | null;

export interface Literature {
  id: string;
  project_id: string;
  filename: string;
  title: string;
  status: LiteratureStatus;
  error: string | null;
  page_count: number;
  char_count: number;
  chunk_count: number;
  image_count: number;
  note_count: number;
  summary_status: SummaryStatus;
  embed_status: EmbedStatus;
  /** Parse progress 0..1 while processing (PDFs); null = indeterminate. */
  progress: number | null;
  parse_engine: ParseEngine;
  parse_confidence: ParseConfidence;
  parse_phase: ParsePhase;
  /** Short auditor note (verdict reason) — shown as the confidence tooltip. */
  parse_eval_note: string | null;
  created_at: number;
}

export interface LiteratureImage {
  id: string;
  seq: number;
  caption: string;
  width: number;
  height: number;
}

export interface LiteratureDetail extends Literature {
  images: LiteratureImage[];
  outline: string[];
  summary: string | null;
}

// --- store (version-bumped refetch; shared primitive, see utils/store.ts) ----
const {emit, subscribe, getVersion} = createVersionedStore();

export async function listLiterature(pid: string): Promise<Literature[]> {
  return api.get<Literature[]>(`/projects/${pid}/literature`);
}

export async function getLiterature(lid: string): Promise<LiteratureDetail> {
  return api.get<LiteratureDetail>(`/literature/${lid}`);
}

/** URL of the originally uploaded file (opens/downloads in the browser). */
export function downloadUrl(lit: Literature): string {
  return `/api/literature/${lit.id}/download`;
}

export async function regenerateSummary(lid: string): Promise<Literature> {
  const lit = await api.post<Literature>(`/literature/${lid}/summary`);
  emit();
  return lit;
}

/**
 * Upload with REAL progress (fetch can't report upload progress; XHR can).
 * onProgress receives 0..1 while the bytes are uploading; the promise resolves
 * with the created (still `processing`) row.
 */
export function uploadLiterature(
  pid: string,
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<Literature> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/projects/${pid}/literature`);
    xhr.responseType = 'json';
    xhr.upload.onprogress = e => {
      if (e.lengthComputable && onProgress) {
        onProgress(e.loaded / e.total);
      }
    };
    xhr.onload = () => {
      // responseType is 'json': xhr.responseText is FORBIDDEN to read (throws).
      // Non-JSON error bodies (e.g. an nginx 413 page) just leave response null.
      const body = (xhr.response ?? {}) as {detail?: string; message?: string};
      if (xhr.status >= 200 && xhr.status < 300) {
        emit();
        resolve(body as unknown as Literature);
      } else if (xhr.status === 413) {
        reject(new Error('file too large (50 MB max)'));
      } else {
        reject(new Error(body.detail || body.message || `HTTP ${xhr.status}`));
      }
    };
    xhr.onerror = () => reject(new Error('upload failed (network error)'));
    const form = new FormData();
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

export async function deleteLiterature(id: string): Promise<void> {
  await api.del(`/literature/${id}`);
  emit();
}

/** Re-run parsing from the still-on-disk original (after a failure or an
 * interrupted run). The row flips back to `processing` and polling resumes.
 * `force` (PDFs): skip the edgeparse fast tier and parse directly with the
 * heavy OCR pipeline — the quality evaluation re-runs and the summary
 * regenerates automatically on success. */
export async function reparseLiterature(lid: string, force = false): Promise<Literature> {
  const lit = await api.post<Literature>(`/literature/${lid}/reparse${force ? '?force=true' : ''}`);
  emit();
  return lit;
}

// --- in-flight uploads (shared so the panel and the global drop zone agree) --
export interface UploadProgress {
  name: string;
  /** 0..1 while bytes are uploading; 1 = uploaded, waiting on the parse row. */
  frac: number;
}

let uploads: UploadProgress[] = [];
let uploadError: string | null = null;

/** Reactive list of in-flight uploads (name + fraction). */
export function useUploads(): UploadProgress[] {
  return useSyncExternalStore(
    subscribe,
    () => uploads,
    () => uploads,
  );
}

/** Reactive last upload error (cleared on the next upload). */
export function useUploadError(): string | null {
  return useSyncExternalStore(
    subscribe,
    () => uploadError,
    () => uploadError,
  );
}

/** Upload one file with tracked progress (shared store). Errors surface via
 *  useUploadError; the row then polls to ready/error as usual. */
export function trackUpload(pid: string, file: File): void {
  uploads = [...uploads, {name: file.name, frac: 0}];
  uploadError = null;
  emit();
  uploadLiterature(pid, file, frac => {
    uploads = uploads.map(u => (u.name === file.name ? {...u, frac} : u));
    emit();
  })
    .catch(e => {
      uploadError = e instanceof Error ? e.message : String(e);
    })
    .finally(() => {
      uploads = uploads.filter(u => u.name !== file.name);
      emit();
    });
}

const POLL_MS = 2500;

/**
 * Reactively read the active project's literature list. Refetches on
 * upload/delete (version bump) and polls while any item is `processing` or
 * its summary is still `generating`.
 */
export function useLiterature(pid: string | null): Literature[] {
  const v = useSyncExternalStore(subscribe, getVersion, getVersion);
  const [data, setData] = useState<Literature[]>([]);

  useEffect(() => {
    if (!pid) {
      setData([]);
      return;
    }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      listLiterature(pid)
        .then(rows => {
          if (!alive) {
            return;
          }
          setData(rows);
          if (rows.some(r => r.status === 'processing' || r.summary_status === 'generating')) {
            timer = setTimeout(tick, POLL_MS);
          }
        })
        .catch(() => {
          // Keep showing the last good list on a transient fetch failure —
          // the next emit/poll tick recovers on its own.
        });
    };
    tick();
    return () => {
      alive = false;
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    };
  }, [pid, v]);

  return data;
}
