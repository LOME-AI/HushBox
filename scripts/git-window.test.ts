import { describe, it, expect, afterAll, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import {
  DAY_MS,
  freezeClock,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  setClock,
  TEST_DAY_START,
} from '@hushbox/shared/test-time';
import {
  checkCommitWindow,
  DAY_NAMES,
  dayIndexOf,
  describeWindow,
  formatWindowValue,
  isWithinWindow,
  parseWindowArguments,
  parseWindowValue,
  setCommitWindow,
  WINDOW_CONFIG_KEY,
  type CommitWindow,
  type DayRange,
  type WindowArguments,
} from './git-window.js';
import { PRIVACY_ALLOWLIST_PATH } from './lib/privacy/allowlist.js';
import { runCommitStage, runPushStage } from './privacy-gate.js';
import { rootScripts } from './lib/root-manifest.js';

/**
 * The minute of the UTC day an instant falls on, derived from the shared
 * anchor rather than from the module under test: the anchor is UTC midnight, so
 * the elapsed minutes since it *are* the minute of the day. Every window below
 * is built from the same offsets as the instants tested against it, so a
 * boundary case cannot drift away from the boundary it is named for.
 */
const minuteOf = (instantMs: number): number => (instantMs - TEST_DAY_START) / MINUTE_MS;

const MORNING_START = TEST_DAY_START + 9 * HOUR_MS;
const EVENING_END = TEST_DAY_START + 17 * HOUR_MS + 30 * MINUTE_MS;
const DAY_WINDOW: CommitWindow = {
  startMinute: minuteOf(MORNING_START),
  endMinute: minuteOf(EVENING_END),
  enforcedDays: null,
};

/** A window that starts later in the day than it ends: the developer who works across midnight. */
const NIGHT_START = TEST_DAY_START + 22 * HOUR_MS;
const NIGHT_END = TEST_DAY_START + 6 * HOUR_MS;
const NIGHT_WINDOW: CommitWindow = {
  startMinute: minuteOf(NIGHT_START),
  endMinute: minuteOf(NIGHT_END),
  enforcedDays: null,
};

describe('isWithinWindow, on a window that does not wrap', () => {
  it('admits an instant between the two ends', () => {
    expect(isWithinWindow(DAY_WINDOW, new Date(TEST_DAY_START + 12 * HOUR_MS))).toBe(true);
  });

  it('admits the opening instant', () => {
    expect(isWithinWindow(DAY_WINDOW, new Date(MORNING_START))).toBe(true);
  });

  it('refuses the closing instant', () => {
    expect(isWithinWindow(DAY_WINDOW, new Date(EVENING_END))).toBe(false);
  });

  it('admits the last minute before the close', () => {
    expect(isWithinWindow(DAY_WINDOW, new Date(EVENING_END - MINUTE_MS))).toBe(true);
  });

  it('refuses the minute before the open', () => {
    expect(isWithinWindow(DAY_WINDOW, new Date(MORNING_START - MINUTE_MS))).toBe(false);
  });

  it('refuses an instant after the close', () => {
    expect(isWithinWindow(DAY_WINDOW, new Date(TEST_DAY_START + 20 * HOUR_MS))).toBe(false);
  });

  it('ignores seconds within an admitted minute', () => {
    const instant = new Date(EVENING_END - MINUTE_MS + 59 * SECOND_MS);
    expect(isWithinWindow(DAY_WINDOW, instant)).toBe(true);
  });

  it('judges the time of day rather than the day, so a later day decides the same', () => {
    expect(isWithinWindow(DAY_WINDOW, new Date(TEST_DAY_START + DAY_MS + 12 * HOUR_MS))).toBe(true);
  });
});

describe('isWithinWindow, on a window that wraps past midnight', () => {
  it('admits an instant on the evening side', () => {
    expect(isWithinWindow(NIGHT_WINDOW, new Date(TEST_DAY_START + 23 * HOUR_MS))).toBe(true);
  });

  it('admits an instant on the morning side', () => {
    expect(isWithinWindow(NIGHT_WINDOW, new Date(TEST_DAY_START + 2 * HOUR_MS))).toBe(true);
  });

  it('admits the opening instant', () => {
    expect(isWithinWindow(NIGHT_WINDOW, new Date(NIGHT_START))).toBe(true);
  });

  it('refuses the closing instant', () => {
    expect(isWithinWindow(NIGHT_WINDOW, new Date(NIGHT_END))).toBe(false);
  });

  it('refuses the middle of the day the window excludes', () => {
    expect(isWithinWindow(NIGHT_WINDOW, new Date(TEST_DAY_START + 12 * HOUR_MS))).toBe(false);
  });
});

/**
 * A weekday and an instant on it, both counted forward from the shared anchor
 * so that no fixture writes down a day of the week or a date.
 */
const weekdayAfter = (days: number): number => new Date(TEST_DAY_START + days * DAY_MS).getUTCDay();
const instantAfter = (days: number, intoDayMs: number): Date =>
  new Date(TEST_DAY_START + days * DAY_MS + intoDayMs);

/** An hour the window excludes, and one it includes, for the day cases below. */
const EXCLUDED_HOUR = 3 * HOUR_MS;
const INCLUDED_HOUR = 12 * HOUR_MS;

/** Enforced on the anchor day and the two after it; the remaining four are free. */
const MIDWEEK_DAYS: DayRange = { startDay: weekdayAfter(0), endDay: weekdayAfter(2) };
const MIDWEEK_WINDOW: CommitWindow = { ...DAY_WINDOW, enforcedDays: MIDWEEK_DAYS };

/**
 * Days from the anchor to the next turn of the week, where `getUTCDay()` runs
 * off the last index and back to 0. Derived from the anchor rather than written
 * down, and it is what lets the range below straddle that turn whatever weekday
 * the anchor happens to fall on: the anchor is a source of instants, never a
 * coordinate system for weekday indices.
 */
const DAYS_TO_WEEK_TURN = (DAY_NAMES.length - weekdayAfter(0)) % DAY_NAMES.length;

/**
 * Enforced from two days before the week turns over to one day after it: four
 * days on, three off. Straddling the turn is the whole point — it is the only
 * shape the modular span in the containment test exists to handle, and the
 * guard beside it fails rather than passing quietly if the range ever stops
 * having that shape.
 */
const WRAPPED_OPENS_AFTER = DAYS_TO_WEEK_TURN - 2;
const WRAPPED_CLOSES_AFTER = DAYS_TO_WEEK_TURN + 1;
const WRAPPED_DAYS: DayRange = {
  startDay: weekdayAfter(WRAPPED_OPENS_AFTER),
  endDay: weekdayAfter(WRAPPED_CLOSES_AFTER),
};
const WRAPPED_DAY_WINDOW: CommitWindow = { ...DAY_WINDOW, enforcedDays: WRAPPED_DAYS };

/** Equal ends, which name one day rather than the whole week or none of it. */
const SINGLE_DAY: DayRange = { startDay: weekdayAfter(0), endDay: weekdayAfter(0) };
const SINGLE_DAY_WINDOW: CommitWindow = { ...DAY_WINDOW, enforcedDays: SINGLE_DAY };

const WEEK = [0, 1, 2, 3, 4, 5, 6];

describe('the wrapped day range every wrapped case below is built on', () => {
  it('opens on a later day index than it closes on', () => {
    expect(WRAPPED_DAYS.startDay).toBeGreaterThan(WRAPPED_DAYS.endDay);
  });

  it('stores its two day fields in that same descending order', () => {
    const [opening = '', closing = ''] = formatWindowValue(WRAPPED_DAY_WINDOW).split('-').slice(-2);
    expect([dayIndexOf(opening), dayIndexOf(closing)]).toEqual([
      WRAPPED_DAYS.startDay,
      WRAPPED_DAYS.endDay,
    ]);
  });
});

describe('isWithinWindow, on a window enforced on some days only', () => {
  it('admits an off-day instant at an hour the window excludes', () => {
    expect(isWithinWindow(MIDWEEK_WINDOW, instantAfter(3, EXCLUDED_HOUR))).toBe(true);
  });

  it('admits an off-day instant at an hour the window includes', () => {
    expect(isWithinWindow(MIDWEEK_WINDOW, instantAfter(3, INCLUDED_HOUR))).toBe(true);
  });

  it('refuses an enforced-day instant outside the hours', () => {
    expect(isWithinWindow(MIDWEEK_WINDOW, instantAfter(1, EXCLUDED_HOUR))).toBe(false);
  });

  it('admits an enforced-day instant inside the hours', () => {
    expect(isWithinWindow(MIDWEEK_WINDOW, instantAfter(1, INCLUDED_HOUR))).toBe(true);
  });

  it('enforces on the opening day of the range', () => {
    expect(isWithinWindow(MIDWEEK_WINDOW, instantAfter(0, EXCLUDED_HOUR))).toBe(false);
  });

  it('enforces on the closing day of the range, both ends being inclusive', () => {
    expect(isWithinWindow(MIDWEEK_WINDOW, instantAfter(2, EXCLUDED_HOUR))).toBe(false);
  });

  it('enforces on the days before a wrapped range turns over', () => {
    const instant = instantAfter(DAYS_TO_WEEK_TURN - 1, EXCLUDED_HOUR);
    expect(isWithinWindow(WRAPPED_DAY_WINDOW, instant)).toBe(false);
  });

  it('enforces on the day a wrapped range turns over', () => {
    const instant = instantAfter(DAYS_TO_WEEK_TURN, EXCLUDED_HOUR);
    expect(isWithinWindow(WRAPPED_DAY_WINDOW, instant)).toBe(false);
  });

  it('enforces on the days after a wrapped range turns over', () => {
    const instant = instantAfter(WRAPPED_CLOSES_AFTER, EXCLUDED_HOUR);
    expect(isWithinWindow(WRAPPED_DAY_WINDOW, instant)).toBe(false);
  });

  it('leaves the gap a wrapped range does not cover free', () => {
    const instant = instantAfter(WRAPPED_CLOSES_AFTER + 1, EXCLUDED_HOUR);
    expect(isWithinWindow(WRAPPED_DAY_WINDOW, instant)).toBe(true);
  });

  it('enforces on the one day a range with equal ends names', () => {
    expect(isWithinWindow(SINGLE_DAY_WINDOW, instantAfter(0, EXCLUDED_HOUR))).toBe(false);
  });

  it('leaves every other day of the week free when the ends are equal', () => {
    const admitted = WEEK.slice(1).map((day) =>
      isWithinWindow(SINGLE_DAY_WINDOW, instantAfter(day, EXCLUDED_HOUR))
    );
    expect(admitted).toEqual(WEEK.slice(1).map(() => true));
  });

  it('enforces on every day of the week when no days are named', () => {
    const admitted = WEEK.map((day) =>
      isWithinWindow(DAY_WINDOW, instantAfter(day, EXCLUDED_HOUR))
    );
    expect(admitted).toEqual(WEEK.map(() => false));
  });
});

/**
 * The stored form of the window above, and its two fields. Every malformed
 * specimen below is that form mutated at the one place it is malformed, so no
 * specimen is a time somebody typed out and each one carries exactly the defect
 * it is named for.
 */
const STORED = formatWindowValue(DAY_WINDOW);
const [STORED_START = '', STORED_END = ''] = STORED.split('-');

/**
 * Day-boundary clocks, which the run's own rules admit as literals. They stand
 * in for the shapes a developer types instead of HHMM, and neither records
 * anything that happened.
 */
const COLON_FORM = '00:00';

/** A day field that is no day at all, for the cases that must refuse one. */
const UNREADABLE_DAY = 'xyz';
const MIDNIGHT_12_HOUR = '12am';
const MIDDAY_12_HOUR = '12pm';

/** Fails loudly rather than asserting `undefined.toContain` when a refusal was expected. */
function invalidMessage(outcome: WindowArguments): string {
  if (outcome.status !== 'invalid') throw new Error('expected the arguments to be refused');
  return outcome.message;
}

/**
 * A weekday as the platform spells it, counted forward from the anchor — an
 * independent derivation of the name, so the tables below are checked against
 * something other than themselves and no fixture writes a weekday down.
 */
const weekdayNameAfter = (days: number, form: 'short' | 'long'): string =>
  new Date(TEST_DAY_START + days * DAY_MS)
    .toLocaleDateString('en-US', { weekday: form, timeZone: 'UTC' })
    .toLowerCase();

const anchorWeekday = (form: 'short' | 'long'): string => weekdayNameAfter(0, form);

/** The canonical name at an index, which the table types as possibly absent. */
const dayName = (index: number): string => String(DAY_NAMES[index]);

/** Fails loudly rather than reaching into `window` on an outcome that has none. */
function acceptedWindow(outcome: WindowArguments): CommitWindow {
  if (outcome.status !== 'ok') throw new Error('expected the arguments to be accepted');
  return outcome.window;
}

/** The stored day fields of the range above, which the anchor day opens. */
const START_DAY_NAME = String(DAY_NAMES[MIDWEEK_DAYS.startDay]);
const END_DAY_NAME = String(DAY_NAMES[MIDWEEK_DAYS.endDay]);
const STORED_WITH_DAYS = formatWindowValue(MIDWEEK_WINDOW);

/** The day pair as a developer joins it, having read the stored form back. */
const JOINED_DAY_PAIR = `${START_DAY_NAME}-${END_DAY_NAME}`;

describe('the canonical day table', () => {
  it('indexes the names the way getUTCDay does', () => {
    expect(DAY_NAMES[new Date(TEST_DAY_START).getUTCDay()]).toBe(anchorWeekday('short'));
  });

  it('names one day for each day of the week', () => {
    expect(new Set(DAY_NAMES).size).toBe(WEEK.length);
  });

  it('spells every name in three lowercase letters', () => {
    expect(DAY_NAMES.filter((name) => /^[a-z]{3}$/.test(name))).toEqual([...DAY_NAMES]);
  });

  it('maps every canonical name back to the index it sits at', () => {
    expect(DAY_NAMES.map((name) => dayIndexOf(name))).toEqual(DAY_NAMES.map((_, index) => index));
  });

  it('reads no index from a field that is not a canonical name', () => {
    expect(dayIndexOf(anchorWeekday('long'))).toBeNull();
  });
});

describe('formatWindowValue', () => {
  it('emits the two times alone when the window is enforced every day', () => {
    expect(formatWindowValue(DAY_WINDOW).split('-')).toHaveLength(2);
  });

  it('appends the canonical day names when the window names days', () => {
    expect(STORED_WITH_DAYS).toBe(`${STORED}-${START_DAY_NAME}-${END_DAY_NAME}`);
  });

  it('refuses to render a day index no week has', () => {
    const window = { ...DAY_WINDOW, enforcedDays: { startDay: WEEK.length, endDay: 0 } };
    expect(() => formatWindowValue(window)).toThrow();
  });
});

describe('the stored value round-trips', () => {
  it('through a window enforced every day', () => {
    expect(parseWindowValue(formatWindowValue(DAY_WINDOW))).toEqual(DAY_WINDOW);
  });

  it('through a window enforced on a range of days', () => {
    expect(parseWindowValue(STORED_WITH_DAYS)).toEqual(MIDWEEK_WINDOW);
  });

  it('through a day range that wraps past the end of the week', () => {
    expect(parseWindowValue(formatWindowValue(WRAPPED_DAY_WINDOW))).toEqual(WRAPPED_DAY_WINDOW);
  });

  it('through a day range whose equal ends name one day', () => {
    expect(parseWindowValue(formatWindowValue(SINGLE_DAY_WINDOW))).toEqual(SINGLE_DAY_WINDOW);
  });
});

describe('parseWindowValue', () => {
  it('reads back the value it stores', () => {
    expect(parseWindowValue(STORED)).toEqual(DAY_WINDOW);
  });

  it('reads back a wrapped window unchanged', () => {
    expect(parseWindowValue(formatWindowValue(NIGHT_WINDOW))).toEqual(NIGHT_WINDOW);
  });

  it('tolerates surrounding whitespace, which git config round-trips', () => {
    expect(parseWindowValue(` ${STORED} `)).toEqual(DAY_WINDOW);
  });

  it('rejects an unset value', () => {
    expect(parseWindowValue('')).toBeNull();
  });

  it('rejects a value joined by something other than the separator', () => {
    expect(parseWindowValue(`${STORED_START}:${STORED_END}`)).toBeNull();
  });

  it('rejects a value carrying a third field', () => {
    expect(parseWindowValue(`${STORED}-${STORED_START}`)).toBeNull();
  });

  it('rejects a field that is not four digits', () => {
    expect(parseWindowValue(`${STORED_START.slice(1)}-${STORED_END}`)).toBeNull();
  });

  it('rejects an hour no day has', () => {
    expect(parseWindowValue(`24${STORED_START.slice(2)}-${STORED_END}`)).toBeNull();
  });

  it('rejects a minute no hour has', () => {
    expect(parseWindowValue(`${STORED_START.slice(0, 2)}60-${STORED_END}`)).toBeNull();
  });

  it('rejects a window that opens and closes at the same minute', () => {
    expect(parseWindowValue(`${STORED_START}-${STORED_START}`)).toBeNull();
  });

  it('reads a two-field value as a window enforced every day', () => {
    expect(parseWindowValue(STORED)?.enforcedDays).toBeNull();
  });

  it('rejects a value carrying a fifth field', () => {
    expect(parseWindowValue(`${STORED_WITH_DAYS}-${START_DAY_NAME}`)).toBeNull();
  });

  it('rejects a day field that is not a day of the week', () => {
    expect(parseWindowValue(`${STORED}-${UNREADABLE_DAY}-${END_DAY_NAME}`)).toBeNull();
  });

  it('rejects a closing day field that is not a day of the week', () => {
    expect(parseWindowValue(`${STORED}-${START_DAY_NAME}-${UNREADABLE_DAY}`)).toBeNull();
  });

  it('rejects a canonical name written in any case but the stored one', () => {
    expect(
      parseWindowValue(`${STORED}-${START_DAY_NAME.toUpperCase()}-${END_DAY_NAME}`)
    ).toBeNull();
  });

  it('rejects a day written out in full, which the stored form never carries', () => {
    expect(parseWindowValue(`${STORED}-${anchorWeekday('long')}-${END_DAY_NAME}`)).toBeNull();
  });
});

describe('parseWindowArguments', () => {
  it('accepts two HHMM times', () => {
    expect(parseWindowArguments([STORED_START, STORED_END])).toEqual({
      status: 'ok',
      window: DAY_WINDOW,
    });
  });

  it('accepts a wrapped window, which is a legal thing to want', () => {
    const [start = '', end = ''] = formatWindowValue(NIGHT_WINDOW).split('-');
    expect(parseWindowArguments([start, end])).toEqual({ status: 'ok', window: NIGHT_WINDOW });
  });

  it('states the expected format when nothing was typed', () => {
    const outcome = parseWindowArguments([]);
    expect(outcome).toMatchObject({ status: 'invalid' });
    expect(invalidMessage(outcome)).toContain('pnpm git:window <startUTC> <endUTC>');
  });

  it('says the two times are separate arguments when they arrive joined', () => {
    const outcome = parseWindowArguments([STORED]);
    expect(invalidMessage(outcome)).toContain('two arguments');
  });

  it('offers the corrected invocation for a joined pair', () => {
    expect(invalidMessage(parseWindowArguments([STORED]))).toContain(
      `pnpm git:window ${STORED_START} ${STORED_END}`
    );
  });

  it('says a window needs both ends when only one time was typed', () => {
    expect(invalidMessage(parseWindowArguments([STORED_START]))).toContain('a start and an end');
  });

  it('says how many arguments arrived when too many do', () => {
    const args = [STORED_START, STORED_END, START_DAY_NAME, END_DAY_NAME, START_DAY_NAME];
    expect(invalidMessage(parseWindowArguments(args))).toContain(String(args.length));
  });

  it('corrects a time written with a separator', () => {
    expect(invalidMessage(parseWindowArguments([COLON_FORM, STORED_END]))).toContain(
      `pnpm git:window 0000 ${STORED_END}`
    );
  });

  it('corrects a pair written in 12-hour form', () => {
    expect(invalidMessage(parseWindowArguments([MIDNIGHT_12_HOUR, MIDDAY_12_HOUR]))).toContain(
      'pnpm git:window 0000 1200'
    );
  });

  it('corrects a bare hour to the HHMM form', () => {
    expect(invalidMessage(parseWindowArguments([STORED_START.slice(0, 2), STORED_END]))).toContain(
      `pnpm git:window ${STORED_START} ${STORED_END}`
    );
  });

  it('names the field it could not read', () => {
    const outcome = parseWindowArguments([`24${STORED_START.slice(2)}`, STORED_END]);
    expect(invalidMessage(outcome)).toContain(`24${STORED_START.slice(2)}`);
  });

  it('offers no correction for a time it cannot derive one from', () => {
    expect(invalidMessage(parseWindowArguments(['noon', 'midnight']))).not.toContain(
      'Did you mean'
    );
  });

  it('refuses a window that opens and closes at the same minute', () => {
    const outcome = parseWindowArguments([STORED_START, STORED_START]);
    expect(invalidMessage(outcome)).toContain('same minute');
  });

  it('offers no correction for equal ends, whose correction is the rejected pair itself', () => {
    expect(invalidMessage(parseWindowArguments([STORED_START, STORED_START]))).not.toContain(
      'Did you mean'
    );
  });

  it('offers no correction for equal ends reached through a shape it can read', () => {
    expect(invalidMessage(parseWindowArguments([COLON_FORM, COLON_FORM]))).not.toContain(
      'Did you mean'
    );
  });

  it('offers no correction for a 12-hour clock naming an hour no clock face has', () => {
    expect(invalidMessage(parseWindowArguments(['13pm', STORED_END]))).not.toContain(
      'Did you mean'
    );
  });

  it('offers no correction for a separated time naming a minute no hour has', () => {
    expect(invalidMessage(parseWindowArguments(['00:99', STORED_END]))).not.toContain(
      'Did you mean'
    );
  });

  it('names the closing time when that is the one it could not read', () => {
    const unreadable = `24${STORED_END.slice(2)}`;
    expect(invalidMessage(parseWindowArguments([STORED_START, unreadable]))).toContain(unreadable);
  });
});

/**
 * First letters that two days share, so a field spelling one of them names
 * neither. Derived from the canonical table rather than written down, and
 * guarded below: a fixture that stops being ambiguous would otherwise leave
 * the cases named for ambiguity asserting nothing.
 */
const INITIALS = DAY_NAMES.map((name) => name.charAt(0));
const AMBIGUOUS_INITIALS = [
  ...new Set(INITIALS.filter((letter) => INITIALS.filter((other) => other === letter).length > 1)),
];

/**
 * Every prefix of a day's full name that the command does not accept outright
 * — the shapes a developer types when they neither abbreviate to three letters
 * nor write the day out. The full spelling comes from the platform, so no
 * prefix here is copied out of the table under test.
 */
const unacceptedPrefixes = (dayOffset: number): readonly string[] => {
  const full = weekdayNameAfter(dayOffset, 'long');
  const canonical = dayName(weekdayAfter(dayOffset));
  return Array.from({ length: full.length }, (_, index) => full.slice(0, index + 1)).filter(
    (prefix) => prefix.length > 1 && prefix !== canonical && prefix !== full
  );
};

describe('the day fixtures the correction cases are built on', () => {
  it('holds the first letters that name two days each', () => {
    expect(AMBIGUOUS_INITIALS).toHaveLength(2);
  });

  it('holds prefixes of every day that are neither the canonical name nor the full one', () => {
    expect(WEEK.filter((day) => unacceptedPrefixes(day).length === 0)).toEqual([]);
  });
});

describe('parseWindowArguments, given a day it cannot read', () => {
  it('names the field it could not read as a day', () => {
    const outcome = parseWindowArguments([STORED_START, STORED_END, UNREADABLE_DAY, END_DAY_NAME]);
    expect(invalidMessage(outcome)).toContain(UNREADABLE_DAY);
  });

  it('names the closing day when that is the one it could not read', () => {
    const outcome = parseWindowArguments([
      STORED_START,
      STORED_END,
      START_DAY_NAME,
      UNREADABLE_DAY,
    ]);
    expect(invalidMessage(outcome)).toContain(UNREADABLE_DAY);
  });

  it('escapes the field before echoing it, so it cannot forge a line of the refusal', () => {
    const forged = `${START_DAY_NAME}\n${END_DAY_NAME}`;
    const outcome = parseWindowArguments([STORED_START, STORED_END, forged, END_DAY_NAME]);
    expect(invalidMessage(outcome)).toContain(JSON.stringify(forged));
  });

  it('corrects every unique prefix of a day to the canonical name', () => {
    const uncorrected = WEEK.flatMap((day) =>
      unacceptedPrefixes(day)
        .map((prefix) => ({
          prefix,
          message: invalidMessage(
            parseWindowArguments([STORED_START, STORED_END, prefix, END_DAY_NAME])
          ),
        }))
        .filter(
          ({ message }) =>
            !message.includes(
              `pnpm git:window ${STORED_START} ${STORED_END} ${dayName(weekdayAfter(day))} ${END_DAY_NAME}`
            )
        )
        .map(({ prefix }) => prefix)
    );
    expect(uncorrected).toEqual([]);
  });

  it('refuses an empty day field, which fits every day rather than one', () => {
    const outcome = parseWindowArguments([STORED_START, STORED_END, '', END_DAY_NAME]);
    expect(invalidMessage(outcome)).not.toContain('Did you mean');
  });

  it('offers no correction for a field that fits two days at once', () => {
    const suggested = AMBIGUOUS_INITIALS.filter((letter) =>
      invalidMessage(
        parseWindowArguments([STORED_START, STORED_END, letter, END_DAY_NAME])
      ).includes('Did you mean')
    );
    expect(suggested).toEqual([]);
  });

  it('offers no correction when the day derives but a time does not', () => {
    const outcome = parseWindowArguments([
      'noon',
      STORED_END,
      unacceptedPrefixes(0)[0] ?? '',
      END_DAY_NAME,
    ]);
    expect(invalidMessage(outcome)).not.toContain('Did you mean');
  });

  it('offers no correction when a time derives but a day does not', () => {
    const outcome = parseWindowArguments([COLON_FORM, STORED_END, UNREADABLE_DAY, END_DAY_NAME]);
    expect(invalidMessage(outcome)).not.toContain('Did you mean');
  });

  it('corrects the times and the days together when every field derives', () => {
    const outcome = parseWindowArguments([
      COLON_FORM,
      STORED_END,
      unacceptedPrefixes(0)[0] ?? '',
      END_DAY_NAME,
    ]);
    expect(invalidMessage(outcome)).toContain(
      `pnpm git:window 0000 ${STORED_END} ${START_DAY_NAME} ${END_DAY_NAME}`
    );
  });

  it('corrects a pair of prefixes naming the same day, which is a window it accepts', () => {
    const [prefix = ''] = unacceptedPrefixes(0);
    const outcome = parseWindowArguments([STORED_START, STORED_END, prefix, prefix]);
    expect(invalidMessage(outcome)).toContain(
      `pnpm git:window ${STORED_START} ${STORED_END} ${START_DAY_NAME} ${START_DAY_NAME}`
    );
  });
});

describe('the usage every refusal opens with', () => {
  const usage = (): string => invalidMessage(parseWindowArguments([]));

  it('names the days as arguments the invocation may carry', () => {
    expect(usage()).toContain('pnpm git:window <startUTC> <endUTC> [<startDay> <endDay>]');
  });

  it('says the days are the days the window is enforced on', () => {
    expect(usage()).toContain('the days the window is enforced on');
  });

  it('says both ends of the day range are included', () => {
    expect(usage()).toContain('both ends included');
  });

  it('says the window is enforced every day when the days are omitted', () => {
    expect(usage()).toContain('Omit the days and the window is enforced every day');
  });
});

describe('parseWindowArguments, given a count of arguments it cannot use', () => {
  it('says the days are a start and an end when only one of them arrives', () => {
    const outcome = parseWindowArguments([STORED_START, STORED_END, START_DAY_NAME]);
    expect(invalidMessage(outcome)).toContain('a start and an end, like the times');
  });

  it('offers no correction for a lone day, whose closing day cannot be derived', () => {
    const outcome = parseWindowArguments([STORED_START, STORED_END, START_DAY_NAME]);
    expect(invalidMessage(outcome)).not.toContain('Did you mean');
  });

  it('names both counts it accepts when too many arguments arrive', () => {
    const args = [STORED_START, STORED_END, START_DAY_NAME, END_DAY_NAME, START_DAY_NAME];
    expect(invalidMessage(parseWindowArguments(args))).toContain(
      'two times, or two times and two days'
    );
  });
});

describe('parseWindowArguments, given two days and no times', () => {
  it('says the times come first and the days follow them', () => {
    const outcome = parseWindowArguments([START_DAY_NAME, END_DAY_NAME]);
    expect(invalidMessage(outcome)).toContain('times come first');
  });

  it('says the same for days written out in full', () => {
    const outcome = parseWindowArguments([
      weekdayNameAfter(0, 'long'),
      weekdayNameAfter(2, 'long'),
    ]);
    expect(invalidMessage(outcome)).toContain('times come first');
  });

  it('says the same for a pair of prefixes, which name days just as plainly', () => {
    const [start = ''] = unacceptedPrefixes(0);
    const [end = ''] = unacceptedPrefixes(2);
    expect(invalidMessage(parseWindowArguments([start, end]))).toContain('times come first');
  });

  it('offers no correction, because the times cannot be derived from two days', () => {
    const outcome = parseWindowArguments([START_DAY_NAME, END_DAY_NAME]);
    expect(invalidMessage(outcome)).not.toContain('Did you mean');
  });
});

describe('parseWindowArguments, given fields joined into one argument', () => {
  const JOINED_DAYS = JOINED_DAY_PAIR;
  const FOUR_ARGUMENTS = `pnpm git:window ${STORED_START} ${STORED_END} ${START_DAY_NAME} ${END_DAY_NAME}`;

  it('says the day pair is two arguments when it arrives joined', () => {
    const outcome = parseWindowArguments([STORED_START, STORED_END, JOINED_DAYS]);
    expect(invalidMessage(outcome)).toContain('not one joined value');
  });

  it('corrects a joined day pair to the four-argument invocation', () => {
    const outcome = parseWindowArguments([STORED_START, STORED_END, JOINED_DAYS]);
    expect(invalidMessage(outcome)).toContain(FOUR_ARGUMENTS);
  });

  it('says the same when the whole value arrives as one argument', () => {
    expect(invalidMessage(parseWindowArguments([STORED_WITH_DAYS]))).toContain(
      'not one joined value'
    );
  });

  it('corrects a wholly joined value to the four-argument invocation', () => {
    expect(invalidMessage(parseWindowArguments([STORED_WITH_DAYS]))).toContain(FOUR_ARGUMENTS);
  });
});

describe('parseWindowArguments, given the days as well as the times', () => {
  it('reads two times and two day names as the window those days enforce', () => {
    expect(parseWindowArguments([STORED_START, STORED_END, START_DAY_NAME, END_DAY_NAME])).toEqual({
      status: 'ok',
      window: MIDWEEK_WINDOW,
    });
  });

  it('leaves the window enforced every day when the days are omitted', () => {
    expect(
      acceptedWindow(parseWindowArguments([STORED_START, STORED_END])).enforcedDays
    ).toBeNull();
  });

  it('accepts a day range that wraps past the end of the week', () => {
    const outcome = parseWindowArguments([
      STORED_START,
      STORED_END,
      dayName(WRAPPED_DAYS.startDay),
      dayName(WRAPPED_DAYS.endDay),
    ]);
    expect(acceptedWindow(outcome).enforcedDays).toEqual(WRAPPED_DAYS);
  });

  it('accepts equal ends, which name one day rather than none', () => {
    const outcome = parseWindowArguments([
      STORED_START,
      STORED_END,
      dayName(SINGLE_DAY.startDay),
      dayName(SINGLE_DAY.endDay),
    ]);
    expect(acceptedWindow(outcome).enforcedDays).toEqual(SINGLE_DAY);
  });

  it('reads a day written out in full', () => {
    const outcome = parseWindowArguments([
      STORED_START,
      STORED_END,
      weekdayNameAfter(0, 'long'),
      END_DAY_NAME,
    ]);
    expect(acceptedWindow(outcome).enforcedDays).toEqual(MIDWEEK_DAYS);
  });

  it('reads a canonical name in any case', () => {
    const outcome = parseWindowArguments([
      STORED_START,
      STORED_END,
      START_DAY_NAME.toUpperCase(),
      END_DAY_NAME.toUpperCase(),
    ]);
    expect(acceptedWindow(outcome).enforcedDays).toEqual(MIDWEEK_DAYS);
  });

  it('reads a full name in any case', () => {
    const capitalized = weekdayNameAfter(0, 'long');
    const outcome = parseWindowArguments([
      STORED_START,
      STORED_END,
      capitalized.charAt(0).toUpperCase() + capitalized.slice(1),
      END_DAY_NAME,
    ]);
    expect(acceptedWindow(outcome).enforcedDays).toEqual(MIDWEEK_DAYS);
  });

  it('reads every day of the week in its full form', () => {
    const opened = WEEK.map(
      (day) =>
        acceptedWindow(
          parseWindowArguments([
            STORED_START,
            STORED_END,
            weekdayNameAfter(day, 'long'),
            END_DAY_NAME,
          ])
        ).enforcedDays?.startDay
    );
    expect(opened).toEqual(WEEK.map((day) => weekdayAfter(day)));
  });
});

/** Zone offsets as minutes east of UTC, expressed as durations rather than as numbers. */
const offsetMinutes = (durationMs: number): number => durationMs / MINUTE_MS;

describe('describeWindow', () => {
  it('names the config key the window is stored under', () => {
    expect(describeWindow(DAY_WINDOW, 0)).toContain(WINDOW_CONFIG_KEY);
  });

  it('renders the window in UTC', () => {
    expect(describeWindow(DAY_WINDOW, 0)).toContain(`${STORED_START} to ${STORED_END} UTC`);
  });

  it('renders the window again in a zone ahead of UTC', () => {
    const local = formatWindowValue({
      startMinute: minuteOf(MORNING_START + HOUR_MS),
      endMinute: minuteOf(EVENING_END + HOUR_MS),
      enforcedDays: null,
    }).split('-');
    expect(describeWindow(DAY_WINDOW, offsetMinutes(HOUR_MS))).toContain(
      `${local.join(' to ')} local`
    );
  });

  it('wraps the local rendering rather than running off the day, in a zone behind UTC', () => {
    const local = formatWindowValue({
      startMinute: minuteOf(MORNING_START + DAY_MS - 10 * HOUR_MS),
      endMinute: minuteOf(EVENING_END - 10 * HOUR_MS),
      enforcedDays: null,
    }).split('-');
    expect(describeWindow(DAY_WINDOW, offsetMinutes(-10 * HOUR_MS))).toContain(
      `${local.join(' to ')} local`
    );
  });

  it('renders a half-hour zone at the minute rather than the hour', () => {
    const local = formatWindowValue({
      startMinute: minuteOf(MORNING_START + 5 * HOUR_MS + 30 * MINUTE_MS),
      endMinute: minuteOf(EVENING_END + 5 * HOUR_MS + 30 * MINUTE_MS),
      enforcedDays: null,
    }).split('-');
    expect(describeWindow(DAY_WINDOW, offsetMinutes(5 * HOUR_MS + 30 * MINUTE_MS))).toContain(
      `${local.join(' to ')} local`
    );
  });

  it('says how to remove the window', () => {
    expect(describeWindow(DAY_WINDOW, 0)).toContain(`--unset ${WINDOW_CONFIG_KEY}`);
  });

  it('names no day at all when the window is enforced every day', () => {
    expect(describeWindow(DAY_WINDOW, 0)).not.toContain('Enforced on');
  });

  it('offers no way back to every-day enforcement when it is already there', () => {
    expect(describeWindow(DAY_WINDOW, 0)).not.toContain('pnpm git:window');
  });
});

describe('describeWindow, on a window enforced on some days only', () => {
  const described = (): string => describeWindow(MIDWEEK_WINDOW, 0);

  it('names the enforced days as UTC days', () => {
    expect(described()).toContain(`${START_DAY_NAME} to ${END_DAY_NAME} (UTC days`);
  });

  it('says both ends of the range are enforced', () => {
    expect(described()).toContain('both ends included');
  });

  it('says in words that every other day is unrestricted', () => {
    expect(described()).toContain('every other day of the week is unrestricted');
  });

  it('warns that a day near midnight may be a different UTC day', () => {
    expect(described()).toContain('may be a different UTC day');
  });

  it('names the command that enforces the window every day again', () => {
    expect(described()).toContain(
      `Enforce it every day again with: pnpm git:window ${STORED_START} ${STORED_END}`
    );
  });

  it('names the enforced days of a wrapped range in the order they are stored', () => {
    expect(describeWindow(WRAPPED_DAY_WINDOW, 0)).toContain(
      `${dayName(WRAPPED_DAYS.startDay)} to ${dayName(WRAPPED_DAYS.endDay)} (UTC days`
    );
  });

  it('still renders the window in both zones', () => {
    expect(described()).toContain(`${STORED_START} to ${STORED_END} UTC`);
  });

  it('still says the check cannot be skipped', () => {
    expect(described()).toContain('with no way to skip the check');
  });

  it('still says how to remove the window', () => {
    expect(described()).toContain(`--unset ${WINDOW_CONFIG_KEY}`);
  });
});

const CLI = path.join(import.meta.dirname, 'git-window.ts');

const sandboxes: string[] = [];

afterAll(async () => {
  await Promise.all(sandboxes.map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
});

/** A throwaway clone: local config is per-clone, so every case needs its own. */
async function repository(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'git-window-'));
  sandboxes.push(directory);
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: directory });
  return directory;
}

