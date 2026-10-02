import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  TEST_DAY_END,
  TEST_DAY_START,
  isoAt,
} from '@hushbox/shared/test-time';
import { utcDayKey } from './period.js';

describe('utcDayKey', () => {
  it('keys by the UTC calendar day', () => {
    const midAfternoon = new Date(TEST_DAY_START + 15 * HOUR_MS + 4 * MINUTE_MS + 5 * SECOND_MS);

    expect(utcDayKey(midAfternoon)).toBe('2026-01-15');
  });

  it('crosses the day boundary on UTC, not local time', () => {
    expect(utcDayKey(new Date(TEST_DAY_END))).toBe(isoAt(TEST_DAY_START).slice(0, 10));
    expect(utcDayKey(new Date(TEST_DAY_END + 1))).toBe(isoAt(TEST_DAY_START + DAY_MS).slice(0, 10));
  });
});
