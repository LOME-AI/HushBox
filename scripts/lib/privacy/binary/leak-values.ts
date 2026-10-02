/**
 * Value-level privacy rules applied to text decoded out of a binary blob's
 * metadata regions, plus the bounded literal scan used on opaque byte ranges.
 *
 * Findings carry a *shape* rather than the matched text: a gate that echoes the
 * value it rejected copies the disclosure into the terminal and the CI log.
 *
 * The day-boundary carve-out is not defined here. It is one rule for the whole
 * repository and lives in `../instants`, shared with the text gate — two
 * copies of a carve-out are two different privacy policies, and a hole in a
 * gate is something to ratify deliberately, never to acquire by drift.
 */
import {
  isDayBoundaryClock,
  isDayBoundaryMillis,
  isDayBoundarySeconds,
  isUtcZone,
  uuidV7Millis,
} from '../instants.js';
import { NAMED_HOME_SOURCE, rootedHostPathSource } from '../host-paths.js';
import { SEPARATED_DIGIT_SOURCE, ungroupedValue } from '../numeric-separator.js';

/**
 * The band a digit run must fall inside to read as an epoch of one unit: the
 * exact width that makes a run that unit's epoch at all, and the far end of the
 * era window.
 *
 * The near end of the window is not stated, because it is the narrowest value
 * of that width — the two were separate literals and had to agree to be
 * correct, since a width that stops naming the floor's digit count silently
 * admits nothing at all. Everything derived below comes from this one row: the
 * digit run the pattern reads, the floor the classifier compares against, and
 * the finding's own shape.
 *
 * The era window is deliberately wider than the text gate's, and deliberately
 * not collapsed into it: a binary metadata region is a far lower-noise context
 * than source text, so breadth costs nothing here, while the same breadth over
 * source text is what the text gate's narrower guard exists to prevent. A
 * context-appropriate detection boundary, not drift — do not "fix" the two into
 * agreement.
 */
interface EpochBand {
  readonly digits: number;
  readonly ceiling: number;
  /** Names the unit in the finding shape, and nowhere else. */
  readonly unit: string;
}

const EPOCH_SECONDS_BAND: EpochBand = {
  digits: 10,
  ceiling: 2_500_000_000,
  unit: 'second',
};
const EPOCH_MILLIS_BAND: EpochBand = {
  digits: 13,
  ceiling: 2_500_000_000_000,
  unit: 'millisecond',
};

/** The narrowest value of the band's width, which is where its era window opens. */
function eraFloorOf(band: EpochBand): number {
  return 10 ** (band.digits - 1);
}

function shapeOf(band: EpochBand): string {
  return `${String(band.digits)}-digit ${band.unit} epoch`;
}

/**
 * A digit run of exactly the band's width, in either the contiguous or the
 * grouped spelling. The guards are what make the width exact: a longer run has
 * no position where the pattern can start, so a run one digit wider is refused
 * rather than read from its first digits.
 *
 * The grouping vocabulary is the repository's one declaration of it, shared
 * with the text gate.
 */
function digitRunOf(band: EpochBand): RegExp {
  return new RegExp(
    String.raw`(?<![0-9A-Za-z._-])\d(?:${SEPARATED_DIGIT_SOURCE}){${String(band.digits - 1)}}(?![0-9A-Za-z._-])`,
    'gu'
  );
}

export type LeakRule =
  | 'iso-datetime'
  | 'generalized-time'
  | 'clock'
  | 'epoch-seconds'
  | 'epoch-millis'
  | 'uuidv7'
  | 'host-path'
  | 'toolchain-identity';

interface ValueLeak {
  readonly rule: LeakRule;
  /** Describes the match. Never contains any part of the matched value. */
  readonly shape: string;
  /** Index of the match within the scanned text. */
  readonly index: number;
}

interface ToolchainLiteral {
  readonly literal: string;
  /** The disclosure class, used as the finding shape so the literal is never echoed. */
  readonly identityClass: string;
}

/**
 * The literals worth hunting inside an opaque byte range (coded video/audio
 * payloads). Deliberately short: this list is applied with `indexOf` over whole
 * media files, and a regex sweep of the same bytes costs two orders of
 * magnitude more while false-positiving on compressed data.
 */
