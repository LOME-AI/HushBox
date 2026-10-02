/**
 * The privacy content rules: given (path, bytes) pairs, report every value that
 * discloses time finer than day resolution, or the machine the work happened on.
 * Pure — the caller supplies the blobs and the allowlist.
 *
 * Blobs arrive as bytes because the text/binary split is decided here, from the
 * magic bytes, rather than by each caller.
 */

import { detectBinaryFormat } from './binary/format-registry.js';
import {
  HOUR_MAX,
  SEXAGESIMAL_MAX,
  SEXAGESIMAL_TENS_MAX,
  isDayBoundaryClock,
  isDayBoundaryMillis,
  isDayBoundarySeconds,
  isUtcZone,
  uuidV7Millis,
} from './instants.js';
import {
  HOST_PATH_ENVELOPE_GUARD_SOURCE,
  NAMED_HOME_SOURCE,
  ROOTED_HOST_PATH_SOURCE,
} from './host-paths.js';
import {
  NUMERIC_SEPARATOR_SOURCE,
  SEPARATED_DIGIT_SOURCE,
  ungroupedValue,
} from './numeric-separator.js';
import { PRIVACY_ALLOWLIST_PATH, admitsValuelessFinding, evidenceFailure } from './allowlist.js';
import type { PrivacyAllowlistEntry } from './allowlist.js';

/**
 * The host-path vocabulary is shared with the binary gate and lives in its own
 * leaf module. It is published from here as well because this is the door its
 * callers already come through.
 */
export { NAMED_HOME_SOURCE, ROOTED_HOST_PATH_SOURCE } from './host-paths.js';

/** Named so the report can give this rule the only remedy that applies to it. */
export const ENCODING_RULE = 'undecodable-encoding';

export interface TextBlobEntry {
  readonly path: string;
  readonly bytes: Uint8Array;
}

export interface PrivacyFinding {
  readonly rule: string;
  readonly path: string;
  readonly line: number;
  readonly column: number;
  /**
   * Character-class mask of the match, never the matched value itself — and
   * empty for a rule that reports a property of the blob rather than a match,
   * which today is `ENCODING_RULE` alone.
   */
  readonly shape: string;
}

export interface AllowlistEntry {
  readonly description: string;
  readonly path: string;
  /** Absent means every match in `path` is exempt. */
  readonly literals?: readonly string[] | undefined;
}

type Verdict = 'ignore' | 'exempt' | 'report';

interface RuleContext {
  /** The full text of the line the match starts on. */
  readonly lineText: string;
}

interface RuleDefinition {
  readonly name: string;
  /** Must carry the `g` flag; matched once per blob. */
  readonly pattern: RegExp;
  readonly classify: (match: RegExpExecArray, context: RuleContext) => Verdict;
  /** Every match spans a composite value whose parts other rules must not re-report. */
  readonly container?: boolean;
  /** Matches falling inside a container span are that container's to report. */
  readonly nested?: boolean;
  /**
   * Measured: in code these forms are product data (quiet-hours zones), diff
   * hunks and codepoints, never a disclosure. In prose they are the author's
   * own location.
   */
  readonly proseOnly?: boolean;
}

interface Span {
  readonly start: number;
  readonly end: number;
}

const CALENDAR_DAY_SOURCE = String.raw`\d{4}-\d{2}-\d{2}`;
// Two spellings of one clock. The dash spelling is what a stamp minted for a
// path segment carries, a colon being illegal in one — the same instant, so the
// same rule. It is read only at full second precision: a two-field dash pair
// after a calendar day is a numeric range far more often than it is a clock,
// while the three-field form has no second reading. The separators may not be
// mixed, which is why the two spellings are written out rather than made one
// with an alternating separator class.
const CLOCK_SOURCE = String.raw`(?:(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?|(\d{2})-(\d{2})-(\d{2})(\.\d+)?)`;
const ZONE_SUFFIX_SOURCE = String.raw`(?:[Zz]|[+-]\d{2}:?\d{2})`;
// The trailing digits are captured rather than refused. A digit guard here made
// a value written past the fields this pattern reads either match nothing at all
// — a minute field one digit wider — or fall back to a shorter read whose first
// two digits reached the day-boundary carve-out while the value itself carried
// on. Captured, the surplus is something the classifier can see and refuse. The
// optional space moved inside the zone group with it: outside, it would let the
// capture jump a separator and claim a neighbouring number.
const ISO_DATETIME = new RegExp(
  String.raw`(?<![\dA-Za-z])${CALENDAR_DAY_SOURCE}[T ]${CLOCK_SOURCE}(?: ?(${ZONE_SUFFIX_SOURCE}))?(\d*)`,
  'g'
);

// The boundary guards carry the whole false-positive story: they exclude float
// decimals and base64 runs, and they still refuse a run glued into an
// identifier, where the underscore is a word character rather than a grouping.
const EPOCH_GUARD_SOURCE = String.raw`[\dA-Za-z._-]`;
// The era both epoch rules read, written once because they describe the same
// span of time in different units: as two literals they are free to name
// different eras, and no test of either rule alone can see that they have. Its
// own two digits take the separator too — a grouped ten-digit run carries one
// between them.
const EPOCH_ERA_SOURCE = String.raw`1${NUMERIC_SEPARATOR_SOURCE}[6-9]`;
/**
 * What may follow the digits. A clock-precision epoch is routinely written as a
 * float — `time.time()` and a millisecond clock divided down both produce one —
 * and the guard alone read the separator as evidence the run was not an epoch,
 * so the whole value went unread at either width. The fraction is admitted and
 * the guard re-applied past it, which keeps a decimal that is not a fraction
 * (a version part, a sentence's period against a bare run) refused exactly as
 * before.
 */
