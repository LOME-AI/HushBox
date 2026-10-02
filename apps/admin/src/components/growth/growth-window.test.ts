import { describe, expect, it } from 'vitest';
import { MAX_GROWTH_READ_WINDOW_DAYS } from '@hushbox/shared';
import { DAY_MS, HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  isoWeekStart,
  weekWindow,
  weekOptions,
  formatWeekLabel,
  cohortWindow,
  dayOf,
  initialRange,
  editedRange,
  windowSpan,
} from './growth-window.js';

/**
 * The reference day is a Thursday, so its own week began three days earlier.
 * Every instant below is that Monday plus a duration: the module under test is
 * all calendar arithmetic, and a literal date would both fix the answers in
 * place and disclose a calendar day nothing here depends on.
 */
const WEEK_START = TEST_DAY_START - 3 * DAY_MS;
const NEXT_WEEK_START = WEEK_START + 7 * DAY_MS;

/** The day an instant falls in, as the date controls spell one. */
function dayAt(instantMs: number): string {
  return isoAt(instantMs).slice(0, 10);
}

/** A ninety-day selection ending on the reference day, as the screen opens on one. */
function openingRange(): ReturnType<typeof initialRange> {
  return initialRange(new Date(TEST_DAY_START), 90);
}

describe('isoWeekStart', () => {
  it('moves a mid-week instant back to the Monday that starts its week', () => {
    expect(isoWeekStart(new Date(TEST_DAY_START + 14 * HOUR_MS)).toISOString()).toBe(
      isoAt(WEEK_START)
    );
  });

  it('leaves a Monday at the start of its own week', () => {
    expect(isoWeekStart(new Date(WEEK_START)).toISOString()).toBe(isoAt(WEEK_START));
  });

  it('treats Sunday as the last day of the week that began six days earlier', () => {
    const lastSecondOfSunday = WEEK_START + 7 * DAY_MS - 1000;
    expect(isoWeekStart(new Date(lastSecondOfSunday)).toISOString()).toBe(isoAt(WEEK_START));
  });
});

describe('weekWindow', () => {
  it('spans exactly the seven days from the given Monday', () => {
    expect(weekWindow(new Date(WEEK_START))).toEqual({
      from: isoAt(WEEK_START),
      to: isoAt(NEXT_WEEK_START),
    });
  });
});

describe('weekOptions', () => {
  it('lists the requested number of weeks, most recent first', () => {
    const weeks = weekOptions(new Date(TEST_DAY_START), 3);
    expect(weeks.map((week) => week.toISOString())).toEqual([
      isoAt(WEEK_START),
      isoAt(WEEK_START - 7 * DAY_MS),
      isoAt(WEEK_START - 14 * DAY_MS),
    ]);
  });
});

describe('formatWeekLabel', () => {
  it('names a week by the day it starts', () => {
    expect(formatWeekLabel(new Date(WEEK_START))).toBe(`Week of ${isoAt(WEEK_START).slice(0, 10)}`);
  });
});

describe('weekOptions bounds', () => {
  it('still lists the current week when only one is asked for', () => {
    const weeks = weekOptions(new Date(TEST_DAY_START), 1);
    expect(weeks.map((week) => week.toISOString())).toEqual([isoAt(WEEK_START)]);
  });

  it('never returns an empty list, however few weeks are asked for', () => {
    expect(weekOptions(new Date(TEST_DAY_START), 0)).toHaveLength(1);
  });
});

describe('cohortWindow', () => {
  it('reaches back from the current week by the number of weeks asked for', () => {
    expect(cohortWindow(new Date(TEST_DAY_START), 12)).toEqual({
      from: isoAt(WEEK_START - 11 * 7 * DAY_MS),
      to: isoAt(TEST_DAY_START),
    });
  });

  it('covers the current week alone when only one is asked for', () => {
    expect(cohortWindow(new Date(TEST_DAY_START), 1).from).toBe(isoAt(WEEK_START));
  });

  it('never reaches forward, however few weeks are asked for', () => {
    expect(cohortWindow(new Date(TEST_DAY_START), 0).from).toBe(isoAt(WEEK_START));
  });
});

describe('dayOf', () => {
  it('names the day an instant falls in', () => {
    expect(dayOf(new Date(TEST_DAY_START + 14 * HOUR_MS))).toBe(dayAt(TEST_DAY_START));
  });
});