export const TOOLCHAIN_LITERALS: readonly ToolchainLiteral[] = [
  { literal: 'x264', identityClass: 'video encoder build banner' },
  { literal: 'x265', identityClass: 'video encoder build banner' },
  { literal: 'libvpx', identityClass: 'video encoder build banner' },
  { literal: 'libaom', identityClass: 'video encoder build banner' },
  { literal: 'SVT-AV1', identityClass: 'video encoder build banner' },
  { literal: 'Lavc', identityClass: 'multimedia toolchain identity string' },
  { literal: 'Lavf', identityClass: 'multimedia toolchain identity string' },
  { literal: 'Lavu', identityClass: 'multimedia toolchain identity string' },
  { literal: 'ffmpeg', identityClass: 'multimedia toolchain identity string' },
  { literal: 'FFmpeg', identityClass: 'multimedia toolchain identity string' },
  { literal: 'LAME', identityClass: 'audio encoder identity string' },
  { literal: 'VideoToolbox', identityClass: 'platform encoder identity string' },
  { literal: 'HandBrake', identityClass: 'authoring tool identity string' },
  { literal: 'Remotion', identityClass: 'authoring tool identity string' },
  { literal: 'ImageMagick', identityClass: 'authoring tool identity string' },
  { literal: 'Photoshop', identityClass: 'authoring tool identity string' },
  { literal: 'Matplotlib', identityClass: 'authoring tool identity string' },
];

interface BitstreamHit {
  readonly offset: number;
  readonly shape: string;
}

/**
 * The slack a search needs past its range so a literal beginning on the last
 * byte of the range is still whole. Derived from the list rather than written
 * down, so adding a longer literal cannot silently shorten the reach.
 */
const LITERAL_OVERHANG_BYTES =
  Math.max(...TOOLCHAIN_LITERALS.map(({ literal }) => literal.length)) - 1;

/**
 * First occurrence of each known toolchain literal inside `[start, end)`.
 * One hit per literal: a build banner repeated per coded frame is one
 * disclosure, and the caller only needs somewhere to point.
 *
 * The search is handed a view of the range and nothing else. Searching the whole
 * buffer and discarding out-of-range hits afterwards returns exactly the same
 * findings while costing the blob's whole length once per range per literal —
 * and the range count comes out of the blob's own structure table, so that
 * multiplier is chosen by the file being examined. The slack past `end` keeps a
 * literal that starts inside the range and finishes outside it reportable.
 */
export function scanBitstreamLiterals(
  bytes: Uint8Array,
  start: number,
  end: number
): BitstreamHit[] {
  const from = Math.max(0, Math.min(start, bytes.length));
  const to = Math.max(from, Math.min(end, bytes.length));
  const reach = Math.min(bytes.length, to + LITERAL_OVERHANG_BYTES);
  const span = Buffer.from(bytes.buffer, bytes.byteOffset + from, reach - from);
  const hits: BitstreamHit[] = [];
  for (const { literal, identityClass } of TOOLCHAIN_LITERALS) {
    const at = span.indexOf(literal, 0, 'latin1');
    if (at === -1 || from + at >= to) continue;
    hits.push({ offset: from + at, shape: identityClass });
  }
  return hits.toSorted((a, b) => a.offset - b.offset);
}

/**
 * Bytes a narrower rule already accounted for. A byte map rather than a
 * rewritten string: rebuilding the text once per match makes the scan quadratic
 * in region size, which is how one compressed chunk turns into minutes of gate
 * time.
 */
type ClaimMap = Uint8Array;

function claim(claimed: ClaimMap, start: number, length: number): void {
  claimed.fill(1, start, start + length);
}

function isClaimed(claimed: ClaimMap, start: number, length: number): boolean {
  for (let index = start; index < start + length; index++) {
    if (claimed[index] === 1) return true;
  }
  return false;
}