const EPOCH_TAIL_SOURCE = String.raw`(?:\.\d+(?![\dA-Za-z_-])|(?!${EPOCH_GUARD_SOURCE}))`;

const EPOCH_MS = new RegExp(
  String.raw`(?<!${EPOCH_GUARD_SOURCE})${EPOCH_ERA_SOURCE}(?:${SEPARATED_DIGIT_SOURCE}){11}${EPOCH_TAIL_SOURCE}`,
  'g'
);
const EPOCH_SECONDS = new RegExp(
  String.raw`(?<!${EPOCH_GUARD_SOURCE})${EPOCH_ERA_SOURCE}(?:${SEPARATED_DIGIT_SOURCE}){8}${EPOCH_TAIL_SOURCE}`,
  'g'
);

// Separator-free second-precision timestamps: ASN.1 generalized time and UTC
// time, which C2PA signing chains carry, and the ISO basic form. All three evade
// every separator-bearing rule, and their digit widths sit outside the epoch
// rules' era guard. A digits-only run must carry the zulu designator; the basic
// form's `T` is signal enough on its own.
const COMPACT_DATETIME =
  /(?<![\dA-Za-z._-])(\d{8}T\d{6}|\d{14}|\d{12})(\.\d+)?(Z)?(?![\dA-Za-z._-])/g;

// A clock's minute and second field: two digits whose tens digit tops out at
// `SEXAGESIMAL_TENS_MAX`, so the band runs from zero to `SEXAGESIMAL_MAX`. The
// hour band runs from zero to `HOUR_MAX` the same way. Both ceilings are stated
// once, beside the day-boundary carve-out that also reads them, and the
// character class each pattern carries is built from its ceiling because the two
// must agree to be correct: a class narrower than the ceiling stops matching
// values the ceiling still admits, and every test of either half alone still
// passes.
const SEXAGESIMAL_SOURCE = String.raw`[0-${String(SEXAGESIMAL_TENS_MAX)}]\d`;
// A two-digit ceiling splits into a full tens run and a partial one: every tens
// digit below the ceiling's takes any units digit, and the ceiling's own tens
// digit takes units up to the ceiling.
const HOUR_TENS_MAX = Math.floor(HOUR_MAX / 10);
const HOUR_SOURCE =
  String.raw`[${Array.from({ length: HOUR_TENS_MAX }, (_, digit) => String(digit)).join('')}]\d` +
  String.raw`|${String(HOUR_TENS_MAX)}[0-${String(HOUR_MAX % 10)}]`;

const CLOCK_SECONDS_SOURCE = String.raw`(?<![\d:.,+-])(\d{1,2}):(${SEXAGESIMAL_SOURCE}):(${SEXAGESIMAL_SOURCE})(\.\d+)?(?![\d:])`;
const CLOCK_MINUTES_SOURCE = String.raw`(?<![\d:.,+-])(${HOUR_SOURCE}):(${SEXAGESIMAL_SOURCE})(?![\d:])`;
const CLOCK_SECONDS = new RegExp(CLOCK_SECONDS_SOURCE, 'g');
const CLOCK_MINUTES = new RegExp(CLOCK_MINUTES_SOURCE, 'g');

/**
 * A reading somebody obscured by hand: a clock with one digit written as a
 * letter and the rest left legible. Every branch spells one masked field beside
 * clean ones, so *exactly one* masked digit is the pattern's own language rather
 * than a count taken afterwards — two masked digits is a placeholder (`HH:MM`)
 * and none is a reading the bare-clock rules already carry.
 *
 * The colon inside both guards is what keeps a longer colon-separated run out. A
 * hardware address and a lint position each offer this shape at every field, and
 * every one of those attempts has a colon on one side of it.
 */
const MASKED_FIELD_SOURCE = String.raw`(?:\d[A-Za-z]|[A-Za-z]\d)`;
const CLEAN_FIELD_SOURCE = String.raw`\d{2}`;
const MASKED_CLOCK = new RegExp(
  String.raw`(?<![\w:.,+-])(?:` +
    `${MASKED_FIELD_SOURCE}:${CLEAN_FIELD_SOURCE}(?::${CLEAN_FIELD_SOURCE})?` +
    `|${CLEAN_FIELD_SOURCE}:${MASKED_FIELD_SOURCE}(?::${CLEAN_FIELD_SOURCE})?` +
    `|${CLEAN_FIELD_SOURCE}:${CLEAN_FIELD_SOURCE}:${MASKED_FIELD_SOURCE}` +
    String.raw`)(?![\w:])`,
  'gu'
);

const WEEKDAYS = 'Mon|Tue|Wed|Thu|Fri|Sat|Sun';
const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';
const RFC_1123 = new RegExp(
  String.raw`(?:${WEEKDAYS}),\s+\d{1,2}\s+(?:${MONTHS})\s+\d{4}` +
    String.raw`(?:\s+(\d{2}):(\d{2}):(\d{2}))?(?:\s+([A-Z]{1,5}|[+-]\d{4}))?`,
  'g'
);

