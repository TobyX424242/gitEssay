/**
 * gitEssay — multi-layer patch fallback.
 *
 * When a patch's SEARCH text doesn't match the live document, classify WHY so we
 * can react gracefully instead of just marking it "unlocatable":
 *
 *   - mis-copy: the SEARCH text was never in what the AI was given (snapshot).
 *     The AI transcribed the passage wrong → re-prompt it to try again (bounded).
 *   - stale:    the SEARCH text WAS in the snapshot but is gone from the live
 *     document. The document changed under the AI (user edit, or another patch)
 *     → the edit can never apply; mark it as an error and tell the user.
 *
 * The snapshot is the document text the AI received for THIS run (recorded per
 * turn, since context varies even within one conversation). Both checks reuse
 * patch.ts's tolerant `locate` matching.
 */
import type {LexicalEditor} from 'lexical';

import {searchInEditor, textContains} from './patch';
import type {ChatEdit, ChatMessage} from './types';

export type PatchIssue = 'ok' | 'mis-copy' | 'stale';

/** Max automatic re-prompts of the AI for a mis-copied patch before giving up. */
export const MAX_PATCH_ATTEMPTS = 3;

/**
 * Classify a patch's edits against the live editor and the run's snapshot.
 * Worst issue wins: a single stale edit fails the whole patch (the doc changed,
 * so the patch can't complete); otherwise any mis-copy triggers a retry.
 */
export function classifyPatch(
  editor: LexicalEditor,
  edits: ChatEdit[],
  snapshot: string,
): PatchIssue {
  let anyMisCopy = false;
  for (const e of edits) {
    if (searchInEditor(editor, e.search)) {
      continue; // this edit is still locatable in the live doc
    }
    if (textContains(snapshot, e.search)) {
      // The AI copied a REAL passage (it was in the snapshot) but it's gone from
      // the live doc → the document changed. The patch can't be completed.
      return 'stale';
    }
    // Never in the snapshot either → the AI mis-copied. Retry can fix it.
    anyMisCopy = true;
  }
  return anyMisCopy ? 'mis-copy' : 'ok';
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
 * The assistant's prose is kept verbatim; the explanation renders in the failure
 * card (MessageBubble), not duplicated into the prose.
 */
export function withPatchFailure(
  msg: ChatMessage,
  kind: 'ignored' | 'stale',
  snapshot?: string,
): ChatMessage {
  return {...msg, snapshot, patchFailure: kind, action: null, edits: undefined};
}
