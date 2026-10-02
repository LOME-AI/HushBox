/**
 * The per-clone commit/push window: an opt-in interval of the UTC day outside
 * which this clone refuses to commit or push, optionally narrowed to a range
 * of weekdays naming the days it is enforced on; on every other day of the
 * week nothing is refused, whatever the clock says. Unset is the default and
 * the whole check no-ops; the value lives in local git config, so it is never
 * tracked and never leaves the machine that set it.
 *
 * It is a defence in depth behind the commit-date normalizer rather than a
 * replacement for it: the normalizer coarsens what a commit says, and this
 * bounds when a commit can be made at all.
 *
 * **There is no way to turn it off for one commit.** No environment variable,
 * no flag, no configuration value other than the window itself is read here —
 * a window a developer can wave away for the one commit they are in a hurry
 * with is not a window. Removing it is `git config --local --unset` and
 * nothing else.
 */
import { execa } from 'execa';
import { DAY_MINUTES, HOUR_MINUTES } from '@hushbox/shared/durations';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';

/** The one config key. Local to the clone: `--global` is deliberately not read. */
export const WINDOW_CONFIG_KEY = 'hushbox.commitWindow';

/**
 * The canonical day names, indexed the way `Date#getUTCDay()` indexes days:
 * Sunday is 0. This is the one table — the stored value's spelling and the
 * index convention both come from here, and nothing keeps a second copy.
 */