// No hex boundary guards, deliberately. They belong to the text gate, where a
// long hex run in source could otherwise read as a uuid. Here the input is a
// printable run pulled out of a binary region, so framing bytes routinely abut
// the value, and the guards cost most of the real detections in this tree rather
// than a hypothetical few. The dash positions carry the discrimination instead.
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-([1-8])[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/giu;
// The zone is captured rather than skipped: midnight is a day boundary only in
// UTC, so the same clock under a non-zero offset is a disclosure.
// The zone designator is captured as one loose class rather than an
// alternation of its two spellings: `isUtcZone` is what decides whether the
// captured text leaves the clock in UTC, so the pattern only has to hand it
// over.
const ISO_PATTERN =
  /(?<!\d)\d{4}-\d{2}-\d{2}[T ](\d{2}):(\d{2})(?::(\d{2}))?(\.\d+)?([Zz+-][\d:]*)?/gu;
const GENERALIZED_TIME_PATTERN = /(?<![0-9A-Za-z._-])\d{8}(\d{2})(\d{2})(\d{2})Z/gu;
const CLOCK_PATTERN = /(?<![\d:])([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(\.\d+)?(?![\d:])/gu;
// The host-path vocabulary is the one the text gate reads, taken whole rather
// than restated: two hand-written answers to "does this string name a machine"
// drift, and nothing on either then says which of the differences was chosen.
//
// Two differences from the text gate are chosen, and both for the same reason:
// each of those policies was earned against source text, and neither
// justification survives the crossing into container metadata.
//
// No envelope guard. The text gate wraps this vocabulary in
// `HOST_PATH_ENVELOPE_GUARD_SOURCE`, so a root cannot be read at an inner
// segment of a longer word. The input here is a printable run pulled out of a
// metadata region, where framing bytes — a length prefix, a field name —
// routinely abut the value, so that guard would silence a host path glued behind
// a word character and this gate composes the sources bare. It is the same
// measured reasoning `UUID_PATTERN` carries, one rule over.
//
// The system temp root unconditionally. The shared source admits it only where a
// segment under it also carries a run of four or more digits, because
// unqualified matching there produced sixty-odd false findings against fixed
// paths written into workflow files. Container metadata holds no such paths, so
// nothing carries that justification over.
//
// Context-appropriate detection boundaries, not drift — do not "fix" either into
// agreement with the text gate.
const ROOTED_HOST_PATH = new RegExp(rootedHostPathSource({ tempRootNeedsDigitRun: false }), 'gu');
const NAMED_HOME_PATTERN = new RegExp(NAMED_HOME_SOURCE, 'gu');

/**
 * `claimed` marks bytes a pass recognized as its own construct, so a broader
 * later pass cannot re-read them; it is set even when the day-boundary
 * carve-out clears the value. A pass that merely inspected a span and found
 * nothing of its kind leaves it unclaimed.
 */
interface Verdict {
  readonly claimed: boolean;
  readonly shape?: string;
}

const UNRECOGNIZED: Verdict = { claimed: false };

interface Pass {
  readonly rule: LeakRule;
  readonly pattern: RegExp;
  readonly classify: (match: RegExpExecArray) => Verdict;
}

interface Clock {
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
  readonly fraction: string;
  /** Empty for a naive clock, which the carve-out reads as UTC. */
  readonly zone: string;
}

function clockVerdict(clock: Clock, shape: string, truncated = false): Verdict {
  const boundary =
    !truncated &&
    isUtcZone(clock.zone) &&
    isDayBoundaryClock(clock.hour, clock.minute, clock.second, clock.fraction);
  return boundary ? { claimed: true } : { claimed: true, shape };
}

/**
 * Whether the value the match read continues into a digit the match did not
 * take.
 *
 * The ISO pattern's time fields are fixed width and, unlike the bare clock's,
 * carry no trailing guard: a field written one digit wider is matched at its
 * first two digits and the surplus is left over. A guard on the pattern is the
 * wrong remedy — it would refuse the whole value and report nothing at all,
 * which is the direction a privacy gate must never fail in. The match is kept
 * and only the carve-out is withheld, because a carve-out is a statement about
 * a whole value and a prefix is not the value.
 */
function continuesInDigits(match: RegExpExecArray): boolean {
  return /\d/u.test(match.input.charAt(match.index + match[0].length));
}

/** Read as this band's epoch when it falls in the era window, or not read at all. */
function epochVerdict(
  match: RegExpExecArray,
  band: EpochBand,
  isDayBoundary: (value: number) => boolean
): Verdict {
  const value = ungroupedValue(match[0]);
  if (value < eraFloorOf(band) || value > band.ceiling) return UNRECOGNIZED;
  return isDayBoundary(value) ? { claimed: true } : { claimed: true, shape: shapeOf(band) };
}

export const PASSES: readonly Pass[] = [
  {
    rule: 'uuidv7',
    pattern: UUID_PATTERN,
    classify: (match) => {
      if (match[1] !== '7') return UNRECOGNIZED;
      return isDayBoundaryMillis(uuidV7Millis(match[0]))
        ? { claimed: true }
        : { claimed: true, shape: 'version-7 uuid (48-bit millisecond clock)' };
    },
  },
  {
    rule: 'iso-datetime',
    pattern: ISO_PATTERN,
    classify: (match) =>
      clockVerdict(
        {
          hour: Number(match[1]),
          minute: Number(match[2]),
          second: Number(match[3] ?? '0'),
          fraction: match[4] ?? '',
          zone: match[5] ?? '',
        },
        'ISO datetime with a time-of-day component',
        continuesInDigits(match)
      ),
  },
  {
    rule: 'generalized-time',
    pattern: GENERALIZED_TIME_PATTERN,
    classify: (match) =>
      clockVerdict(
        {
          hour: Number(match[1]),
          minute: Number(match[2]),
          second: Number(match[3]),
          fraction: '',
          zone: '',
        },
        'ASN.1 GeneralizedTime with a time-of-day component'
      ),
  },
  {
    rule: 'clock',
    pattern: CLOCK_PATTERN,
    classify: (match) =>
      clockVerdict(
        {
          hour: Number(match[1]),
          minute: Number(match[2]),
          second: Number(match[3]),
          fraction: match[4] ?? '',
          zone: '',
        },
        'bare clock literal at second resolution'
      ),
  },
  {
    rule: 'epoch-millis',
    pattern: digitRunOf(EPOCH_MILLIS_BAND),
    classify: (match) => epochVerdict(match, EPOCH_MILLIS_BAND, isDayBoundaryMillis),
  },
  {
    rule: 'epoch-seconds',
    pattern: digitRunOf(EPOCH_SECONDS_BAND),
    classify: (match) => epochVerdict(match, EPOCH_SECONDS_BAND, isDayBoundarySeconds),
  },
  {
    rule: 'host-path',
    pattern: ROOTED_HOST_PATH,
    classify: () => ({ claimed: true, shape: 'absolute host path' }),
  },
  {
    rule: 'host-path',
    pattern: NAMED_HOME_PATTERN,
    classify: () => ({ claimed: true, shape: 'tilde home reference' }),
  },
  ...TOOLCHAIN_LITERALS.map(({ literal, identityClass }) => ({
    rule: 'toolchain-identity' as const,
    pattern: new RegExp(literal.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`), 'gu'),
    classify: () => ({ claimed: true, shape: identityClass }),
  })),
];

function runPass(pass: Pass, text: string, claimed: ClaimMap, leaks: ValueLeak[]): void {
  const pattern = new RegExp(pass.pattern.source, pass.pattern.flags);
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    const length = match[0].length;
    if (isClaimed(claimed, match.index, length)) continue;
    const verdict = pass.classify(match);
    if (!verdict.claimed) continue;
    claim(claimed, match.index, length);
    if (verdict.shape !== undefined) {
      leaks.push({ rule: pass.rule, shape: verdict.shape, index: match.index });
    }
  }
}

/**
 * Every privacy rule that applies to decoded metadata text, in an order where
 * a broad rule never re-reports bytes a narrow one already claimed (the clock
 * inside an ISO datetime is one finding, not two).
 */
export function detectLeakValues(text: string): ValueLeak[] {
  const claimed: ClaimMap = new Uint8Array(text.length);
  const leaks: ValueLeak[] = [];
  for (const pass of PASSES) {
    runPass(pass, text, claimed, leaks);
  }
  return leaks.toSorted((a, b) => a.index - b.index);
}
