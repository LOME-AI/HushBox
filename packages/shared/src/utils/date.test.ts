import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  TEST_DAY_END,
  TEST_DAY_START,
  TEST_MONTH_END_DAY_START,
  TEST_MONTH_START,
  TEST_YEAR_START,
  isoAt,
  setClock,
} from '../testing/test-time';
import {
  getUtcMidnight,
  needsResetBeforeMidnight,
  secondsUntilNextUtcMidnight,
  utcDayKey,
  utcDayKeyAt,
} from './date';

describe('date utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getUtcMidnight', () => {
    it('returns midnight UTC for the current day', () => {
      setClock(TEST_DAY_START + 14 * HOUR_MS + 30 * MINUTE_MS + 45 * SECOND_MS + 123);

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe(isoAt(TEST_DAY_START));
    });

    it('handles end of day correctly', () => {
      setClock(TEST_DAY_END);

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe(isoAt(TEST_DAY_START));
    });

    it('handles start of day correctly', () => {
      setClock(TEST_DAY_START + 1);

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe(isoAt(TEST_DAY_START));
    });

    it('handles month boundaries', () => {
      setClock(TEST_MONTH_START + 5 * HOUR_MS);

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe(isoAt(TEST_MONTH_START));
    });

    it('handles year boundaries', () => {
      setClock(TEST_YEAR_START + 12 * HOUR_MS);

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe(isoAt(TEST_YEAR_START));
    });
  });

  describe('secondsUntilNextUtcMidnight', () => {
    it('returns seconds remaining until next midnight', () => {
      // 9.5 hours short of the next boundary.
      setClock(TEST_DAY_START + 14 * HOUR_MS + 30 * MINUTE_MS);

      expect(secondsUntilNextUtcMidnight()).toBe(34_200);
    });

    it('returns full day at exactly midnight', () => {
      setClock(TEST_DAY_START);

      expect(secondsUntilNextUtcMidnight()).toBe(86_400);
    });

    it('returns 1 second just before midnight', () => {
      setClock(TEST_DAY_START + DAY_MS - SECOND_MS);

      expect(secondsUntilNextUtcMidnight()).toBe(1);
    });

    it('handles sub-second precision by rounding up', () => {
      // Half a second left, which must round up to a whole one.
      setClock(TEST_DAY_START + DAY_MS - SECOND_MS / 2);

      expect(secondsUntilNextUtcMidnight()).toBe(1);
    });

    it('handles month boundaries', () => {
      // An hour short of the boundary that is also a month boundary.
      setClock(TEST_MONTH_END_DAY_START + 23 * HOUR_MS);

      expect(secondsUntilNextUtcMidnight()).toBe(3600);
    });

    it('computes from an explicit reference instant, ignoring the wall clock', () => {
      // Wall clock sits at midnight (a full day would remain) — the passed
      // instant is noon, so the result must track the argument, not the clock.
      setClock(TEST_DAY_START);

      expect(secondsUntilNextUtcMidnight(new Date(TEST_DAY_START + 12 * HOUR_MS))).toBe(43_200);
    });
  });

  describe('needsResetBeforeMidnight', () => {
    it('returns true when resetAt is null', () => {
      setClock(TEST_DAY_START + 14 * HOUR_MS + 30 * MINUTE_MS);

      expect(needsResetBeforeMidnight(null)).toBe(true);
    });

    it('returns true when resetAt is before today midnight', () => {
      setClock(TEST_DAY_START + 14 * HOUR_MS + 30 * MINUTE_MS);

      const resetAt = new Date(TEST_DAY_START - DAY_MS + 12 * HOUR_MS);

      expect(needsResetBeforeMidnight(resetAt)).toBe(true);
    });

    it('returns false when resetAt is today', () => {
      setClock(TEST_DAY_START + 14 * HOUR_MS + 30 * MINUTE_MS);

      const resetAt = new Date(TEST_DAY_START);

      expect(needsResetBeforeMidnight(resetAt)).toBe(false);
    });

    it('returns false when resetAt is after today midnight', () => {
      setClock(TEST_DAY_START + 14 * HOUR_MS + 30 * MINUTE_MS);

      const resetAt = new Date(TEST_DAY_START + 12 * HOUR_MS);

      expect(needsResetBeforeMidnight(resetAt)).toBe(false);
    });

    it('returns true exactly at day boundary transition', () => {
      setClock(TEST_DAY_START + 1);

      const resetAt = new Date(TEST_DAY_START - DAY_MS);

      expect(needsResetBeforeMidnight(resetAt)).toBe(true);
    });
  });

  describe('utcDayKey', () => {
    it('returns the UTC calendar day as YYYY-MM-DD', () => {
      const midAfternoon = new Date(
        TEST_DAY_START + 14 * HOUR_MS + 30 * MINUTE_MS + 45 * SECOND_MS + 123
      );

      expect(utcDayKey(midAfternoon)).toBe('2026-01-15');
    });

    it('is byte-identical to the prior inline `toISOString().slice(0, 10)`', () => {
      // Midnight, the last millisecond of a year, and midday: the three shapes whose
      // day key the truncation could get wrong.
      for (const ms of [TEST_DAY_START, TEST_YEAR_START - 1, TEST_DAY_START + 12 * HOUR_MS]) {
        const d = new Date(ms);
        expect(utcDayKey(d)).toBe(d.toISOString().slice(0, 10));
      }
    });

    it('keys by UTC, not local time', () => {
      // Late evening UTC is still the same UTC day whatever the host timezone.
      const lateEvening = new Date(TEST_DAY_START + 23 * HOUR_MS + 30 * MINUTE_MS);

      expect(utcDayKey(lateEvening)).toBe('2026-01-15');
    });
  });

  describe('utcDayKeyAt', () => {
    it('keys an instant given in milliseconds', () => {
      expect(utcDayKeyAt(TEST_DAY_START + 14 * HOUR_MS)).toBe('2026-01-15');
    });

    it('keys the last millisecond of a day to that day, and the next to the next', () => {
      expect(utcDayKeyAt(TEST_DAY_END)).toBe('2026-01-15');
      expect(utcDayKeyAt(TEST_DAY_END + 1)).toBe('2026-01-16');
    });
  });
});
