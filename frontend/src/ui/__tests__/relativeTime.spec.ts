import {describe, it, expect} from 'vitest';

import {relativeTime} from '../CheckpointsList';

const NOW = 1_800_000_000_000; // fixed reference point

describe('relativeTime', () => {
  it('fresh timestamps read "just now" (and future clamps)', () => {
    expect(relativeTime(NOW - 5_000, NOW)).toBe('just now');
    expect(relativeTime(NOW + 60_000, NOW)).toBe('just now');
  });

  it('minutes then hours then days', () => {
    expect(relativeTime(NOW - 3 * 60_000, NOW)).toBe('3m ago');
    expect(relativeTime(NOW - 59 * 60_000, NOW)).toBe('59m ago');
    expect(relativeTime(NOW - 2 * 3_600_000, NOW)).toBe('2h ago');
    expect(relativeTime(NOW - 23 * 3_600_000, NOW)).toBe('23h ago');
    expect(relativeTime(NOW - 24 * 3_600_000, NOW)).toBe('yesterday');
    expect(relativeTime(NOW - 5 * 86_400_000, NOW)).toBe('5d ago');
  });

  it('falls back to a date past a week', () => {
    const ts = NOW - 10 * 86_400_000;
    expect(relativeTime(ts, NOW)).toBe(new Date(ts).toLocaleDateString());
  });
});