async function storedValue(directory: string): Promise<string> {
  const result = await execa('git', ['config', '--local', '--get', WINDOW_CONFIG_KEY], {
    cwd: directory,
    reject: false,
  });
  return result.exitCode === 0 ? result.stdout.trim() : '';
}

/** Fails loudly rather than asserting on `null` when a refusal was expected. */
function refusalDetail(detail: string | null): string {
  if (detail === null) throw new Error('expected the window to refuse');
  return detail;
}

describe('checkCommitWindow', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('says nothing when no window is set, which is every clone by default', async () => {
    const directory = await repository();
    freezeClock(TEST_DAY_START + 3 * HOUR_MS, { toFake: ['Date'] });
    await expect(checkCommitWindow(directory)).resolves.toBeNull();
  });

  it('says nothing when the clock is inside the window', async () => {
    const directory = await repository();
    await setCommitWindow(directory, DAY_WINDOW);
    freezeClock(TEST_DAY_START + 12 * HOUR_MS, { toFake: ['Date'] });
    await expect(checkCommitWindow(directory)).resolves.toBeNull();
  });

  it('refuses when the clock is outside the window', async () => {
    const directory = await repository();
    await setCommitWindow(directory, DAY_WINDOW);
    freezeClock(TEST_DAY_START + 3 * HOUR_MS, { toFake: ['Date'] });
    await expect(checkCommitWindow(directory)).resolves.not.toBeNull();
  });

  it('admits the opening instant and refuses the closing one', async () => {
    const directory = await repository();
    await setCommitWindow(directory, DAY_WINDOW);
    freezeClock(MORNING_START, { toFake: ['Date'] });
    await expect(checkCommitWindow(directory)).resolves.toBeNull();
    setClock(EVENING_END);
    await expect(checkCommitWindow(directory)).resolves.not.toBeNull();
  });

  it('admits the small hours of a window that wraps past midnight', async () => {
    const directory = await repository();
    await setCommitWindow(directory, NIGHT_WINDOW);
    freezeClock(TEST_DAY_START + 2 * HOUR_MS, { toFake: ['Date'] });
    await expect(checkCommitWindow(directory)).resolves.toBeNull();
    setClock(TEST_DAY_START + 12 * HOUR_MS);
    await expect(checkCommitWindow(directory)).resolves.not.toBeNull();
  });

  it('refuses a stored value it cannot read rather than treating it as unset', async () => {
    const directory = await repository();
    await execa('git', ['config', '--local', WINDOW_CONFIG_KEY, 'whenever'], { cwd: directory });
    freezeClock(TEST_DAY_START + 12 * HOUR_MS, { toFake: ['Date'] });
    const detail = refusalDetail(await checkCommitWindow(directory));
    expect(detail).toContain(WINDOW_CONFIG_KEY);
  });

  it('refuses a key that is present and holds nothing, rather than reading it as unset', async () => {
    const directory = await repository();
    await execa('git', ['config', '--local', WINDOW_CONFIG_KEY, ''], { cwd: directory });
    freezeClock(TEST_DAY_START + 12 * HOUR_MS, { toFake: ['Date'] });
    expect(refusalDetail(await checkCommitWindow(directory))).toContain(WINDOW_CONFIG_KEY);
  });

  it('refuses a key holding only whitespace, which reads back as the same nothing', async () => {
    const directory = await repository();
    await execa('git', ['config', '--local', WINDOW_CONFIG_KEY, ' '], { cwd: directory });
    freezeClock(TEST_DAY_START + 12 * HOUR_MS, { toFake: ['Date'] });
    expect(refusalDetail(await checkCommitWindow(directory))).toContain(WINDOW_CONFIG_KEY);
  });

  it('names the config key in its refusal', async () => {
    const directory = await repository();
    await setCommitWindow(directory, DAY_WINDOW);
    freezeClock(TEST_DAY_START + 3 * HOUR_MS, { toFake: ['Date'] });
    expect(refusalDetail(await checkCommitWindow(directory))).toContain(WINDOW_CONFIG_KEY);
  });

  it('says nothing on a day outside the enforced range at an hour the window excludes', async () => {
    const directory = await repository();
    await setCommitWindow(directory, MIDWEEK_WINDOW);
    freezeClock(instantAfter(3, EXCLUDED_HOUR).getTime(), { toFake: ['Date'] });
    await expect(checkCommitWindow(directory)).resolves.toBeNull();
  });

  it('refuses on an enforced day at that same hour', async () => {
    const directory = await repository();
    await setCommitWindow(directory, MIDWEEK_WINDOW);
    freezeClock(instantAfter(0, EXCLUDED_HOUR).getTime(), { toFake: ['Date'] });
    await expect(checkCommitWindow(directory)).resolves.not.toBeNull();
  });

  it('refuses a stored value whose day field it cannot read, rather than reading it as unset', async () => {
    const directory = await repository();
    await execa(
      'git',
      ['config', '--local', WINDOW_CONFIG_KEY, `${STORED}-${UNREADABLE_DAY}-${END_DAY_NAME}`],
      {
        cwd: directory,
      }
    );
    freezeClock(instantAfter(0, INCLUDED_HOUR).getTime(), { toFake: ['Date'] });
    expect(refusalDetail(await checkCommitWindow(directory))).toContain(WINDOW_CONFIG_KEY);
  });

  it('prints no digit anywhere in its refusal, so it cannot disclose the instant', async () => {
    const directory = await repository();
    await setCommitWindow(directory, DAY_WINDOW);
    freezeClock(TEST_DAY_START + 3 * HOUR_MS, { toFake: ['Date'] });
    expect(refusalDetail(await checkCommitWindow(directory))).not.toMatch(/\d/);
  });
});