// Civil zone abbreviations only. Three deliberate absences: `UTC` and `GMT` are
// the privacy-preserving normal form this repo writes everywhere, and Atlantic
// `AST`/`ADT` collide with the repo's abbreviation for an abstract syntax tree.
// Civil zones written as a region prefix, a season letter and `T`. The seasonless
// spelling of the same zone is the same list without the season letter, so both
// classes are built from it and a zone added here is read in both spellings.
const CIVIL_ZONE_REGIONS = ['A[CEKW]', '[CEMP]', 'H', 'NZ'];
const SEASONED_ZONES = CIVIL_ZONE_REGIONS.map((region) => `${region}[SD]T`).join('|');
const SEASONLESS_ZONES_ALTERNATION = CIVIL_ZONE_REGIONS.map((region) => `${region}T`).join('|');
const SEASONLESS_ZONES_SOURCE = String.raw`\b(?:${SEASONLESS_ZONES_ALTERNATION})\b`;
const ZONE_ABBREVIATION_SOURCE = String.raw`\b(?:${SEASONED_ZONES}|BST|CES?T|EES?T|WES?T|IST|JST|KST)\b`;
const IANA_ZONE_SOURCE = String.raw`\b(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)\/[A-Z][A-Za-z_]+(?:\/[A-Z][A-Za-z_]+)?\b`;
const ZONE_ABBREVIATIONS = new RegExp(ZONE_ABBREVIATION_SOURCE, 'g');
const SEASONLESS_ZONES = new RegExp(SEASONLESS_ZONES_SOURCE, 'g');
const IANA_ZONE = new RegExp(IANA_ZONE_SOURCE, 'g');
// A meridiem reading is a standalone token, and both edges of that say so. On the
// left a digit welded to a word character belongs to an encoded run — base64
// payloads and lockfile digests, which is where an unguarded left edge spends most
// of its matches. Between reading and marker at most one horizontal space, because
// any whitespace run reaches across a line break and welds a trailing number to the
// heading below it.
const AMPM_CLOCK_SOURCE = String.raw`(?<![\w:.])(\d{1,2})(?::(${SEXAGESIMAL_SOURCE}))?[^\S\n]?[APap]\.?[Mm]\.?(?![\w])`;
const AMPM_CLOCK = new RegExp(AMPM_CLOCK_SOURCE, 'g');
// Its own instance: the co-occurrence test runs while the rules are mid-iteration,
// and a shared global regex carries `lastIndex` across calls.
const CLOCK_READING = new RegExp(
  `${AMPM_CLOCK_SOURCE}|${CLOCK_SECONDS_SOURCE}|${CLOCK_MINUTES_SOURCE}`
);
// The version nibble is the anchor and the variant nibble is unconstrained: the
// leading bits are a millisecond clock because the version says so, and a
// literal of this shape discloses that instant whether or not its variant is one
// the specification admits — one keystroke apart. The cost is that a hex string
// of uuid shape that is not an identifier of this kind at all is admitted
// whenever its version position reads 7, which is not separable from the shape.
const UUID_V7 =
  /(?<![0-9a-fA-F-])([0-9a-fA-F]{8})-([0-9a-fA-F]{4})-7[0-9a-fA-F]{3}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![0-9a-fA-F-])/g;
// Constrained to what a zone offset can actually be — hours no further from
// zero than fourteen, minutes on a quarter-hour — because the unconstrained form
// is dominated by diff hunks, CSS offsets and identifier segments.
//
// The sign is a plus or a dash, and which dash is not the author's decision: an
// editor substitutes a typographic one for the hyphen that was typed, and the
// substitute is still the sign. `\p{Dash}` is the derivation rather than a list,
// so it admits the ASCII hyphen-minus and every substitute for it in one stroke.
// The plus stays ASCII because no substitution acts on a plus.
//
// A dash separating two values is refused by the guard in front of the sign,
// which rejects a dash abutting a number on its left — the range case, not the
// spelling, is what makes a dash prose punctuation.
//
// A zone token immediately left of the sign is the one word character the guard
// must admit rather than refuse, and it earns a wider reading than the general
// form: behind a token the minute field may be dropped and the hour written with
// a single digit, spellings that are unreadable anywhere else. The guard stays
// shut for every other word character because a signed run after an ordinary word
// is a numeric delta — measured over this repository's prose, every one of them is.
const OFFSET_SIGN_SOURCE = String.raw`[+\p{Dash}]`;
const OFFSET_HOUR_SOURCE = String.raw`0\d|1[0-4]`;
const OFFSET_MINUTE_SOURCE = String.raw`00|15|30|45`;
const UTC_TOKEN_SOURCE = String.raw`\b(?:UTC|GMT|UT)`;
const ZONE_OFFSET = new RegExp(
  String.raw`(?<![\w.,:+-])(${OFFSET_SIGN_SOURCE})(${OFFSET_HOUR_SOURCE}):?(${OFFSET_MINUTE_SOURCE})(?![\w.,:+-])` +
    String.raw`|${UTC_TOKEN_SOURCE}${OFFSET_SIGN_SOURCE}(0?\d|1[0-4])(?::?(${OFFSET_MINUTE_SOURCE}))?(?![\w.,:+-])`,
  'gu'
);
const HOST_PATH = new RegExp(
  `${HOST_PATH_ENVELOPE_GUARD_SOURCE}(?:${ROOTED_HOST_PATH_SOURCE}|${NAMED_HOME_SOURCE})`,
  'gu'
);

