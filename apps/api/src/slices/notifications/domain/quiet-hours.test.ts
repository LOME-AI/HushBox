import { describe, it, expect } from 'vitest';
import { DAY_MS, HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { isWithinQuietHours, localMinutesOfDay } from './quiet-hours.js';

// Noon on the shared anchor day, which falls in winter — so New York is on
// standard time and the western-zone cases carry no daylight-saving shift.
const NOON_UTC = new Date(TEST_DAY_START + 12 * HOUR_MS);
const ANCHOR = new Date(TEST_DAY_START);

describe('localMinutesOfDay', () => {
  it('places a UTC instant into a western zone', () => {
    // New York in January is UTC-5.
    expect(localMinutesOfDay(NOON_UTC, 'America/New_York')).toBe(7 * 60);
  });

  it('places a UTC instant into an eastern zone', () => {
    // Tokyo is UTC+9.
    expect(localMinutesOfDay(NOON_UTC, 'Asia/Tokyo')).toBe(21 * 60);
  });

  it('resolves a half-hour-offset zone', () => {
    // Kolkata is UTC+5:30 — the offset is not a whole number of hours.
    expect(localMinutesOfDay(NOON_UTC, 'Asia/Kolkata')).toBe(17 * 60 + 30);
  });

  it('follows daylight saving for the same zone across the year', () => {
    // The same calendar day six months on, when New York is on EDT (UTC-4).
    const summer = new Date(
      Date.UTC(ANCHOR.getUTCFullYear(), ANCHOR.getUTCMonth() + 6, ANCHOR.getUTCDate(), 12)
    );
    expect(localMinutesOfDay(summer, 'America/New_York')).toBe(8 * 60);
  });

  it('reports midnight as minute zero, never 1440', () => {
    // Five hours past midnight UTC is midnight in New York (UTC-5).
    const midnightNy = new Date(TEST_DAY_START + 5 * HOUR_MS);
    expect(localMinutesOfDay(midnightNy, 'America/New_York')).toBe(0);
  });
});

describe('isWithinQuietHours', () => {
  it('suppresses inside a same-day window', () => {
    // A window that opens an hour before the instant's local time and closes an
    // hour after it → inside.
    expect(isWithinQuietHours(NOON_UTC, 6 * 60, 8 * 60, 'America/New_York')).toBe(true);
  });

  it('does not suppress before a same-day window opens', () => {
    // A window that opens an hour after the instant's local time → before it.
    expect(isWithinQuietHours(NOON_UTC, 8 * 60, 9 * 60, 'America/New_York')).toBe(false);
  });

  it('treats the window start as inclusive', () => {
    // The instant's local time is exactly the window start → inside.
    expect(isWithinQuietHours(NOON_UTC, 7 * 60, 8 * 60, 'America/New_York')).toBe(true);
  });

  it('treats the window end as exclusive', () => {
    // The instant's local time is exactly the window end → outside.
    expect(isWithinQuietHours(NOON_UTC, 6 * 60, 7 * 60, 'America/New_York')).toBe(false);
  });

  it('suppresses in the late arm of a cross-midnight window', () => {
    // Three hours past midnight UTC is late evening in New York, the day before
    // — the late arm of the cross-midnight window.
    const lateNight = new Date(TEST_DAY_START + DAY_MS + 3 * HOUR_MS);
    expect(isWithinQuietHours(lateNight, 22 * 60, 6 * 60, 'America/New_York')).toBe(true);
  });

  it('suppresses in the early arm of a cross-midnight window', () => {
    // Ten hours past midnight UTC is early morning in New York — the early arm.
    const earlyMorning = new Date(TEST_DAY_START + DAY_MS + 10 * HOUR_MS);
    expect(isWithinQuietHours(earlyMorning, 22 * 60, 6 * 60, 'America/New_York')).toBe(true);
  });

  it('does not suppress in the daytime gap of a cross-midnight window', () => {
    // Noon UTC is morning in New York → the gap between the window's two arms.
    expect(isWithinQuietHours(NOON_UTC, 22 * 60, 6 * 60, 'America/New_York')).toBe(false);
  });

  it('never suppresses for a zero-length window', () => {
    // Degenerate start === end → empty window, no suppression.
    expect(isWithinQuietHours(NOON_UTC, 7 * 60, 7 * 60, 'America/New_York')).toBe(false);
  });

  it('evaluates the window in the stored zone, not UTC', () => {
    // Same instant, same window: evening in Tokyo → inside…
    expect(isWithinQuietHours(NOON_UTC, 20 * 60, 6 * 60, 'Asia/Tokyo')).toBe(true);
    // …while in New York the same instant is morning → outside.
    expect(isWithinQuietHours(NOON_UTC, 20 * 60, 6 * 60, 'America/New_York')).toBe(false);
  });
});