describe('setCommitWindow', () => {
  it('writes the window where the check reads it', async () => {
    const directory = await repository();
    await setCommitWindow(directory, DAY_WINDOW);
    await expect(storedValue(directory)).resolves.toBe(STORED);
  });

  it('replaces a window already set rather than adding a second value', async () => {
    const directory = await repository();
    await setCommitWindow(directory, DAY_WINDOW);
    await setCommitWindow(directory, NIGHT_WINDOW);
    await expect(storedValue(directory)).resolves.toBe(formatWindowValue(NIGHT_WINDOW));
  });
});

describe('the git:window command', () => {
  it('sets the window and prints it in both zones', async () => {
    const directory = await repository();
    const result = await execa('tsx', [CLI, STORED_START, STORED_END], {
      cwd: directory,
      reject: false,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${STORED_START} to ${STORED_END} UTC`);
    await expect(storedValue(directory)).resolves.toBe(STORED);
  }, 30_000);

  it('refuses a malformed invocation and changes nothing', async () => {
    const directory = await repository();
    const result = await execa('tsx', [CLI, STORED], { cwd: directory, reject: false });
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('pnpm git:window <startUTC> <endUTC>');
    await expect(storedValue(directory)).resolves.toBe('');
  }, 30_000);

  it('leaves a window already stored untouched when it refuses', async () => {
    const directory = await repository();
    await setCommitWindow(directory, MIDWEEK_WINDOW);
    const result = await execa('tsx', [CLI, STORED_START, STORED_END, JOINED_DAY_PAIR], {
      cwd: directory,
      reject: false,
    });
    expect(result.exitCode).not.toBe(0);
    await expect(storedValue(directory)).resolves.toBe(STORED_WITH_DAYS);
  }, 30_000);

  it('names the day arguments in the usage it refuses with', async () => {
    const directory = await repository();
    const result = await execa('tsx', [CLI, STORED], { cwd: directory, reject: false });
    expect(result.stderr).toContain('[<startDay> <endDay>]');
  }, 30_000);

  it('sets a window enforced on a range of days and prints which days those are', async () => {
    const directory = await repository();
    const result = await execa(
      'tsx',
      [CLI, STORED_START, STORED_END, START_DAY_NAME, END_DAY_NAME],
      {
        cwd: directory,
        reject: false,
      }
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(`${START_DAY_NAME} to ${END_DAY_NAME} (UTC days`);
    await expect(storedValue(directory)).resolves.toBe(STORED_WITH_DAYS);
  }, 30_000);

  it('drops the days when it is run again with the times alone', async () => {
    const directory = await repository();
    await execa('tsx', [CLI, STORED_START, STORED_END, START_DAY_NAME, END_DAY_NAME], {
      cwd: directory,
    });
    const result = await execa('tsx', [CLI, STORED_START, STORED_END], {
      cwd: directory,
      reject: false,
    });
    expect(result.exitCode).toBe(0);
    await expect(storedValue(directory)).resolves.toBe(STORED);
  }, 60_000);
});

describe('the privacy gate at both stages', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Neither stage below reaches a remote; the push arguments only have to be present. */
  const PUSH = { stdin: '', remote: 'origin', remoteUrl: 'origin' };

  /** Both stamps of the seed commit, so the fixture reads no clock and the date check passes. */
  const FIXTURE_STAMP = `@${String(TEST_DAY_START / SECOND_MS)} +0000`;

  /**
   * A repository the push stage can actually judge: empty stdin is the manual
   * invocation, whose range is the last commit, and an unborn branch has none.
   */
  async function pushableRepository(): Promise<string> {
    const directory = await repository();
    await execa('git', ['config', 'user.email', 'agent@hushbox.ai'], { cwd: directory });
    await execa('git', ['config', 'user.name', 'agent'], { cwd: directory });
    await fs.writeFile(
      path.join(directory, PRIVACY_ALLOWLIST_PATH),
      JSON.stringify({ entries: [] })
    );
    await execa('git', ['add', PRIVACY_ALLOWLIST_PATH], { cwd: directory });
    await execa('git', ['commit', '-qm', 'seed'], {
      cwd: directory,
      env: { ...process.env, GIT_AUTHOR_DATE: FIXTURE_STAMP, GIT_COMMITTER_DATE: FIXTURE_STAMP },
    });
    return directory;
  }

  it('refuses a commit made outside the window', async () => {
    const directory = await repository();
    await setCommitWindow(directory, DAY_WINDOW);
    freezeClock(TEST_DAY_START + 3 * HOUR_MS, { toFake: ['Date'] });
    const outcome = await runCommitStage(directory);
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain(WINDOW_CONFIG_KEY);
  });

  it('lets a commit through when no window is set', async () => {
    const directory = await repository();
    freezeClock(TEST_DAY_START + 3 * HOUR_MS, { toFake: ['Date'] });
    await expect(runCommitStage(directory)).resolves.toMatchObject({ code: 0 });
  });

  it('refuses a push made outside the window', async () => {
    const directory = await pushableRepository();
    await setCommitWindow(directory, DAY_WINDOW);
    freezeClock(TEST_DAY_START + 3 * HOUR_MS, { toFake: ['Date'] });
    const outcome = await runPushStage(directory, PUSH);
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain(WINDOW_CONFIG_KEY);
  });

  it('refuses a push when the key is present and holds nothing', async () => {
    const directory = await pushableRepository();
    await execa('git', ['config', '--local', WINDOW_CONFIG_KEY, ''], { cwd: directory });
    freezeClock(TEST_DAY_START + 12 * HOUR_MS, { toFake: ['Date'] });
    const outcome = await runPushStage(directory, PUSH);
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain(WINDOW_CONFIG_KEY);
  });

  it('lets a push through when no window is set', async () => {
    const directory = await pushableRepository();
    freezeClock(TEST_DAY_START + 3 * HOUR_MS, { toFake: ['Date'] });
    await expect(runPushStage(directory, PUSH)).resolves.toMatchObject({ code: 0 });
  });

  it('lets a push through when the window admits the instant', async () => {
    const directory = await pushableRepository();
    await setCommitWindow(directory, DAY_WINDOW);
    freezeClock(TEST_DAY_START + 12 * HOUR_MS, { toFake: ['Date'] });
    await expect(runPushStage(directory, PUSH)).resolves.toMatchObject({ code: 0 });
  });

  it('lets a commit through on an off day at an hour the window excludes', async () => {
    const directory = await repository();
    await setCommitWindow(directory, MIDWEEK_WINDOW);
    freezeClock(instantAfter(3, EXCLUDED_HOUR).getTime(), { toFake: ['Date'] });
    await expect(runCommitStage(directory)).resolves.toMatchObject({ code: 0 });
  });

  it('refuses a commit on an enforced day at that same hour', async () => {
    const directory = await repository();
    await setCommitWindow(directory, MIDWEEK_WINDOW);
    freezeClock(instantAfter(0, EXCLUDED_HOUR).getTime(), { toFake: ['Date'] });
    const outcome = await runCommitStage(directory);
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain(WINDOW_CONFIG_KEY);
  });

  it('lets a push through on an off day at an hour the window excludes', async () => {
    const directory = await pushableRepository();
    await setCommitWindow(directory, MIDWEEK_WINDOW);
    freezeClock(instantAfter(3, EXCLUDED_HOUR).getTime(), { toFake: ['Date'] });
    await expect(runPushStage(directory, PUSH)).resolves.toMatchObject({ code: 0 });
  });

  it('refuses a push on an enforced day at that same hour', async () => {
    const directory = await pushableRepository();
    await setCommitWindow(directory, MIDWEEK_WINDOW);
    freezeClock(instantAfter(0, EXCLUDED_HOUR).getTime(), { toFake: ['Date'] });
    const outcome = await runPushStage(directory, PUSH);
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain(WINDOW_CONFIG_KEY);
  });
});

describe('the git:window script entry', () => {
  it('is what pnpm runs, so the command in every message exists', () => {
    expect(rootScripts()).toMatchObject({
      'git:window': `node --import tsx scripts/${path.basename(CLI)}`,
    });
  });
});
