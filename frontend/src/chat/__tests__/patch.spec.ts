import {describe, it, expect} from 'vitest';

import {
  actionEdits,
  extractPartialAction,
  extractRememberAction,
  extractThinking,
  extractToolAction,
  stripMarkup,
} from '../patch';

describe('stripMarkup — leaks fixed (#6/#7)', () => {
  it('strips a single closed <thinking> block', () => {
    expect(stripMarkup('<thinking>reasoning</thinking>Hello')).toBe('Hello');
  });

  it('strips an unclosed <thinking> tail (streaming)', () => {
    expect(stripMarkup('prose<thinking>partial')).toBe('prose');
  });

  it('strips a single closed <action> block', () => {
    const out = stripMarkup('before <action>{"kind":"finish"}</action> after');
    expect(out).not.toContain('<action>');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('strips an unclosed <action> tail (streaming)', () => {
    expect(stripMarkup('prose <action>{"kind":"patch"')).toBe('prose');
  });

  // REGRESSION: before the global-flag fix, a SECOND block leaked as literal text.
  it('strips TWO <thinking> blocks (second used to leak)', () => {
    expect(stripMarkup('<thinking>a</thinking>mid<thinking>b</thinking>end')).toBe(
      'midend',
    );
  });

  it('strips TWO closed <action> blocks (second used to leak)', () => {
    const out = stripMarkup(
      'x <action>{"kind":"read"}</action> y <action>{"kind":"finish"}</action> z',
    );
    expect(out).not.toContain('<action>');
    expect(out).not.toContain('</action>');
    expect(out).toContain('x');
    expect(out).toContain('y');
    expect(out).toContain('z');
  });

  it('strips a closed + an unclosed <action> together', () => {
    const out = stripMarkup(
      '<action>{"kind":"finish"}</action> tail <action>{"kind":"patch","edits":[',
    );
    expect(out).not.toContain('<action>');
    expect(out).toContain('tail');
  });
});

describe('parsers keep first-match semantics (unchanged by the strip fix)', () => {
  it('extractThinking returns the FIRST thinking block', () => {
    expect(
      extractThinking('<thinking>first</thinking>x<thinking>second</thinking>'),
    ).toBe('first');
  });

  it('extractToolAction honors the FIRST action block', () => {
    const raw =
      '<action>{"kind":"read"}</action> <action>{"kind":"search","query":"x"}</action>';
    expect(extractToolAction(raw)).toEqual({kind: 'read', query: undefined});
  });

  it('actionEdits reads edits from the FIRST action only', () => {
    const raw =
      '<action>{"kind":"patch","edits":[{"search":"a","replace":"b"}]}</action>' +
      '<action>{"kind":"patch","edits":[{"search":"c","replace":"d"}]}</action>';
    expect(actionEdits(raw)).toEqual([{search: 'a', replace: 'b'}]);
  });

  it('extractRememberAction parses a remember note', () => {
    expect(
      extractRememberAction('<action>{"kind":"remember","note":"be brief"}</action>'),
    ).toEqual({note: 'be brief'});
  });

  it('extractPartialAction returns null for a non-terminal kind (read)', () => {
    expect(extractPartialAction('<action>{"kind":"read"}</action>')).toBeNull();
  });
});