// A clock spelled as separate numeric arguments carries no separator, so every
// clock-shaped rule reads straight past it. Arguments are matched as
// separator-free runs rather than as expressions: a nested construction is left
// to its own match, and a field written as anything but a digit run is a field
// this gate cannot read. The repetition bound is the constructor's own argument
// count — year through millisecond.
const DATE_ARGUMENT_SOURCE = String.raw`[^(),]+`;
const DATE_ARGUMENTS = new RegExp(
  String.raw`(?:new\s+Date|Date\.UTC)\s*\((?:${DATE_ARGUMENT_SOURCE})(?:,${DATE_ARGUMENT_SOURCE}){2,6}\)`,
  'g'
);
/** Year, month and day come first; the fourth argument is where the clock starts. */
const DATE_CLOCK_ARGUMENT = 3;
const NUMERIC_ARGUMENT = /^\d+$/;

/** The zone and the surplus digits, which follow whichever clock spelling read. */
const ISO_TRAILING_GROUP = 9;

interface ClockFields {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly fraction: string;
}

/** Whichever of the two clock spellings matched; the other's groups are absent. */
function isoClockFields(match: RegExpExecArray): ClockFields {
  const [hour = '', minute = '', second = '0', fraction = ''] =
    match[1] === undefined ? match.slice(5, 9) : match.slice(1, 5);
  return {
    hour: Number(hour),
    minute: Number(minute),
    second: Number(second),
    fraction,
  };
}

function containsClockReading(lineText: string): boolean {
  return CLOCK_READING.test(lineText);
}

export const RULES: readonly RuleDefinition[] = [
  {
    name: 'iso-datetime',
    container: true,
    pattern: ISO_DATETIME,
    classify: (match) => {
      const [zone = '', surplus = ''] = match.slice(ISO_TRAILING_GROUP);
      // A value the pattern could not read to its end is not a value the
      // carve-out can speak for: the fields it did read are a prefix, and a
      // prefix that lands on a boundary says nothing about the rest.
      if (surplus !== '') return 'report';
      if (!isUtcZone(zone)) return 'report';
      const { hour, minute, second, fraction } = isoClockFields(match);
      return isDayBoundaryClock(hour, minute, second, fraction) ? 'exempt' : 'report';
    },
  },
  {
    name: 'rfc1123-date',
    container: true,
    pattern: RFC_1123,
    classify: (match) => {
      const [, hour, minute, second, zone = ''] = match;
      if (hour === undefined || minute === undefined || second === undefined) return 'ignore';
      // An RFC-1123 date always names its zone, and a day boundary in some other
      // zone is a mid-day instant in UTC — plus a disclosure of where the author is.
      if (!isUtcZone(zone === 'GMT' || zone === 'UT' ? 'Z' : zone)) return 'report';
      return isDayBoundaryClock(Number(hour), Number(minute), Number(second), '')
        ? 'exempt'
        : 'report';
    },
  },
  {
    name: 'compact-datetime',
    pattern: COMPACT_DATETIME,
    classify: (match) => {
      const [, token = '', fraction = '', zone = ''] = match;
      if (!token.includes('T') && zone === '') return 'ignore';
      const time = token.slice(-6);
      const hour = Number(time.slice(0, 2));
      const minute = Number(time.slice(2, 4));
      const second = Number(time.slice(4, 6));
      if (hour > HOUR_MAX || minute > SEXAGESIMAL_MAX || second > SEXAGESIMAL_MAX) return 'ignore';
      return isDayBoundaryClock(hour, minute, second, fraction) ? 'exempt' : 'report';
    },
  },
  {
    name: 'meridiem-clock',
    pattern: AMPM_CLOCK,
    classify: (match) => {
      const [, hour = '', minute = '0'] = match;
      const hour24 = (Number(hour) % 12) + (/[Pp]/.test(match[0]) ? 12 : 0);
      return isDayBoundaryClock(hour24, Number(minute), 0, '') ? 'exempt' : 'report';
    },
  },
  {
    name: 'uuidv7',
    pattern: UUID_V7,
    classify: (match) => {
      // The first two fields are the 48-bit millisecond timestamp, dash aside.
      return isDayBoundaryMillis(uuidV7Millis(match[0])) ? 'exempt' : 'report';
    },
  },
  {
    name: 'timezone-abbreviation',
    proseOnly: true,
    pattern: ZONE_ABBREVIATIONS,
    classify: () => 'report',
  },
  {
    name: 'seasonless-timezone-abbreviation',
    proseOnly: true,
    pattern: SEASONLESS_ZONES,
    // A seasonless spelling is also ordinary English in capitals, so the reading
    // beside one is what says the token is a zone at all. The reciprocal guard
    // belongs on no clock rule: a clock discloses when and a zone discloses
    // where, so neither may be made to depend on the other being said.
    classify: (_match, context) => (containsClockReading(context.lineText) ? 'report' : 'ignore'),
  },
  {
    name: 'iana-timezone',
    proseOnly: true,
    pattern: IANA_ZONE,
    classify: () => 'report',
  },
  {
    name: 'timezone-offset',
    proseOnly: true,
    nested: true,
    pattern: ZONE_OFFSET,
    classify: (match) => {
      const hour = match[2] ?? match[4] ?? '';
      const minute = match[3] ?? match[5] ?? '0';
      return Number(hour) === 0 && Number(minute) === 0 ? 'exempt' : 'report';
    },
  },
  {
    name: 'absolute-host-path',
    pattern: HOST_PATH,
    classify: () => 'report',
  },
  {
    name: 'epoch-ms',
    pattern: EPOCH_MS,
    classify: (match) => (isDayBoundaryMillis(ungroupedValue(match[0])) ? 'exempt' : 'report'),
  },
  {
    name: 'epoch-seconds',
    pattern: EPOCH_SECONDS,
    classify: (match) => (isDayBoundarySeconds(ungroupedValue(match[0])) ? 'exempt' : 'report'),
  },
  {
    name: 'date-arguments',
    pattern: DATE_ARGUMENTS,
    classify: (match) => {
      const written = match[0].slice(match[0].indexOf('(') + 1, -1).split(',');
      const [hour = '', minute = '0', second = '0', millis = '0'] = written
        .slice(DATE_CLOCK_ARGUMENT)
        .map((argument) => argument.trim());
      // A construction of a calendar day names no time of day, and neither does
      // one whose hour is computed: the constraint is on written clocks.
      if (!NUMERIC_ARGUMENT.test(hour)) return 'ignore';
      // A field the gate cannot read is a field the carve-out cannot speak for,
      // and an hour written as a literal has already disclosed a clock.
      if (![minute, second, millis].every((field) => NUMERIC_ARGUMENT.test(field))) return 'report';
      return isDayBoundaryClock(Number(hour), Number(minute), Number(second), `.${millis}`)
        ? 'exempt'
        : 'report';
    },
  },
  {
    name: 'clock-seconds',
    nested: true,
    pattern: CLOCK_SECONDS,
    classify: (match) => {
      const [, hour = '', minute = '', second = '', fraction = ''] = match;
      if (Number(hour) > HOUR_MAX) return 'ignore';
      return isDayBoundaryClock(Number(hour), Number(minute), Number(second), fraction)
        ? 'exempt'
        : 'report';
    },
  },
  {
    name: 'clock-minutes',
    nested: true,
    pattern: CLOCK_MINUTES,
    classify: (match) => {
      const [, hour = '', minute = ''] = match;
      return isDayBoundaryClock(Number(hour), Number(minute), 0, '') ? 'exempt' : 'report';
    },
  },
  {
    name: 'masked-digit-clock',
    pattern: MASKED_CLOCK,
    // No day-boundary carve-out: a masked reading names a range, never an
    // instant, so nothing here can be shown to sit on a boundary.
    classify: () => 'report',
  },
];

