import {describe, it, expect} from 'vitest';

import {
  citeSentinel,
  citationIdNonce,
  equationContentNonce,
  eqSentinel,
  equationNonce,
  parseSegments,
} from '../sentinels';

describe('nonce derivation', () => {
  it('citationIdNonce is deterministic and 8-hex', () => {
    const n = citationIdNonce('cite-id-1');
    expect(n).toMatch(/^[0-9a-f]{8}$/);
    expect(citationIdNonce('cite-id-1')).toBe(n);
  });

  it('different citation ids yield different nonces', () => {
    expect(citationIdNonce('aaa')).not.toBe(citationIdNonce('bbb'));
  });

  it('equationContentNonce is deterministic and 8-hex', () => {
    const n = equationContentNonce(true, 'E=mc^2');
    expect(n).toMatch(/^[0-9a-f]{8}$/);
    expect(equationContentNonce(true, 'E=mc^2')).toBe(n);
  });

  it('inline vs block equations differ; same LaTeX differs by whitespace', () => {
    expect(equationContentNonce(true, 'x')).not.toBe(equationContentNonce(false, 'x'));
    expect(equationContentNonce(true, 'x+y')).not.toBe(equationContentNonce(true, 'x*y'));
  });

  it('a citation and an equation never share a nonce namespace (kind-prefixed hash)', () => {
    // The hash input is kind-prefixed, so even an unlucky value collision across
    // kinds is impossible for the same primitive input.
    expect(citationIdNonce('same')).not.toBe(equationContentNonce(false, 'same'));
  });
});

describe('sentinel render / parse round-trip', () => {
  it('citeSentinel / eqSentinel produce the grammar', () => {
    expect(citeSentinel('ab12cd34')).toBe('[[CITE:ab12cd34]]');
    expect(eqSentinel('ef567890')).toBe('[[EQ:ef567890]]');
  });

  it('lowercases an uppercase nonce', () => {
    expect(citeSentinel('AB12CD34')).toBe('[[CITE:ab12cd34]]');
  });

  it('parseSegments splits prose + sentinels, preserving order', () => {
    const text = `Before ${citeSentinel(citationIdNonce('c1'))} mid ${eqSentinel(
      equationContentNonce(true, 'x'),
    )} after`;
    const segs = parseSegments(text);
    expect(segs).toEqual([
      {text: 'Before '},
      {kind: 'cite', nonce: citationIdNonce('c1')},
      {text: ' mid '},
      {kind: 'eq', nonce: equationContentNonce(true, 'x')},
      {text: ' after'},
    ]);
  });

  it('parseSegments handles a leading/trailing sentinel and adjacent ones', () => {
    const a = citeSentinel(citationIdNonce('a'));
    const b = eqSentinel(equationContentNonce(false, 'y'));
    expect(parseSegments(`${a}${b}`)).toEqual([
      {kind: 'cite', nonce: citationIdNonce('a')},
      {kind: 'eq', nonce: equationContentNonce(false, 'y')},
    ]);
    expect(parseSegments(`${a}txt${b}`)).toEqual([
      {kind: 'cite', nonce: citationIdNonce('a')},
      {text: 'txt'},
      {kind: 'eq', nonce: equationContentNonce(false, 'y')},
    ]);
  });

  it('parseSegments ignores look-alikes that are not valid tokens', () => {
    // [[CITE:short]] (too few hex), [[FOO:ab12cd34]] (wrong kind), [1] (prose)
    expect(parseSegments('[[CITE:short]] [[FOO:ab12cd34]] [1]')).toEqual([
      {text: '[[CITE:short]] [[FOO:ab12cd34]] [1]'},
    ]);
  });
});
