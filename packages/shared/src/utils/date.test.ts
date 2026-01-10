import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { getUtcMidnight, needsResetBeforeMidnight } from './date';

describe('date utilities', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('getUtcMidnight', () => {
    it('returns midnight UTC for the current day', () => {
      // Set to 2024-01-15 14:30:45.123 UTC
      vi.setSystemTime(new Date('2024-01-15T14:30:45.123Z'));

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });

    it('handles end of day correctly', () => {
      // Set to 2024-01-15 23:59:59.999 UTC
      vi.setSystemTime(new Date('2024-01-15T23:59:59.999Z'));

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });

    it('handles start of day correctly', () => {
      // Set to 2024-01-15 00:00:00.001 UTC
      vi.setSystemTime(new Date('2024-01-15T00:00:00.001Z'));

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe('2024-01-15T00:00:00.000Z');
    });

    it('handles month boundaries', () => {
      // Set to 2024-02-01 05:00:00 UTC
      vi.setSystemTime(new Date('2024-02-01T05:00:00.000Z'));

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe('2024-02-01T00:00:00.000Z');
    });

    it('handles year boundaries', () => {
      // Set to 2024-01-01 12:00:00 UTC
      vi.setSystemTime(new Date('2024-01-01T12:00:00.000Z'));

      const midnight = getUtcMidnight();

      expect(midnight.toISOString()).toBe('2024-01-01T00:00:00.000Z');
    });
  });

  describe('needsResetBeforeMidnight', () => {
    it('returns true when resetAt is null', () => {
      vi.setSystemTime(new Date('2024-01-15T14:30:00.000Z'));

      expect(needsResetBeforeMidnight(null)).toBe(true);
    });

    it('returns true when resetAt is before today midnight', () => {
      // Current time: 2024-01-15 14:30 UTC
      vi.setSystemTime(new Date('2024-01-15T14:30:00.000Z'));

      // Reset was yesterday
      const resetAt = new Date('2024-01-14T12:00:00.000Z');

      expect(needsResetBeforeMidnight(resetAt)).toBe(true);
    });

    it('returns false when resetAt is today', () => {
      // Current time: 2024-01-15 14:30 UTC
      vi.setSystemTime(new Date('2024-01-15T14:30:00.000Z'));

      // Reset was today at midnight
      const resetAt = new Date('2024-01-15T00:00:00.000Z');

      expect(needsResetBeforeMidnight(resetAt)).toBe(false);
    });

    it('returns false when resetAt is after today midnight', () => {
      // Current time: 2024-01-15 14:30 UTC
      vi.setSystemTime(new Date('2024-01-15T14:30:00.000Z'));

      // Reset was today at noon
      const resetAt = new Date('2024-01-15T12:00:00.000Z');

      expect(needsResetBeforeMidnight(resetAt)).toBe(false);
    });

    it('returns true exactly at day boundary transition', () => {
      // Current time: 2024-01-15 00:00:00.001 UTC (just past midnight)
      vi.setSystemTime(new Date('2024-01-15T00:00:00.001Z'));

      // Reset was yesterday at midnight
      const resetAt = new Date('2024-01-14T00:00:00.000Z');

      expect(needsResetBeforeMidnight(resetAt)).toBe(true);
    });
  });
});
