/**
 * gitEssay — multi-layer patch fallback.
 *
 * When a patch's edits don't apply, classify WHY so we can react gracefully
 * instead of just marking it "unlocatable":
 *
 *   - mis-copy: the SEARCH text was never in what the AI was given (snapshot).
 *     The AI transcribed the passage wrong → re-prompt it to try again (bounded).
 *   - stale:    the SEARCH text WAS in the snapshot but is gone from the live
 *     document. The document changed under the AI (user edit, or another patch)
 *     → the edit can never apply; mark it as an error and tell the user.
 *   - invalid:  the edit is structurally un-applicable regardless of doc state —
 *     it references a citation/equation not in the search passage, or spans
 *     nested formatting around a decorator. Re-prompting won't fix it; fail it.
 *
 * Classification reuses `locateEdit` — the SAME read-only decision applyTextPatch
 * runs — so it matches what applyTextPatch would actually do, not just whether
 * the search text is present. The snapshot (the doc text the AI received for THIS
 * run) distinguishes not-found as stale vs mis-copy.
 */
import type {LexicalEditor} from 'lexical';

import {locateEdit, textContains} from './patch';
import type {ChatEdit, ChatMessage} from './types';

export type PatchIssue = 'ok' | 'mis-copy' | 'stale' | 'invalid';

export interface PatchClassification {
  issue: PatchIssue;
  /** For `issue === 'invalid'`, the specific reason (from locateEdit). */
  reason?: string;
}

/** Max automatic re-prompts of the AI for a mis-copied patch before giving up. */
export const MAX_PATCH_ATTEMPTS = 3;

/**
 * Classify a patch's edits against the live editor and the run's snapshot.
 * Worst issue wins: a single stale or invalid edit fails the whole patch;
 * otherwise any mis-copy triggers a retry.
 *
 * The snapshot is checked PER-PARAGRAPH (split on blank lines) to mirror
 * locateEdit's per-block semantics — a search spanning a `\n\n` boundary can
 * never apply (locate is within one block), so finding it in the JOINED snapshot
 * would be a false positive.
 */
export function classifyPatch(
  editor: LexicalEditor,
  edits: ChatEdit[],
  snapshot: string,
): PatchClassification {
  const paragraphs = snapshot.split(/\n\s*\n/);
  let anyMisCopy = false;
  for (const e of edits) {
    const r = locateEdit(editor, e.search, e.replace);
    // `in`-narrow (not `r.ok`) — the project compiles with strict:false, where
    // `ok: true | false` discriminant narrowing is unreliable.
    if ('blockKey' in r) {
      continue; // this edit applies as-is
    }
    if (r.kind === 'not-found') {
      // Distinguish stale (the passage was in the snapshot — per-paragraph, since
      // locate is per-block — but is gone from the live doc) from mis-copy (never
      // in what the AI was given).
      if (paragraphs.some(p => textContains(p, e.search))) {
        return {issue: 'stale'};
      }
      anyMisCopy = true;
      continue;
    }
    // empty / sentinel / structure — structurally un-applicable regardless of
    // doc state. Re-prompting won't reliably fix it; fail the patch.
    return {issue: 'invalid', reason: r.reason};
  }
  return {issue: anyMisCopy ? 'mis-copy' : 'ok'};
}

/** The feedback message appended to history when re-prompting a mis-copied patch. */
export function patchFeedback(edits: ChatEdit[]): string {
  const sample = edits
    .slice(0, 3)
    .map(e => `"${e.search.slice(0, 80)}"`)
    .filter(s => s.length > 2)
    .join(', ');
  return [
    'Your previous patch could not be applied: the SEARCH text was not found verbatim in the document (it looks slightly mis-copied).',
    'Re-read the current document, then propose the patch again. Copy each SEARCH passage EXACTLY as it appears — character-for-character, every space, punctuation mark, and quotation mark — using the SHORTEST unique span within one paragraph.',
    sample ? `Passages that failed to match: ${sample}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Mark a patch message as a patch-level failure (supersedes the patch card).
 *  - 'ignored': mis-copied past MAX_PATCH_ATTEMPTS retries → dropped.
 *  - 'stale':   the underlying text changed while the AI worked → can't complete.
 *  - 'invalid': structurally un-applicable (sentinel/structure) → can't complete.
 * The assistant's prose is kept verbatim; the explanation renders in the failure
 * card (MessageBubble), not duplicated into the prose. For 'invalid', `reason`
 * is carried as `patchFailureReason` so the card can say why.
 */
export function withPatchFailure(
  msg: ChatMessage,
  kind: 'ignored' | 'stale' | 'invalid',
  snapshot?: string,
  reason?: string,
): ChatMessage {
  const out: ChatMessage = {
    ...msg,
    snapshot,
    patchFailure: kind,
    action: null,
    edits: undefined,
  };
  if (kind === 'invalid' && reason) {
    out.patchFailureReason = reason;
  }
  return out;
}
