import { MAX_GROWTH_READ_WINDOW_DAYS } from '@hushbox/shared';
import type { GrowthWindow } from './use-growth-reads.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** A day as the date controls spell one, which is how a day string is read back. */
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The Monday that starts the week an instant falls in, at UTC midnight. The
 * views bucket weeks with Postgres `date_trunc('week', …, 'UTC')`, which is
 * Monday-based, so a picker built on any other week start would ask for
 * boundaries no row sits on.
 */
export function isoWeekStart(instant: Date): Date {
  const start = new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate())
  );
  // getUTCDay is Sunday-based; the ISO week runs Monday to Sunday, so Sunday
  // is six days into its week rather than the start of a new one.
  const offset = (start.getUTCDay() + 6) % 7;
  return new Date(start.getTime() - offset * DAY_MS);
}

/** The half-open window covering one week from its Monday. */
export function weekWindow(weekStart: Date): GrowthWindow {
  return {
    from: weekStart.toISOString(),
    to: new Date(weekStart.getTime() + 7 * DAY_MS).toISOString(),
  };
}

/** The two days an operator names, each inclusive, as the date controls carry them. */
export interface DayRange {
  readonly start: string;
  readonly end: string;
}

/**
 * The range the page reads over: the days the controls show, the window the
 * reads ask for, and the reason those two differ.
 *
 * They differ because a refused edit keeps its window. A control that reverted
 * what was typed would fight an operator mid-entry — a half-typed day reads as
 * no day at all — and one that let the refused range through would spend a read
 * on a window the server rejects, which is the refusal this page owes in the
 * interface rather than over the wire.
 */
export interface RangeSelection {
  readonly shown: DayRange;
  readonly window: GrowthWindow;
  readonly refusal: string | null;
}

/** The day an instant falls in, as the date controls spell one. */
export function dayOf(instant: Date): string {
  return instant.toISOString().slice(0, 10);
}

/** The UTC midnight that starts the day an instant falls in. */
function dayStartOf(instant: Date): number {
  return Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate());
}

/** The UTC midnight a day string names, or null where it names no day. */
function dayStart(day: string): number | null {
  if (!DAY_PATTERN.test(day)) return null;
  const parsed = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

/** The half-open window covering both midnights whole, the later day included. */
function windowBetween(startMs: number, endMs: number): GrowthWindow {
  return { from: new Date(startMs).toISOString(), to: new Date(endMs + DAY_MS).toISOString() };
}

/**
 * The window a range asks for, or why it cannot be read. The width is counted
 * in whole days with both ends included, against the same cap the read
 * operations enforce, so the interface refuses exactly what the server would.
 */
function windowOrRefusal(
  days: DayRange
): { readonly window: GrowthWindow } | { readonly refusal: string } {
  const start = dayStart(days.start);
  const end = dayStart(days.end);
  if (start === null || end === null) return { refusal: 'Pick a start day and an end day.' };
  if (end < start) return { refusal: 'The end day cannot fall before the start day.' };
  if ((end - start) / DAY_MS + 1 > MAX_GROWTH_READ_WINDOW_DAYS) {
    return { refusal: `Pick a range of at most ${String(MAX_GROWTH_READ_WINDOW_DAYS)} days.` };
  }
  return { window: windowBetween(start, end) };
}

/** The range the page opens on: the given number of days up to the day it opens in. */
export function initialRange(now: Date, days: number): RangeSelection {
  const end = dayStartOf(now);
  const start = end - (days - 1) * DAY_MS;
  return {
    shown: { start: dayOf(new Date(start)), end: dayOf(new Date(end)) },
    window: windowBetween(start, end),
    refusal: null,
  };
}

/** The selection after an operator changes a day, which a refused range leaves reading its old window. */
export function editedRange(current: RangeSelection, shown: DayRange): RangeSelection {
  const outcome = windowOrRefusal(shown);
  return 'refusal' in outcome
    ? { shown, window: current.window, refusal: outcome.refusal }
    : { shown, window: outcome.window, refusal: null };
}

/** What a window covers, in the terms a panel states its span in. */
export function windowSpan(window: GrowthWindow): {
  readonly days: number;
  readonly endDay: string;
} {
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  return { days: (to - from) / DAY_MS, endDay: dayOf(new Date(to - DAY_MS)) };
}

/**
 * The most recent weeks, newest first, for the week picker and the sparklines.
 * Non-empty by construction: the week the caller is standing in is always the
 * first of them, which is what lets the screen take an oldest week without a
 * fallback for a list that cannot be empty.
 */
export function weekOptions(now: Date, count: number): readonly [Date, ...Date[]] {
  const latest = isoWeekStart(now);
  return [
    latest,
    ...Array.from(
      { length: Math.max(count - 1, 0) },
      (_, index) => new Date(latest.getTime() - (index + 1) * 7 * DAY_MS)
    ),
  ];
}

/**
 * The window covering the given number of weeks up to and including the one the
 * caller is standing in — the ladder's span, and so the sparklines' too.
 */
export function cohortWindow(now: Date, weeks: number): GrowthWindow {
  const latest = isoWeekStart(now);
  return {
    from: new Date(latest.getTime() - Math.max(weeks - 1, 0) * 7 * DAY_MS).toISOString(),
    to: now.toISOString(),
  };
}

/** A week named by the day it starts, which is how every ladder row is keyed. */
export function formatWeekLabel(weekStart: Date): string {
  return `Week of ${dayOf(weekStart)}`;
}