/**
 * Every rule name a finding can carry, derived from the rules rather than listed
 * beside them: a name is what an allowlist entry may be keyed on, so a list kept
 * by hand would let a rule renamed here orphan an entry that still parses.
 * {@link ENCODING_RULE} is in it because it is the one rule reported without
 * running a pattern, which is exactly the rule the keyed form exists for.
 */
export const LIVE_RULE_NAMES: readonly string[] = [
  ENCODING_RULE,
  ...RULES.map((rule) => rule.name),
];

/**
 * A shape is printed in place of the value it withholds, so it becomes text in a
 * report — text this same gate then reads. The tilde and the backslash are
 * masked with the letters and digits for that reason: the host-path rule keys on
 * them literally, so a masked named-home shorthand and a masked drive letter are
 * both still members of the language that rule accepts, and every document
 * quoting one would re-trigger the rule that produced it.
 */
function maskValue(value: string): string {
  // Letters first: masking digits first would re-mask the substituted letters.
  return value
    .replaceAll(/[a-z]/g, 'x')
    .replaceAll(/[A-Z]/g, 'X')
    .replaceAll(/\d/g, 'N')
    .replaceAll(/[~\\]/g, '?');
}

function lineStarts(content: string): number[] {
  const starts = [0];
  for (let index = content.indexOf('\n'); index !== -1; index = content.indexOf('\n', index + 1)) {
    starts.push(index + 1);
  }
  return starts;
}

interface Position {
  readonly line: number;
  readonly column: number;
  readonly lineStart: number;
}

/** Walked rather than binary-searched: iteration yields the offsets themselves,
 * so there is no index lookup whose miss branch could never be exercised. */
function positionOf(starts: readonly number[], offset: number): Position {
  let line = 1;
  let lineStart = 0;
  let index = 0;
  for (const start of starts) {
    index += 1;
    if (start > offset) break;
    line = index;
    lineStart = start;
  }
  return { line, column: offset - lineStart + 1, lineStart };
}

function lineTextAt(content: string, lineStart: number): string {
  const end = content.indexOf('\n', lineStart);
  return end === -1 ? content.slice(lineStart) : content.slice(lineStart, end);
}

