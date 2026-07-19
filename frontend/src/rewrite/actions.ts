/**
 * gitEssay — shared rewrite actions.
 *
 * The action chips in the chat sidebar all come from this one list. The chip
 * sends its `label` as the instruction; `hint` is the hover tooltip.
 */
import type {RewriteAction} from './types';

export const REWRITE_ACTIONS: RewriteAction[] = [
  {id: 'tighten', label: 'Tighten', hint: 'Cut filler and wordy phrasing.'},
  {id: 'clarify', label: 'Clarify', hint: 'Verbose → concise phrasing.'},
  {id: 'formalize', label: 'Formalize', hint: 'Expand contractions; academic register.'},
  {id: 'proofread', label: 'Proofread', hint: 'Capitalisation, spacing, punctuation.'},
  {id: 'expand', label: 'Expand', hint: 'Append an elaborating sentence.'},
];