export const DAY_NAMES: readonly string[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * The tail each canonical name grows into the day's full English spelling.
 * The full names are derived from the table above rather than listed again,
 * because a second list of day names is a second place the spellings and the
 * order could drift apart from the ones the stored value is written in.
 */
const FULL_NAME_TAILS: readonly string[] = [
  'day',
  'day',
  'sday',
  'nesday',
  'rsday',
  'day',
  'urday',
];

const FULL_DAY_NAMES: readonly string[] = DAY_NAMES.map(
  (name, index) => `${name}${String(FULL_NAME_TAILS[index])}`
);

/**
 * The `getUTCDay()` index a canonical name stands for, or null when the field
 * is not one of the seven. Strict on purpose: the forgiving reading of what a
 * developer typed belongs on the command line, where a correction can be
 * printed back, and a stored value has nobody to correct.
 */
export function dayIndexOf(name: string): number | null {
  const index = DAY_NAMES.indexOf(name);
  return index === -1 ? null : index;
}

/**
 * The canonical name for a `getUTCDay()` index. A `DayRange` carries plain
 * numbers, so an index outside the week is a caller's defect: it fails here
 * rather than storing a value the check would afterwards refuse to read.
 */
function dayNameOf(day: number): string {
  const name = DAY_NAMES[day];
  if (name === undefined) throw new Error(`Not a day of the week: ${String(day)}`);
  return name;
}

/**
 * A range of weekdays, both ends inclusive, in the `Date#getUTCDay()`
 * convention where Sunday is 0. Inclusive at both ends is the deliberate
 * asymmetry with the times, whose closing minute is outside the window: a
 * range naming Monday and Friday covers Friday, because that is what everyone
 * means by it. Equal ends therefore name exactly one day and are legal, where
 * equal times are not.
 */
export interface DayRange {
  readonly startDay: number;
  readonly endDay: number;
}

/**
 * Minutes past UTC midnight, half-open: the opening minute is inside the
 * window and the closing minute is outside it. Half-open is what lets two
 * adjacent windows tile a day without an instant belonging to both, and it
 * makes the wrapped case the exact complement of the unwrapped one.
 *
 * `enforcedDays` names the days the window is enforced *on* — not the days
 * commits are allowed on, which is the opposite reading and the one a reader
 * is likely to arrive with. `null` means it is enforced every day.
 */
export interface CommitWindow {
  readonly startMinute: number;
  readonly endMinute: number;
  readonly enforcedDays: DayRange | null;
}

/** The days a week has, and so the modulus every day range turns over at. */
const WEEK_DAYS = DAY_NAMES.length;

/**
 * Whether a `getUTCDay()` index falls inside the range, both ends included.
 * The modular offset is what makes the inclusive reading total: a range that
 * wraps past Sunday and a range whose ends are equal both fall out of
 * `offset <= span` with no case of their own.
 */
function isEnforcedDay(range: DayRange, day: number): boolean {
  const span = (range.endDay - range.startDay + WEEK_DAYS) % WEEK_DAYS;
  const offset = (day - range.startDay + WEEK_DAYS) % WEEK_DAYS;
  return offset <= span;
}

/**
 * Whether the instant's time of day falls between the two ends. The second arm
 * is the wrapped window, whose start is later in the day than its end: the
 * developer who works across midnight. Its two pieces are joined by `or`
 * rather than `and`, which is the whole of the difference.
 */
function isWithinHours(window: CommitWindow, instant: Date): boolean {
  const minute = instant.getUTCHours() * HOUR_MINUTES + instant.getUTCMinutes();
  const { startMinute, endMinute } = window;
  return startMinute < endMinute
    ? minute >= startMinute && minute < endMinute
    : minute >= startMinute || minute < endMinute;
}

/**
 * Whether this instant is inside the window. The weekday is read off the
 * instant itself and nothing else: a window whose hours wrap past midnight
 * carries no session across the day boundary.
 */
export function isWithinWindow(window: CommitWindow, instant: Date): boolean {
  const { enforcedDays } = window;
  // The day test can only ever lift enforcement, never add it: the range names
  // the days the window applies on, so an instant on any other day is admitted
  // whatever the clock says. A reader arriving from the clock half will expect
  // the two tests joined by `and`; they are not, and no day range can refuse an
  // instant the hours alone would have admitted.
  return enforcedDays === null || isEnforcedDay(enforcedDays, instant.getUTCDay())
    ? isWithinHours(window, instant)
    : true;
}

const CLOCK_FIELD = /^\d{4}$/;

/** Minutes past midnight for an HHMM field, or null when it is not one. */
function parseClock(field: string): number | null {
  if (!CLOCK_FIELD.test(field)) return null;
  const hours = Number(field.slice(0, 2));
  const minutes = Number(field.slice(2));
  if (hours > 23 || minutes > 59) return null;
  return hours * HOUR_MINUTES + minutes;
}

function formatClock(minute: number): string {
  const hours = Math.floor(minute / HOUR_MINUTES);
  return `${String(hours).padStart(2, '0')}${String(minute % HOUR_MINUTES).padStart(2, '0')}`;
}

const VALUE_SEPARATOR = '-';

/**
 * The stored form: the two HHMM fields, then the two day names when the window
 * names days, all in order and joined by the separator. Two fields is a whole
 * window rather than a truncated one — it is the window enforced every day.
 */
export function formatWindowValue(window: CommitWindow): string {
  const fields = [formatClock(window.startMinute), formatClock(window.endMinute)];
  const { enforcedDays } = window;
  if (enforcedDays !== null) {
    fields.push(dayNameOf(enforcedDays.startDay), dayNameOf(enforcedDays.endDay));
  }
  return fields.join(VALUE_SEPARATOR);
}

/** The stored value's two shapes, as field counts: the times alone, or the times and the days. */
const TIME_FIELDS = 2;
const DAY_FIELDS = 2;

type ClockPair = Pick<CommitWindow, 'startMinute' | 'endMinute'>;

/** The two time fields, or null when either is unreadable or they name the same minute. */
function parseClockPair(start: string, end: string): ClockPair | null {
  const startMinute = parseClock(start);
  const endMinute = parseClock(end);
  if (startMinute === null || endMinute === null || startMinute === endMinute) return null;
  return { startMinute, endMinute };
}

/** The two day fields as a range, or null when either is not a canonical name. */
function parseDayRange(startField: string, endField: string): DayRange | null {
  const startDay = dayIndexOf(startField);
  const endDay = dayIndexOf(endField);
  return startDay === null || endDay === null ? null : { startDay, endDay };
}

/**
 * The window a stored value names, or null when the value is not one this gate
 * can read. Equal *times* are rejected rather than resolved: they name either
 * the whole day or none of it, and a check whose answer depends on which
 * reading you had in mind is not a check. Equal *days* are accepted, because
 * the day range includes both its ends and so names exactly that one day.
 */
export function parseWindowValue(value: string): CommitWindow | null {
  const fields = value.trim().split(VALUE_SEPARATOR);
  const [start = '', end = ''] = fields;
  const clock = parseClockPair(start, end);
  if (clock === null) return null;
  if (fields.length === TIME_FIELDS) return { ...clock, enforcedDays: null };
  if (fields.length !== TIME_FIELDS + DAY_FIELDS) return null;
  const [startDayField = '', endDayField = ''] = fields.slice(TIME_FIELDS);
  const enforcedDays = parseDayRange(startDayField, endDayField);
  return enforcedDays === null ? null : { ...clock, enforcedDays };
}

/** The same minute of the day read in a zone `offsetMinutes` east of UTC. */
function localClock(minute: number, offsetMinutes: number): string {
  return formatClock((((minute + offsetMinutes) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES);
}

/**
 * What a developer is told when the window is set. The local rendering is
 * computed from the offset the machine is on at print time and is never stored:
 * a zone in `.git/config` would say where its owner lives, which is the thing
 * the stored value is kept in UTC to avoid.
 */
export function describeWindow(window: CommitWindow, offsetMinutes: number): string {
  const utc = `${formatClock(window.startMinute)} to ${formatClock(window.endMinute)} UTC`;
  const local = `${localClock(window.startMinute, offsetMinutes)} to ${localClock(window.endMinute, offsetMinutes)} local`;
  const { enforcedDays } = window;
  // The days are named in UTC and nowhere else. The hours above are rendered a
  // second time in the reader's zone, but a zone shift that crosses midnight
  // moves the weekday too, so a local weekday would be wrong for exactly the
  // readers whose offset makes it matter — hence the warning rather than a
  // second rendering, and hence the reading stated in both directions, since
  // "the days are mon to fri" is read as the days commits are allowed on about
  // as often as the days the window applies on.
  const days =
    enforcedDays === null
      ? []
      : [
          `Enforced on ${dayNameOf(enforcedDays.startDay)} to ${dayNameOf(enforcedDays.endDay)} ` +
            `(UTC days, both ends included); every other day of the week is unrestricted.`,
          'A day that has only just begun or ended where you are may be a different UTC day.',
        ];
  const everyDay =
    enforcedDays === null
      ? []
      : [
          `Enforce it every day again with: pnpm git:window ` +
            `${formatClock(window.startMinute)} ${formatClock(window.endMinute)}`,
        ];
  return [
    `${WINDOW_CONFIG_KEY} is set to ${utc} (${local}).`,
    ...days,
    'Commits and pushes outside it are refused on this clone, with no way to skip the check.',
    ...everyDay,
    `Remove it with: git config --local --unset ${WINDOW_CONFIG_KEY}`,
  ].join('\n');
}

export type WindowArguments =
  | { readonly status: 'ok'; readonly window: CommitWindow }
  | { readonly status: 'invalid'; readonly message: string };

const USAGE = [
  'Usage: pnpm git:window <startUTC> <endUTC> [<startDay> <endDay>]',
  'Both times are HHMM in 24-hour UTC; the window opens at the start and closes before the end.',
  'The days are the days the window is enforced on, both ends included; on every other day ' +
    'nothing is refused.',
  'Omit the days and the window is enforced every day.',
].join('\n');

const TWELVE_HOUR = /^(\d{1,2})(?::?(\d{2}))?\s*([AaPp])\.?[Mm]\.?$/;
const SEPARATED = /^(\d{1,2})[:.](\d{2})$/;
const BARE_HOUR = /^(\d{1,2})$/;

function clockFrom(hours: number, minutes: number): string | null {
  if (hours > 23 || minutes > 59) return null;
  return formatClock(hours * HOUR_MINUTES + minutes);
}

/** The 12-hour form, whose marker decides the half of the day and whose 12 means 0. */
function fromTwelveHour(field: string): string | null {
  const match = TWELVE_HOUR.exec(field);
  if (match === null) return null;
  const [, rawHour = '', rawMinute = '0', marker = ''] = match;
  const hour = Number(rawHour);
  if (hour < 1 || hour > 12) return null;
  return clockFrom((hour % 12) + (marker.toLowerCase() === 'p' ? 12 : 0), Number(rawMinute));
}

/** The hour and the minute written with something between them. */
function fromSeparated(field: string): string | null {
  const match = SEPARATED.exec(field);
  if (match === null) return null;
  const [, rawHour = '', rawMinute = ''] = match;
  return clockFrom(Number(rawHour), Number(rawMinute));
}

/** An hour on its own, which means the hour exactly. */
function fromBareHour(field: string): string | null {
  const match = BARE_HOUR.exec(field);
  if (match === null) return null;
  const [, rawHour = ''] = match;
  return clockFrom(Number(rawHour), 0);
}

/**
 * The HHMM field a caller probably meant, or null when nothing can be derived.
 * It reads the three shapes a developer reaches for instead of HHMM: a
 * separator between the hour and the minute, a 12-hour marker, and a bare hour.
 * A guess is only ever printed back as a suggestion, never acted on.
 */
function suggestClock(field: string): string | null {
  const trimmed = field.trim();
  if (parseClock(trimmed) !== null) return trimmed;
  return fromTwelveHour(trimmed) ?? fromSeparated(trimmed) ?? fromBareHour(trimmed);
}

/**
 * The canonical day name a field probably meant, or null when nothing unique
 * can be derived. A prefix is read against the full spellings, so the three
 * letters the stored value uses and the day written out both match, and so do
 * the lengths between them. A prefix short enough to fit two days derives
 * nothing: that is the honest answer, and a guess is only ever printed back as
 * a suggestion anyway.
 */
function suggestDay(field: string): string | null {
  // An empty field needs no case of its own: it is a prefix of all seven, so
  // it is ambiguous by the same count every other over-short prefix is.
  const lowered = field.trim().toLowerCase();
  const matched = FULL_DAY_NAMES.flatMap((name, index) =>
    name.startsWith(lowered) ? [index] : []
  );
  const [only] = matched;
  return matched.length === 1 && only !== undefined ? dayNameOf(only) : null;
}

/**
 * The corrected invocation, when every field of it can be derived. Printing
 * half a correction would be worse than printing none: the developer copies it
 * and meets the same refusal on the field that was never fixed. The days are
 * held to the same rule as the times — an ambiguous day suppresses the whole
 * suggestion, including the times beside it that were readable.
 */
function suggestion(fields: readonly string[]): string | null {
  if (fields.length !== TIME_FIELDS && fields.length !== TIME_FIELDS + DAY_FIELDS) return null;
  const [startField = '', endField = '', ...dayFields] = fields;
  const start = suggestClock(startField);
  const end = suggestClock(endField);
  // Two ends on the same minute name the window that was just refused, so
  // suggesting them back is the half correction this refuses to print. Every
  // other derivable pair is a window this accepts, which is what makes this
  // one condition the whole of "never suggest an invocation that is refused" —
  // equal days need no such condition, because they name one day and are legal.
  if (start === null || end === null || start === end) return null;
  const days = dayFields.map((field) => suggestDay(field));
  if (days.includes(null)) return null;
  return `Did you mean: pnpm git:window ${[start, end, ...days].join(' ')}`;
}

function refusal(hint: string, fields: readonly string[]): WindowArguments {
  const corrected = suggestion(fields);
  return {
    status: 'invalid',
    message: [USAGE, hint, ...(corrected === null ? [] : [corrected])].join('\n'),
  };
}

/**
 * A field as the hint may print it back, escaped: it is whatever the caller
 * typed, and a control character in it would forge a line of the refusal.
 */
function quoted(field: string): string {
  return JSON.stringify(field);
}

/**
 * The `getUTCDay()` index a day argument names, or null when it is neither the
 * canonical name nor the day written out in full. Case is ignored: the
 * strictness belongs to the stored value, not to what a developer types.
 */
function dayArgumentIndex(field: string): number | null {
  const lowered = field.trim().toLowerCase();
  const canonical = dayIndexOf(lowered);
  if (canonical !== null) return canonical;
  const full = FULL_DAY_NAMES.indexOf(lowered);
  return full === -1 ? null : full;
}

/** The day range the trailing arguments name, or the refusal naming whichever is not a day. */
function daysOf(fields: readonly string[], args: readonly string[]): DayRange | WindowArguments {
  const [start = '', end = ''] = fields;
  const startDay = dayArgumentIndex(start);
  const endDay = dayArgumentIndex(end);
  if (startDay === null || endDay === null) {
    const unreadable = [
      ...(startDay === null ? [quoted(start)] : []),
      ...(endDay === null ? [quoted(end)] : []),
    ];
    return refusal(`Not a day of the week: ${unreadable.join(', ')}.`, args);
  }
  return { startDay, endDay };
}

/** The window the arguments name, or the refusal naming whichever field is the problem. */
function windowOf(args: readonly string[]): WindowArguments {
  const [start = '', end = '', ...dayFields] = args;
  const startMinute = parseClock(start);
  const endMinute = parseClock(end);
  if (startMinute === null || endMinute === null) {
    const unreadable = [
      ...(startMinute === null ? [quoted(start)] : []),
      ...(endMinute === null ? [quoted(end)] : []),
    ];
    return refusal(`Not an HHMM time in 24-hour UTC: ${unreadable.join(', ')}.`, args);
  }
  if (startMinute === endMinute) {
    return refusal('A window cannot open and close at the same minute.', args);
  }
  if (dayFields.length === 0) {
    return { status: 'ok', window: { startMinute, endMinute, enforcedDays: null } };
  }
  const days = daysOf(dayFields, args);
  return 'status' in days
    ? days
    : { status: 'ok', window: { startMinute, endMinute, enforcedDays: days } };
}

/** The two shapes an invocation may have: the times alone, or the times and the days. */
function isLegalArity(count: number): boolean {
  return count === TIME_FIELDS || count === TIME_FIELDS + DAY_FIELDS;
}

/**
 * The refusal for a value whose fields arrived joined into fewer arguments
 * than they are, naming how many arguments the fields it holds should have
 * been. The separator is the stored value's, which is exactly why a developer
 * reaches for it: they have read the stored form back.
 */
function joinedHint(fields: number): string {
  return fields === TIME_FIELDS
    ? 'The start and the end are two arguments, not one joined value.'
    : 'The two times and the two days are four arguments, not one joined value.';
}

/**
 * Whether both arguments name a day, which is the developer who typed the days
 * and left the times out. A readable time can never fall in here: a day is
 * matched off the letters of its name, and a time field has none.
 */
function namesTwoDays(args: readonly string[]): boolean {
  return args.every((argument) => suggestDay(argument) !== null);
}

/**
 * The window the caller asked for, or the refusal to print. Nothing is written
 * on a refusal; the caller's own words come back corrected where they can be.
 */
export function parseWindowArguments(args: readonly string[]): WindowArguments {
  const separated = args.flatMap((argument) => argument.split(VALUE_SEPARATOR));
  if (separated.length !== args.length && isLegalArity(separated.length)) {
    return refusal(joinedHint(separated.length), separated);
  }
  if (args.length === 0) return refusal('No times given.', args);
  if (args.length === 1) return refusal('A window needs a start and an end.', args);
  if (args.length === TIME_FIELDS) {
    return namesTwoDays(args)
      ? refusal('The two times come first, and the days follow them.', args)
      : windowOf(args);
  }
  if (args.length === TIME_FIELDS + 1) {
    return refusal('The days are a start and an end, like the times.', args);
  }
  if (!isLegalArity(args.length)) {
    return refusal(
      `This expects two times, or two times and two days; it was given ${String(args.length)}.`,
      args
    );
  }
  return windowOf(args);
}

/**
 * The stored value, or null when this clone has no window at all. Read from
 * `--local` only: the window is a property of one clone, and a value inherited
 * from elsewhere would impose one clone's hours on every other.
 *
 * The absence is the query's exit status, never its output: a key that is
 * present and holds nothing exits zero and prints nothing, so a reader that
 * judged the printed text would call it unset and hand any developer a
 * one-command off switch — which is the one thing this window must not have.
 */
async function storedWindowValue(cwd: string): Promise<string | null> {
  const result = await execa('git', ['config', '--local', '--get', WINDOW_CONFIG_KEY], {
    cwd,
    reject: false,
  });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

export async function setCommitWindow(cwd: string, window: CommitWindow): Promise<void> {
  await execa('git', ['config', '--local', WINDOW_CONFIG_KEY, formatWindowValue(window)], { cwd });
}

/**
 * The refusal detail when this clone's window excludes the current instant, or
 * null when there is nothing to refuse. Unset is the default and the whole
 * check no-ops; that is the only state in which it stays silent for a reason
 * other than the clock.
 *
 * A stored value this cannot read refuses rather than passing: reading it as
 * unset would make any string an off switch, and the point of the window is
 * that it has none. A key present but holding nothing is such a value — it is
 * a stored window this cannot read, not the absence of one.
 */
export async function checkCommitWindow(cwd: string): Promise<string | null> {
  const value = await storedWindowValue(cwd);
  if (value === null) return null;
  const window = parseWindowValue(value);
  if (window === null) {
    return (
      `${WINDOW_CONFIG_KEY} holds a value this cannot read as a window; ` +
      `set it again with pnpm git:window, or remove it with ` +
      `git config --local --unset ${WINDOW_CONFIG_KEY}`
    );
  }
  // The instant is never printed, in this message or anywhere else the gate
  // reports: a refusal saying which instant it refused would disclose exactly
  // what the window exists to keep off the record.
  return isWithinWindow(window, new Date())
    ? null
    : `${WINDOW_CONFIG_KEY} is set on this clone and excludes now; ` +
        `read it with git config --local --get ${WINDOW_CONFIG_KEY}, ` +
        `or remove it with git config --local --unset ${WINDOW_CONFIG_KEY}`;
}

/* v8 ignore start -- CLI entry point, exercised end to end by the suite */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const parsed = parseWindowArguments(process.argv.slice(2));
    if (parsed.status === 'invalid') {
      console.error(parsed.message);
      return 1;
    }
    await setCommitWindow(process.cwd(), parsed.window);
    // Negated because `getTimezoneOffset` counts minutes *behind* UTC, and every
    // rendering below counts them east of it.
    console.log(describeWindow(parsed.window, -new Date().getTimezoneOffset()));
    return 0;
  });
}
/* v8 ignore stop */
