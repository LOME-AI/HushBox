import { afterEach, describe, expect, it, vi } from 'vitest';
import { TEST_DAY_START, freezeClock, isoAt } from '@hushbox/shared/test-time';
import { formatReplyDate } from './reply-date';

const REFERENCE_DAY = new Date(TEST_DAY_START);

/**
 * An instant on the local calendar, `dayOffset` days from the reference day. Read at call
 * time, so it follows a timezone a test stubs.
 */
function localInstant(dayOffset: number, hours = 0, minutes = 0): number {
  return new Date(
    REFERENCE_DAY.getUTCFullYear(),
    REFERENCE_DAY.getUTCMonth(),
    REFERENCE_DAY.getUTCDate() + dayOffset,
    hours,
    minutes
  ).getTime();
}

function frozenNow(instantMs: number): Date {
  freezeClock(instantMs);
  return new Date();
}

function utcDay(instantMs: number): string {
  return isoAt(instantMs).slice(0, 10);
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('formatReplyDate', () => {
  it("reads Today for a reply made earlier on the viewer's current day", () => {
    const now = frozenNow(localInstant(0, 18));

    expect(formatReplyDate(isoAt(localInstant(0, 9)), now)).toBe('Today');
  });

  it('reads the date for a reply made on an earlier day', () => {
    const now = frozenNow(localInstant(0, 9));

    expect(formatReplyDate(isoAt(localInstant(-1, 18)), now)).toBe('2026-01-14');
  });

  it('pads a single-digit month and day to two digits', () => {
    const now = frozenNow(localInstant(0, 9));

    expect(formatReplyDate(isoAt(localInstant(-10, 12)), now)).toBe('2026-01-05');
  });

  it('reads the date for a reply made in an earlier year', () => {
    const now = frozenNow(localInstant(0, 9));

    expect(formatReplyDate(isoAt(localInstant(-15, 12)), now)).toBe('2025-12-31');
  });

  it('refuses a stamp that names no instant', () => {
    const now = frozenNow(localInstant(0, 9));

    expect(() => formatReplyDate('', now)).toThrow(RangeError);
  });

  describe('in a timezone behind UTC', () => {
    it('reads Today for the local current day though the UTC day differs', () => {
      vi.stubEnv('TZ', 'America/Los_Angeles');
      const nowMs = localInstant(0, 23, 30);
      const createdMs = localInstant(0, 0, 30);
      const now = frozenNow(nowMs);

      expect(new Date(nowMs).getTimezoneOffset()).not.toBe(0);
      expect(utcDay(createdMs)).not.toBe(utcDay(nowMs));
      expect(formatReplyDate(isoAt(createdMs), now)).toBe('Today');
    });
  });

  describe('in a timezone ahead of UTC', () => {
    it('reads the local date of a reply from the local previous day though it shares the UTC day', () => {
      vi.stubEnv('TZ', 'Pacific/Auckland');
      const nowMs = localInstant(0, 0, 30);
      const createdMs = localInstant(-1, 23, 30);
      const now = frozenNow(nowMs);

      expect(new Date(nowMs).getTimezoneOffset()).not.toBe(0);
      expect(utcDay(createdMs)).toBe(utcDay(nowMs));
      expect(formatReplyDate(isoAt(createdMs), now)).toBe('2026-01-14');
    });
  });
});
