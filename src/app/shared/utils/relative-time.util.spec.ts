import { describe, expect, it } from 'vitest';
import { relativeTimeLabel } from './relative-time.util';

describe('relative time labels', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');

  it.each([
    [-60, 'justNow', undefined],
    [0, 'justNow', undefined],
    [59, 'justNow', undefined],
    [60, 'minutesAgo', 1],
    [3599, 'minutesAgo', 59],
    [3600, 'hoursAgo', 1],
    [86399, 'hoursAgo', 23],
    [86400, 'daysAgo', 1],
    [172800, 'daysAgo', 2],
  ] as const)('formats %s seconds ago at unit boundaries', (seconds, key, count) => {
    const label = relativeTimeLabel(new Date(now - seconds * 1000).toISOString(), now);
    expect(label?.key).toBe(`shared.transferActivity.time.${key}`);
    expect(label?.params?.['count']).toBe(count);
  });

  it('returns no label for missing or invalid timestamps', () => {
    expect(relativeTimeLabel('', now)).toBeNull();
    expect(relativeTimeLabel('invalid', now)).toBeNull();
    expect(relativeTimeLabel('2026-10-22T12:00:00Z', NaN)).toBeNull();
  });
});