describe('initialRange', () => {
  it('shows the requested number of days ending on the day it opens in', () => {
    expect(initialRange(new Date(TEST_DAY_START + 14 * HOUR_MS), 90).shown).toEqual({
      start: dayAt(TEST_DAY_START - 89 * DAY_MS),
      end: dayAt(TEST_DAY_START),
    });
  });

  it('asks for a window running from the first day it shows to the end of the last', () => {
    expect(openingRange().window).toEqual({
      from: isoAt(TEST_DAY_START - 89 * DAY_MS),
      to: isoAt(TEST_DAY_START + DAY_MS),
    });
  });

  it('refuses nothing before an operator has set anything', () => {
    expect(openingRange().refusal).toBeNull();
  });
});

describe('editedRange', () => {
  it('moves the window to the range an operator set', () => {
    const edited = editedRange(openingRange(), {
      start: dayAt(TEST_DAY_START - 13 * DAY_MS),
      end: dayAt(TEST_DAY_START - 7 * DAY_MS),
    });
    expect(edited.window).toEqual({
      from: isoAt(TEST_DAY_START - 13 * DAY_MS),
      to: isoAt(TEST_DAY_START - 6 * DAY_MS),
    });
  });

  it('shows the days an operator set', () => {
    const days = {
      start: dayAt(TEST_DAY_START - 13 * DAY_MS),
      end: dayAt(TEST_DAY_START - 7 * DAY_MS),
    };
    expect(editedRange(openingRange(), days).shown).toEqual(days);
  });

  it('keeps the window it had when the end day falls before the start day', () => {
    const opening = openingRange();
    const edited = editedRange(opening, {
      start: dayAt(TEST_DAY_START),
      end: dayAt(TEST_DAY_START - DAY_MS),
    });
    expect(edited.window).toEqual(opening.window);
  });

  it('says why a range ending before it starts was refused', () => {
    const edited = editedRange(openingRange(), {
      start: dayAt(TEST_DAY_START),
      end: dayAt(TEST_DAY_START - DAY_MS),
    });
    expect(edited.refusal).toBe('The end day cannot fall before the start day.');
  });

  it('keeps the window it had when the range is wider than the read cap', () => {
    const opening = openingRange();
    const edited = editedRange(opening, {
      start: dayAt(TEST_DAY_START - MAX_GROWTH_READ_WINDOW_DAYS * DAY_MS),
      end: dayAt(TEST_DAY_START),
    });
    expect(edited.window).toEqual(opening.window);
  });

  it('names the cap when it refuses a range wider than it', () => {
    const edited = editedRange(openingRange(), {
      start: dayAt(TEST_DAY_START - MAX_GROWTH_READ_WINDOW_DAYS * DAY_MS),
      end: dayAt(TEST_DAY_START),
    });
    expect(edited.refusal).toBe(
      `Pick a range of at most ${String(MAX_GROWTH_READ_WINDOW_DAYS)} days.`
    );
  });

  it('accepts a range exactly as wide as the read cap', () => {
    const edited = editedRange(openingRange(), {
      start: dayAt(TEST_DAY_START - (MAX_GROWTH_READ_WINDOW_DAYS - 1) * DAY_MS),
      end: dayAt(TEST_DAY_START),
    });
    expect(edited.refusal).toBeNull();
  });

  it('keeps the window it had while a day is still incomplete', () => {
    const opening = openingRange();
    expect(editedRange(opening, { start: '', end: dayAt(TEST_DAY_START) }).window).toEqual(
      opening.window
    );
  });

  it('asks for both days when one of them cannot be read as a day', () => {
    expect(editedRange(openingRange(), { start: '', end: dayAt(TEST_DAY_START) }).refusal).toBe(
      'Pick a start day and an end day.'
    );
  });

  it('keeps the window it had when a day names a month the calendar has not got', () => {
    const opening = openingRange();
    expect(
      editedRange(opening, { start: '2026-13-01', end: dayAt(TEST_DAY_START) }).window
    ).toEqual(opening.window);
  });

  it('clears an earlier refusal once a range passes', () => {
    const refused = editedRange(openingRange(), {
      start: dayAt(TEST_DAY_START),
      end: dayAt(TEST_DAY_START - DAY_MS),
    });
    const accepted = editedRange(refused, {
      start: dayAt(TEST_DAY_START - DAY_MS),
      end: dayAt(TEST_DAY_START),
    });
    expect(accepted.refusal).toBeNull();
  });
});

describe('windowSpan', () => {
  it('counts every day a window covers, both ends included', () => {
    expect(windowSpan(openingRange().window).days).toBe(90);
  });

  it('names the last day a window covers rather than the one its end falls on', () => {
    expect(windowSpan(openingRange().window).endDay).toBe(dayAt(TEST_DAY_START));
  });
});
