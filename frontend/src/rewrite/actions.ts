/**
 * gitEssay — shared rewrite actions + prompt material.
 *
 * Both the local mock provider and the live LLM provider expose the SAME action
 * list (so the UI is identical regardless of which is active). The LLM provider
 * also uses ACTION_INSTRUCTIONS / SYSTEM_PROMPT to drive the model.
 */
import type {RewriteAction} from './types';

/**
 * System prompt enforcing the T2 contract: the model returns NEW PLAIN TEXT only
 * — never a patch, never commentary, never code fences. Citations/equation
 * markers are passed through verbatim so academic content survives the rewrite.
 */
export const SYSTEM_PROMPT = [
  'You are an expert academic-writing editor.',
  'Rewrite the text the user gives you according to their instruction.',
  'Rules:',
  '- Return ONLY the rewritten text. No preamble, no explanation, no headings.',
  '- Do not wrap the output in markdown code fences.',
  '- Preserve the author’s meaning and voice; only change what the instruction asks.',
  '- Preserve every citation marker (e.g. [1], (Smith, 2020), {CITE_x}) and any LaTeX ($…$, $$…$$) verbatim.',
  '- Preserve paragraph breaks (a blank line separates paragraphs).',
  '- Match the input language.',
].join('\n');

export const REWRITE_ACTIONS: RewriteAction[] = [
  {id: 'tighten', label: 'Tighten', hint: 'Cut filler and wordy phrasing.'},
  {id: 'clarify', label: 'Clarify', hint: 'Verbose → concise phrasing.'},
  {id: 'formalize', label: 'Formalize', hint: 'Expand contractions; academic register.'},
  {id: 'proofread', label: 'Proofread', hint: 'Capitalisation, spacing, punctuation.'},
  {id: 'expand', label: 'Expand', hint: 'Append an elaborating sentence.'},
];

/** Instruction per action, fed to the model as the user message. */
export const ACTION_INSTRUCTIONS: Record<string, string> = {
  tighten:
    'Tighten this text: remove filler words, redundancy, and wordy phrasing while preserving the meaning.',
  clarify:
    'Clarify this text: replace verbose phrasing with concise, direct alternatives and improve readability.',
  formalize:
    'Make this text more formal: expand contractions, use a precise academic register, and ensure correct sentence capitalisation.',
  proofread:
    'Proofread this text: fix capitalisation, spacing, punctuation, and minor grammar errors. Do not rephrase or change wording beyond corrections.',
  expand:
    'Expand this text: add a sentence that elaborates the main point and strengthens the argument, keeping the original sentences intact.',
};
