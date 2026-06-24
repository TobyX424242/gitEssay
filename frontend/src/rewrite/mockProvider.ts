/**
 * gitEssay — deterministic demo text transforms.
 *
 * Used by the chat sidebar's mock provider when no live model is configured, so
 * the full propose-edit → review-diff → accept flow is demonstrable with no key
 * and no network. The transforms are written to exercise every diff colour:
 *   Tighten   → removals  (filler / wordy phrases cut)
 *   Clarify   → modified  (verbose phrasing → concise)
 *   Formalize → modified  (contractions expanded, sentence caps)
 *   Proofread → modified  (i→I, spacing, punctuation)
 *   Expand    → additions (an elaborating sentence appended)
 */

/** Capitalise the first letter of the string and after each sentence end. */
function sentenceCap(s: string): string {
  return s.replace(
    /(^|\s+|[.!?]["')\]]?\s+)([a-z])/g,
    (_, lead, ch) => `${lead}${ch.toUpperCase()}`,
  );
}

function tighten(s: string): string {
  const fillers =
    /\b(very|really|just|actually|basically|literally|quite|rather|somewhat|simply|truly|honestly|essentially|virtually|indeed)\b[ \t]+/gi;
  let out = s.replace(fillers, '');
  out = out.replace(/\bin order to\b/gi, 'to');
  out = out.replace(/\bthat (is|are|was|were) able to\b/gi, '');
  out = out.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/ ([,.;:!?])/g, '$1');
  return out.trim();
}

function clarify(s: string): string {
  const map: Array<[RegExp, string]> = [
    [/\bdue to the fact that\b/gi, 'because'],
    [/\bin the event that\b/gi, 'if'],
    [/\bin order to\b/gi, 'to'],
    [/\ba number of\b/gi, 'several'],
    [/\ba majority of\b/gi, 'most'],
    [/\bat this point in time\b/gi, 'now'],
    [/\bin spite of the fact that\b/gi, 'although'],
    [/\bwith regard to\b/gi, 'about'],
    [/\bin the near future\b/gi, 'soon'],
    [/\butilize[ds]?\b/gi, 'use'],
    [/\bdemonstrate[ds]?\b/gi, 'show'],
    [/\bfacilitate[ds]?\b/gi, 'help'],
    [/\bsubsequently\b/gi, 'then'],
  ];
  let out = s;
  for (const [re, rep] of map) {
    out = out.replace(re, rep);
  }
  return out;
}

function formalize(s: string): string {
  let out = s;
  // special-case the irregular contractions first
  out = out.replace(/\bcan't\b/gi, 'cannot');
  out = out.replace(/\bwon't\b/gi, 'will not');
  out = out.replace(/\bshan't\b/gi, 'shall not');
  out = out.replace(/\bain't\b/gi, 'is not');
  out = out.replace(/\blet's\b/gi, 'let us');
  out = out.replace(/\bI'm\b/g, 'I am');
  out = out.replace(/\b(I|you|we|they)'re\b/gi, '$1 are');
  out = out.replace(/\b(you|we|they|I)'ve\b/gi, '$1 have');
  out = out.replace(/\b(I|you|we|they|he|she|it)'ll\b/gi, '$1 will');
  out = out.replace(/\b(it|that|there|here)'s\b/gi, '$1 is');
  out = out.replace(/\b(he|she)'s\b/gi, '$1 is');
  // general n't → "<stem> not" (don't→do not, isn't→is not, wouldn't→would not…)
  out = out.replace(/\b(\w+)n't\b/gi, '$1 not');
  return sentenceCap(out);
}

function proofread(s: string): string {
  let out = s.replace(/[ \t]{2,}/g, ' ');
  out = out.replace(/ ([,.;:!?])/g, '$1'); // space before punctuation
  out = out.replace(/([,;:])(?=\S)/g, '$1 '); // space after , ; :
  out = out.replace(/\bi\b/g, 'I'); // standalone "i"
  out = out.replace(/\bi'm\b/g, "I'm");
  return sentenceCap(out);
}

function expand(s: string): string {
  const body = s.replace(/\s+$/, '');
  const sep = /[.!?]["')\]]?$/.test(body) ? ' ' : '. ';
  return (
    body +
    sep +
    'Taken together, these observations support the central claim and warrant further elaboration in the discussion that follows.'
  );
}

export const TRANSFORMS: Record<string, (s: string) => string> = {
  tighten,
  clarify,
  formalize,
  proofread,
  expand,
};

/** Map a free-text instruction to one of the deterministic demo transforms. */
export function detectMockAction(instruction: string): string {
  const s = instruction.toLowerCase();
  if (/\bformal/.test(s)) {
    return 'formalize';
  }
  if (/clarif|concise|simplif|plainer/.test(s)) {
    return 'clarify';
  }
  if (/proofread|grammar|spelling|typo/.test(s)) {
    return 'proofread';
  }
  if (/expand|elaborat|longer|add/.test(s)) {
    return 'expand';
  }
  return 'tighten';
}

/** Apply a demo transform by action id (clamped to 'tighten' if unknown). */
export function mockTransform(actionId: string, text: string): string {
  return (TRANSFORMS[actionId] ?? TRANSFORMS.tighten)(text);
}
