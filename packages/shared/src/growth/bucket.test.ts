import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';

import { growthDayBucket, growthHourBucket } from './bucket.ts';

/** The reference day, as the day grain labels it. */
const DAY = growthDayBucket(new Date(TEST_DAY_START));

describe('growthHourBucket', () => {
  it('formats the UTC hour a moment falls in', () => {
    expect(growthHourBucket(new Date(TEST_DAY_START + 14 * HOUR_MS))).toBe(`${DAY}T14`);
  });

  // A local-time bucket would need a client timezone, which is spoofable, and
  // would produce overlapping windows across zones.
  it('reads the hour in UTC rather than in the running process timezone', () => {
    expect(growthHourBucket(new Date(TEST_DAY_START + DAY_MS - 1))).toBe(`${DAY}T23`);
  });

  it('pads an hour below ten to two digits', () => {
    expect(growthHourBucket(new Date(TEST_DAY_START + 4 * HOUR_MS))).toBe(`${DAY}T04`);
  });
});

describe('growthDayBucket', () => {
  it('formats the UTC day a moment falls in', () => {
    expect(growthDayBucket(new Date(TEST_DAY_START + 14 * HOUR_MS))).toBe(DAY);
  });

  it('keeps the last hour of a UTC day on that day', () => {
    expect(growthDayBucket(new Date(TEST_DAY_START + DAY_MS - 1))).toBe(DAY);
  });

  it('moves to the next day one millisecond later', () => {
    expect(growthDayBucket(new Date(TEST_DAY_START + DAY_MS))).not.toBe(DAY);
  });

  // Eleven days before the reference day lands on the fourth of the first
  // month, so one instant covers a month and a day that both need padding.
  it('pads a month and a day below ten to two digits', () => {
    expect(growthDayBucket(new Date(TEST_DAY_START - 11 * DAY_MS))).toBe('2026-01-04');
  });
});