function* matchesOf(pattern: RegExp, content: string): Generator<RegExpExecArray> {
  pattern.lastIndex = 0;
  for (let match = pattern.exec(content); match !== null; match = pattern.exec(content)) {
    yield match;
  }
}

function containerSpans(content: string): Span[] {
  const spans: Span[] = [];
  for (const rule of RULES) {
    if (rule.container !== true) continue;
    for (const match of matchesOf(rule.pattern, content)) {
      spans.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return spans;
}

function isProse(path: string): boolean {
  const lower = path.toLowerCase();
  return lower.endsWith('.md') || lower.endsWith('.mdx');
}

/**
 * Only a literal-pinned entry can exempt text. A literal-free entry is the
 * binary side's shape — admissible there because its disclosing values are
 * compressed or packed fields no reviewer could write down — and the paths it
 * names are claimed by the format registry, so they never reach this scanner. If
 * one ever stopped matching its magic bytes, this guard is what stops its narrow
 * binary exemption widening into a blanket text exemption.
 *
 * An entry under an evidenced clause rests its whole claim on a citation, so the
 * citation is a condition of the admission rather than a note beside it: one the
 * file does not bear out silences nothing. Asked here, it is asked of every entry
 * at the moment it is used, rather than only of the entries a suite assertion
 * happens to read. `fileText` is the reading the match came out of, which is the
 * text the citation has to stand against — an entry only ever admits a match in
 * the file it names, so no second file is ever in question.
 */
function isAllowed(
  allowlist: readonly PrivacyAllowlistEntry[],
  path: string,
  matched: string,
  fileText: string
): boolean {
  return allowlist.some(
    (entry) =>
      entry.path === path &&
      entry.literals?.includes(matched) === true &&
      evidenceFailure(entry, fileText) === undefined
  );
}

function isNestedInContainer(rule: RuleDefinition, spans: readonly Span[], index: number): boolean {
  if (rule.nested !== true) return false;
  return spans.some((span) => index >= span.start && index < span.end);
}

interface BlobScan {
  readonly path: string;
  readonly content: string;
  readonly starts: readonly number[];
  readonly spans: readonly Span[];
  readonly allowlist: readonly PrivacyAllowlistEntry[];
}

function collectRuleFindings(rule: RuleDefinition, scan: BlobScan): PrivacyFinding[] {
  const { path, content, starts, spans, allowlist } = scan;
  const findings: PrivacyFinding[] = [];
  for (const match of matchesOf(rule.pattern, content)) {
    if (isNestedInContainer(rule, spans, match.index)) continue;
    const { line, column, lineStart } = positionOf(starts, match.index);
    const lineText = lineTextAt(content, lineStart);
    if (rule.classify(match, { lineText }) !== 'report') continue;
    if (isAllowed(allowlist, path, match[0], content)) continue;
    findings.push({ rule: rule.name, path, line, column, shape: maskValue(match[0]) });
  }
  return findings;
}

function scanBlob(
  path: string,
  content: string,
  allowlist: readonly PrivacyAllowlistEntry[]
): PrivacyFinding[] {
  const starts = lineStarts(content);
  const spans = containerSpans(content);
  const applicable = RULES.filter((rule) => rule.proseOnly !== true || isProse(path));
  const findings = applicable.flatMap((rule) =>
    collectRuleFindings(rule, { path, content, starts, spans, allowlist })
  );
  return findings.toSorted((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Two paths this gate never reports on, decided here rather than by each
 * caller so no call site can be the one that forgets:
 *
 * - the allowlist itself, whose whole content is matched literals it exists to
 *   exempt, and which cannot exempt itself without a circular entry;
 * - a blob the binary format registry claims, which is the binary gate's domain —
 *   except when the blob carries a byte-order mark, which outranks the claim for
 *   the reason recorded on `hasByteOrderMark`.
 *
 * A blob that registry does not claim is scanned as text whatever bytes it
 * carries. A content sniff would be a third dispatch mechanism disagreeing with
 * the other two, and one NUL byte in a document would hide it from both gates.
 */
function isOutOfScope(entry: TextBlobEntry): boolean {
  return (
    entry.path === PRIVACY_ALLOWLIST_PATH ||
    (!hasByteOrderMark(entry.bytes) && detectBinaryFormat(entry.bytes) !== undefined)
  );
}

/**
 * A byte-order mark outranks the format registry, which is this gate
 * deliberately overruling the other gate's claim rather than an oversight: the
 * UTF-16LE mark is also a valid audio frame sync, so a Windows-encoded text file
 * was otherwise claimed as audio and deferred to a gate that finds nothing in
 * it. A mark is unambiguous evidence of text; a sync pattern is not evidence of
 * audio.
 */
function hasByteOrderMark(bytes: Uint8Array): boolean {
  const [first, second, third] = bytes;
  if (first === 0xff && second === 0xfe) return true;
  if (first === 0xfe && second === 0xff) return true;
  return first === 0xef && second === 0xbb && third === 0xbf;
}

/**
 * A byte-order mark is a claim about the payload, and this decoder corroborates
 * it rather than trusting it. An uncorroborated mark was a blinding primitive:
 * two bytes in front of ordinary UTF-8 text made every rule read mojibake, and
 * ASCII decoded as UTF-16 leaves no NUL for the encoding rule to catch either,
 * so the blob passed both gates with its contents intact.
 *
 * Corroboration is a *density*, not a presence: UTF-16 text in this repository's
 * scripts is overwhelmingly ASCII, so half its bytes are NUL, on the parity the
 * encoding puts them on. A threshold of "at least one" is two orders of
 * magnitude weaker than the claim it licenses, and one planted NUL passed it.
 * The whole payload is measured, not a window of it — a head that corroborates
 * says nothing about a tail that does not.
 */
const UTF16_ASCII_CODE_UNIT_FLOOR = 0.5;

function corroboratesUtf16(payload: Buffer, nulParity: number): boolean {
  if (payload.length === 0 || payload.length % 2 !== 0) return false;
  let expected = 0;
  let unexpected = 0;
  for (const [index, byte] of payload.entries()) {
    if (byte !== 0) continue;
    if (index % 2 === nulParity) expected += 1;
    else unexpected += 1;
  }
  const codeUnits = payload.length / 2;
  return expected > unexpected && expected >= codeUnits * UTF16_ASCII_CODE_UNIT_FLOOR;
}

const UTF16_CODE_UNIT_BYTES = 2;

/** The NUL parity a UTF-16 byte order puts its narrow characters' padding on. */
const NUL_PARITY_OF = { littleEndian: 1, bigEndian: 0 } as const;

/**
 * Whether the bytes hold, at this NUL parity, two narrow characters side by side —
 * the least any rule can match.
 *
 * A UTF-16 code unit carrying a narrow character pads it with a NUL, so two such
 * characters adjacent put two NUL bytes exactly one code unit apart, both on the
 * parity that byte order pads. Where no such pair exists at a parity, the reading
 * in that byte order holds no two characters running, and no rule matches a single
 * code point that a wide code unit pads with a zero — pinned by a test sweeping that
 * whole range — so there is nothing in that reading for a rule to have missed.
 *
 * Offsets are absolute, so a mark of any width shifts nothing: parity is a property
 * of the byte order, not of where the payload starts.
 */
function holdsAdjacentNarrowText(buffer: Buffer, nulParity: number): boolean {
  for (
    let index = nulParity;
    index + UTF16_CODE_UNIT_BYTES < buffer.length;
    index += UTF16_CODE_UNIT_BYTES
  ) {
    if (buffer[index] === 0 && buffer[index + UTF16_CODE_UNIT_BYTES] === 0) return true;
  }
  return false;
}

/**
 * Whether any reading this decode passed over holds text a rule could match.
 *
 * `taken` names the byte order the decode read the blob in, where it read one; the
 * question is then asked of every other order, because **taking a wide reading is
 * not covering every wide reading**. A lead long enough to carry the parity lets a
 * region in the opposite order ride along inside a blob that corroborates, and that
 * region is read by neither interpretation the scan sees.
 *
 * Excluding the taken order is sound only where that reading really is the region's
 * characters, and the caller must establish that before naming one. The pair this
 * searches for means two characters side by side **at a two-byte code unit**; at four
 * bytes the same pair is one character's own padding, so the taken reading sees a
 * character followed by a zero and has read nothing — while the pairs land on exactly
 * the parity the exclusion would drop.
 *
 * The polarity is the opposite of {@link corroboratesUtf16}'s, deliberately. That
 * one decides whether to *take* a wide reading, so it demands a strong claim and
 * refuses outright on a byte count no wide reading could have. Used as the admission
 * bound it failed open on both of its refusals — a wide blob one byte too long, and
 * a wide blob padded past its density floor, each corroborate nothing and were each
 * read by nothing. Failing to corroborate one reading is not evidence that another
 * one was complete, and neither is having taken a third.
 */
/**
 * The byte order to treat as read, given the text that order produced — or nothing,
 * where it produced characters that are themselves zero.
 *
 * A wide reading whose own characters over a region are zero is proof that the region
 * is not that reading's characters, so its order cannot be excluded from the question.
 * This is the same expression that fires {@link ENCODING_RULE}: where the taken
 * reading yields a zero character, the blob has already told the gate that reading did
 * not land.
 */
function orderActuallyRead(
  text: string,
  order: keyof typeof NUL_PARITY_OF
): keyof typeof NUL_PARITY_OF | undefined {
  return text.includes('\0') ? undefined : order;
}

function carriesUnreadText(buffer: Buffer, taken?: keyof typeof NUL_PARITY_OF): boolean {
  return Object.entries(NUL_PARITY_OF).some(
    ([order, parity]) => order !== taken && holdsAdjacentNarrowText(buffer, parity)
  );
}

export interface DecodedBlob {
  readonly text: string;
  /** True when a byte-order mark was present but the payload did not bear it out. */
  readonly markUncorroborated: boolean;
  /** True when the text above is a UTF-16 reading, so the bytes have a second one. */
  readonly utf16: boolean;
  /**
   * True when the raw bytes hold text in a reading this decode did not take — so
   * what the rules saw is not what the blob says, and a value may be sitting in
   * the reading they never got.
   *
   * This is the property that separates the causes {@link ENCODING_RULE} reports.
   * A blob nothing read holds its text in the reading that was passed over; a blob
   * that quotes a NUL on purpose decodes to its own contents, and the reading
   * passed over holds no two characters running. Neither the mark nor the presence
   * of a NUL tells them apart, which is why the question is asked of the bytes
   * rather than of the text.
   */
  readonly carriesUnreadText: boolean;
}

export function decodeBlob(bytes: Uint8Array): DecodedBlob {
  const buffer = Buffer.from(bytes);
  const [first, second, third] = buffer;
  const payload = buffer.subarray(2);
  if (first === 0xff && second === 0xfe) {
    // The wide text is read only on the corroborated arm: the fallback arm reaches
    // payloads a wide reading cannot take at all, including odd-length ones.
    if (corroboratesUtf16(payload, NUL_PARITY_OF.littleEndian)) {
      const text = payload.toString('utf16le');
      return {
        text,
        markUncorroborated: false,
        utf16: true,
        carriesUnreadText: carriesUnreadText(buffer, orderActuallyRead(text, 'littleEndian')),
      };
    }
    return {
      text: buffer.toString('utf8'),
      markUncorroborated: true,
      utf16: false,
      carriesUnreadText: carriesUnreadText(buffer),
    };
  }
  if (first === 0xfe && second === 0xff) {
    if (corroboratesUtf16(payload, NUL_PARITY_OF.bigEndian)) {
      const text = Buffer.from(payload).swap16().toString('utf16le');
      return {
        text,
        markUncorroborated: false,
        utf16: true,
        carriesUnreadText: carriesUnreadText(buffer, orderActuallyRead(text, 'bigEndian')),
      };
    }
    return {
      text: buffer.toString('utf8'),
      markUncorroborated: true,
      utf16: false,
      carriesUnreadText: carriesUnreadText(buffer),
    };
  }
  if (first === 0xef && second === 0xbb && third === 0xbf) {
    return {
      text: buffer.subarray(3).toString('utf8'),
      markUncorroborated: false,
      utf16: false,
      carriesUnreadText: carriesUnreadText(buffer),
    };
  }
  return {
    text: buffer.toString('utf8'),
    markUncorroborated: false,
    utf16: false,
    carriesUnreadText: carriesUnreadText(buffer),
  };
}

/**
 * Every interpretation of the bytes gets scanned, not just the winning one.
 * A corroborating head followed by a differently-encoded tail satisfies any
 * density test there is, and the tail is then read as mojibake — so detection is
 * not left resting on the encoding guess at all. The rules run over the decoded
 * text and over the raw bytes as UTF-8; whichever interpretation carries a
 * disclosure, one of the two passes sees it.
 */
function interpretationsOf(bytes: Uint8Array, decoded: DecodedBlob): string[] {
  if (!decoded.utf16) return [decoded.text];
  return [decoded.text, Buffer.from(bytes).toString('utf8')];
}

/**
 * A NUL byte left after decoding means the blob is neither UTF-8 nor a marked
 * UTF-16 file, so what the rules are reading may not be what the file says.
 * {@link DecodedBlob.carriesUnreadText} is what settles which: a blob quoting the
 * byte on purpose was read whole, and is admissible against an entry naming it.
 * It is reported rather than skipped: silently passing an undecodable blob is
 * how one invisible character defeats the whole gate. The scan still runs, so
 * whatever the decode did surface is reported alongside.
 */
function encodingFindings(path: string, decoded: DecodedBlob): PrivacyFinding[] {
  if (!decoded.markUncorroborated && !decoded.text.includes('\0')) return [];
  return [
    {
      rule: ENCODING_RULE,
      path,
      line: 1,
      column: 1,
      // No match, so no mask: the shape field stays a character-class mask of a
      // matched value for every rule that has one, and empty for the one that
      // reports a property of the blob instead.
      shape: '',
    },
  ];
}

/** One position can be reached through two interpretations of the same bytes. */
function dedupeFindings(findings: readonly PrivacyFinding[]): PrivacyFinding[] {
  const seen = new Map<string, PrivacyFinding>();
  for (const finding of findings) {
    seen.set(`${finding.rule}:${String(finding.line)}:${String(finding.column)}`, finding);
  }
  return [...seen.values()].toSorted((a, b) => a.line - b.line || a.column - b.column);
}

/**
 * Reports the text privacy findings in a set of blobs, less the ones the
 * allowlist admits.
 *
 * **A green result here is not a clean verdict.** A blob the binary format
 * registry claims is deferred to the binary gate and is not scanned at all, so
 * an empty result means "no text findings", never "this content is clean". The
 * two gates are complementary and must both be mounted; neither one's silence
 * says anything about the other's domain.
 */
export function scanTextBlobs(
  entries: readonly TextBlobEntry[],
  allowlist: readonly PrivacyAllowlistEntry[]
): PrivacyFinding[] {
  return entries
    .filter((entry) => !isOutOfScope(entry))
    .flatMap((entry) => {
      const decoded = decodeBlob(entry.bytes);
      const scanned = interpretationsOf(entry.bytes, decoded).flatMap((text) =>
        scanBlob(entry.path, text, allowlist)
      );
      // The whole result, not the encoding findings alone: a rule added later that
      // reports without a matched value is reachable by the same entry form without
      // this line being edited, which is the hole that form exists to close.
      return [...encodingFindings(entry.path, decoded), ...dedupeFindings(scanned)].filter(
        (finding) => !admitsValuelessFinding(allowlist, finding, decoded)
      );
    });
}
