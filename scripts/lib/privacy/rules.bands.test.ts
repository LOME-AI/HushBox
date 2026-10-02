import { describe, expect, it } from 'vitest';

import { RULES, scanTextBlobs } from './rules.js';
import {
  baselineSampleOf,
  caseRows,
  casesFor,
  fillBranch,
  fillReps,
  fillText,
  screenSubject,
  summarizeAll,
} from './band-cases.js';
import type { BandSubject } from './band-cases.js';

/**
 * Every band in the text gate's patterns, asserted by a case derived from the
 * pattern rather than written down beside it.
 *
 * Two mechanisms, and neither works alone. The **derivation** is what stops a
 * band being forgotten: a band added to a pattern produces cases with no one
 * remembering to add them. The **recorded case set** is what stops a band
 * changing silently: a case derived from the value under test cannot detect a
 * change to that value, because narrowing a band simply moves the generated
 * endpoint with it. The recording is what turns that move into a failure.
 *
 * Recording it as a digest rather than as the sample is not a convenience. A
 * sample is a real disclosing value by construction, and this repository's gate
 * scans its own tests with no exemption, so writing one down would be the
 * violation the gate exists to block. For the same reason every assertion here
 * names the band and never the sample: a failing case must not print one into a
 * terminal or a CI log.
 *
 * To re-record after a deliberate band change: run this file with vitest's
 * `-u` flag after the path (`pnpm test:watch <path> -u`) and read the snapshot
 * diff — each moved row names the band that moved.
 */

const encoder = new TextEncoder();

/**
 * Not "no sample can sit at a lookaround's edge" — one can, and does: a sample
 * carrying a member of the guard class next to the value silences the rule. The
 * accurate statement is narrower and is about this generator, which renders a
 * zero-width assertion as empty text and so has no sample to emit. The guard's
 * own protection is not lost with the case: its key is its source text, so
 * narrowing the class inside it still turns the completeness screen red.
 */
const LOOKAROUND_EXEMPTION =
  'This generator renders a lookaround as empty text, so it emits no sample here — not because ' +
  'no value can sit at this edge, but because building one means writing text outside the match ' +
  'that this walk does not produce. The row is declared rather than omitted so that a guard ' +
  'added, widened or narrowed appears here as a changed key instead of as an absence.';

/**
 * Only the widening side. A field written one character narrower is not matched
 * at all, so that case stays asserted; a field written wider is surplus this
 * pattern now captures and the classifier refuses, which is the point of the
 * capture rather than a gap in it.
 */
const WIDENED_FIELD_IS_REPORTED =
  'A field written one digit wider than this quantifier reads leaves a surplus digit, which ' +
  'the pattern captures and the classifier refuses outright — so the wider value is reported ' +
  'rather than silent, and the silence this edge would otherwise assert is not the behaviour.';

const WORD_BOUNDARY_EXEMPTION =
  'A word-boundary assertion carries no class of its own to sit at the edge of, and this ' +
  'generator renders it as empty text. The row is declared rather than omitted so that a ' +
  'boundary added or removed appears here as a changed key instead of as an absence.';

function patternOf(name: string): RegExp {
  const rule = RULES.find((candidate) => candidate.name === name);
  if (rule === undefined) throw new Error(`no text-gate rule named ${name}`);
  return rule.pattern;
}

/** Three rules read only prose, so their samples need a blob path that is prose. */
function pathOf(name: string): string {
  const rule = RULES.find((candidate) => candidate.name === name);
  return rule?.proseOnly === true ? 'sample.md' : 'sample.txt';
}

function reports(rule: string, sample: string): boolean {
  return scanTextBlobs([{ path: pathOf(rule), bytes: encoder.encode(sample) }], []).some(
    (finding) => finding.rule === rule
  );
}

function matches(pattern: RegExp, sample: string): boolean {
  return new RegExp(pattern.source, pattern.flags.replaceAll(/[gy]/gu, '')).test(sample);
}

const ISO_DATETIME: BandSubject = {
  scope: 'iso-datetime',
  pattern: patternOf('iso-datetime'),
  bands: [
    { key: String.raw`guard:(?<![\dA-Za-z])#1`, exempt: LOOKAROUND_EXEMPTION },
    'quant:{4}#1',
    String.raw`set:\d#1`,
    'quant:{2}#1',
    String.raw`set:\d#2`,
    'quant:{2}#2',
    String.raw`set:\d#3`,
    'class:[T ]#1',
    String.raw`alt:(?:(\d{2}):(\d{2})(?::(\d{2})(\.\d+)?)?|(\d{2})-(\d{2})-(\d{2})(\.\d+)?)#1`,
    'quant:{2}#3',
    String.raw`set:\d#4`,
    { key: 'quant:{2}#4', outsideExempt: { above: WIDENED_FIELD_IS_REPORTED } },
    String.raw`set:\d#5`,
    'quant:?#1',
    'quant:{2}#5',
    String.raw`set:\d#6`,
    'quant:?#2',
    'quant:+#1',
    String.raw`set:\d#7`,
    'quant:?#3',
    'quant:?#4',
    String.raw`alt:(?:[Zz]|[+-]\d{2}:?\d{2})#1`,
    'class:[Zz]#1',
    'class:[+-]#1',
    'quant:{2}#6',
    String.raw`set:\d#8`,
    'quant:?#5',
    'quant:{2}#7',
    String.raw`set:\d#9`,
    'quant:*#1',
    String.raw`set:\d#10`,
    { key: 'quant:{2}#8', outsideExempt: { above: WIDENED_FIELD_IS_REPORTED } },
    String.raw`set:\d#11`,
    { key: 'quant:{2}#9', outsideExempt: { above: WIDENED_FIELD_IS_REPORTED } },
    String.raw`set:\d#12`,
    { key: 'quant:{2}#10', outsideExempt: { above: WIDENED_FIELD_IS_REPORTED } },
    String.raw`set:\d#13`,
    'quant:?#6',
    'quant:+#2',
    String.raw`set:\d#14`,
  ],
};

const RFC_1123: BandSubject = {
  scope: 'rfc1123-date',
  pattern: patternOf('rfc1123-date'),
  bands: [
    'alt:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)#1',
    'quant:+#1',
    String.raw`set:\s#1`,
    'quant:{1,2}#1',
    String.raw`set:\d#1`,
    'quant:+#2',
    String.raw`set:\s#2`,
    'alt:(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)#1',
    'quant:+#3',
    String.raw`set:\s#3`,
    'quant:{4}#1',
    String.raw`set:\d#2`,
    {
      key: 'quant:?#1',
      fill: fillReps(1),
      patternOnly:
        'This is the optional time-of-day group, and the classifier declines a date that has ' +
        'none — an RFC-1123 date without a clock discloses no time. Its absent state is ' +
        'therefore reachable in the pattern and silent in the gate.',
    },
    'quant:+#4',
    String.raw`set:\s#4`,
    'quant:{2}#1',
    String.raw`set:\d#3`,
    'quant:{2}#2',
    String.raw`set:\d#4`,
    'quant:{2}#3',
    String.raw`set:\d#5`,
    'quant:?#2',
    'quant:+#5',
    String.raw`set:\s#5`,
    String.raw`alt:([A-Z]{1,5}|[+-]\d{4})#1`,
    'quant:{1,5}#1',
    'class:[A-Z]#1',
    'class:[+-]#1',
    'quant:{4}#2',
    String.raw`set:\d#6`,
  ],
};

const COMPACT_CLOCK_BOUNDS =
  'Both ends of this digit set put the time component outside what the classifier reads as a ' +
  'clock: an all-zero time is the day-boundary carve-out and an all-nine time exceeds the hour ' +
  'bound. Those two bounds live in the classifier, not in the pattern, so they are asserted in ' +
  'the declared-bounds table below and the endpoints are asserted against the pattern here.';

const COMPACT_DATETIME: BandSubject = {
  scope: 'compact-datetime',
  pattern: patternOf('compact-datetime'),
  bands: [
    { key: String.raw`guard:(?<![\dA-Za-z._-])#1`, exempt: LOOKAROUND_EXEMPTION },
    { key: String.raw`alt:(\d{8}T\d{6}|\d{14}|\d{12})#1`, fill: fillBranch(0) },
    'quant:{8}#1',
    String.raw`set:\d#1`,
    'quant:{6}#1',
    { key: String.raw`set:\d#2`, fill: fillText('1'), patternOnly: COMPACT_CLOCK_BOUNDS },
    'quant:{14}#1',
    { key: String.raw`set:\d#3`, fill: fillText('1'), patternOnly: COMPACT_CLOCK_BOUNDS },
    'quant:{12}#1',
    { key: String.raw`set:\d#4`, fill: fillText('1'), patternOnly: COMPACT_CLOCK_BOUNDS },
    'quant:?#1',
    'quant:+#1',
    String.raw`set:\d#5`,
    { key: 'quant:?#2', fill: fillReps(1) },
    { key: String.raw`guard:(?![\dA-Za-z._-])#1`, exempt: LOOKAROUND_EXEMPTION },
  ],
};

/**
 * A negated set standing for the horizontal whitespace a reading and its marker
 * may be parted by. Its members are every space character bar the line feed, so
 * it has no derivable endpoint and no value one step outside it: a step past the
 * complement lands on a character the class beside it already admits. The
 * separator is asserted by value in the rule suite — one space read, a line
 * break refused — rather than bound here.
 */
const HORIZONTAL_SPACE_CLASS =
  'a negated set spanning every whitespace character but the line feed, which ' +
  'has no derivable member endpoint. The one space it admits and the line break ' +
  'it refuses are each asserted by value in the rule suite rather than bound here.';

const AMPM: BandSubject = {
  scope: 'meridiem-clock',
  pattern: patternOf('meridiem-clock'),
  bands: [
    { key: String.raw`guard:(?<![\w:.])#1`, exempt: LOOKAROUND_EXEMPTION },
    'quant:{1,2}#1',
    String.raw`set:\d#1`,
    'quant:?#1',
    'class:[0-5]#1',
    String.raw`set:\d#2`,
    'quant:?#4',
    { key: String.raw`class:[^\S\n]#1`, exempt: HORIZONTAL_SPACE_CLASS },
    'class:[APap]#1',
    'quant:?#2',
    'class:[Mm]#1',
    'quant:?#3',
    { key: String.raw`guard:(?![\w])#1`, exempt: LOOKAROUND_EXEMPTION },
  ],
};

const UUID_V7: BandSubject = {
  scope: 'uuidv7',
  pattern: patternOf('uuidv7'),
  bands: [
    { key: 'guard:(?<![0-9a-fA-F-])#1', exempt: LOOKAROUND_EXEMPTION },
    'quant:{8}#1',
    'class:[0-9a-fA-F]#1',
    'quant:{4}#1',
    'class:[0-9a-fA-F]#2',
    'quant:{3}#1',
    'class:[0-9a-fA-F]#3',
    'quant:{4}#2',
    'class:[0-9a-fA-F]#4',
    'quant:{12}#1',
    'class:[0-9a-fA-F]#5',
    { key: 'guard:(?![0-9a-fA-F-])#1', exempt: LOOKAROUND_EXEMPTION },
  ],
};

const ZONE_ABBREVIATION: BandSubject = {
  scope: 'timezone-abbreviation',
  pattern: patternOf('timezone-abbreviation'),
  bands: [
    { key: String.raw`guard:\b#1`, exempt: WORD_BOUNDARY_EXEMPTION },
    'alt:(?:A[CEKW][SD]T|[CEMP][SD]T|H[SD]T|NZ[SD]T|BST|CES?T|EES?T|WES?T|IST|JST|KST)#1',
    'class:[CEKW]#1',
    'class:[SD]#1',
    'class:[CEMP]#1',
    'class:[SD]#2',
    'class:[SD]#3',
    'quant:?#1',
    'quant:?#2',
    'quant:?#3',
    'class:[SD]#4',
    { key: String.raw`guard:\b#2`, exempt: WORD_BOUNDARY_EXEMPTION },
  ],
};

const SEASONLESS_ZONE: BandSubject = {
  scope: 'seasonless-timezone-abbreviation',
  pattern: patternOf('seasonless-timezone-abbreviation'),
  // The rule reads a zone spelling only where a clock reading sits beside it, so
  // a bare token is not a finding and every sample needs a reading on its line.
  context: (sample) => `${sample} at ${['17', '45'].join(':')}`,
  bands: [
    { key: String.raw`guard:\b#1`, exempt: WORD_BOUNDARY_EXEMPTION },
    'alt:(?:A[CEKW]T|[CEMP]T|HT|NZT)#1',
    'class:[CEKW]#1',
    'class:[CEMP]#1',
    { key: String.raw`guard:\b#2`, exempt: WORD_BOUNDARY_EXEMPTION },
  ],
};

const IANA_ZONE: BandSubject = {
  scope: 'iana-timezone',
  pattern: patternOf('iana-timezone'),
  bands: [
    { key: String.raw`guard:\b#1`, exempt: WORD_BOUNDARY_EXEMPTION },
    'alt:(?:Africa|America|Antarctica|Arctic|Asia|Atlantic|Australia|Europe|Indian|Pacific)#1',
    'class:[A-Z]#1',
    'quant:+#1',
    'class:[A-Za-z_]#1',
    'quant:?#1',
    'class:[A-Z]#2',
    'quant:+#2',
    'class:[A-Za-z_]#2',
    { key: String.raw`guard:\b#2`, exempt: WORD_BOUNDARY_EXEMPTION },
  ],
};

/**
 * The sign class renders no case because it is declared exempt below, not
 * because nothing is derivable from it: run against the shipped pattern with no
 * declarations, the generator yields one member variant for this band — the
 * ASCII plus — and no endpoint outside it, because the Unicode property half
 * supplies neither bound. The class is asserted by value in the rule suite
 * instead, one test per spelling — the same arrangement the host-path rule's
 * elided-segment class already uses, declared exempt and asserted by value.
 */
const OFFSET_SIGN_CLASS =
  'a union of an ASCII plus with the Unicode dash property, and a property has ' +
  'no derivable member endpoint. Every spelling the class admits — the plus and ' +
  'each dash — is asserted by value in the rule suite, one test per spelling, ' +
  'rather than bound here.';

/**
 * Behind a zone token the minute field may be dropped, so the hour band's low
 * endpoint is a whole offset on its own — and a zero offset is UTC, which the
 * classifier carves out. The pattern still reaches the endpoint, so the case is
 * asserted against the pattern and the carve-out is what intercepts it.
 */
const ZERO_OFFSET_IS_UTC =
  'a zero offset behind a zone token, which the classifier carves out as UTC by ' +
  'another name rather than reporting as a location.';

/**
 * The two hour spellings overlap by construction: one digit is a legal offset
 * behind a zone token, so a value one step below the two-digit band is still
 * read — by the shorter alternative, not by this band.
 */
const TENS_DIGIT_READS_ALONE =
  'the sibling alternative reads a single digit, so an hour one step below this ' +
  "band's low end is still a legal offset in the shorter spelling.";

const ZONE_OFFSET: BandSubject = {
  scope: 'timezone-offset',
  pattern: patternOf('timezone-offset'),
  bands: [
    { key: String.raw`guard:(?<![\w.,:+-])#1`, exempt: LOOKAROUND_EXEMPTION },
    { key: String.raw`class:[+\p{Dash}]#1`, exempt: OFFSET_SIGN_CLASS },
    String.raw`alt:(0\d|1[0-4])#1`,
    String.raw`set:\d#1`,
    'class:[0-4]#1',
    'quant:?#1',
    'alt:(00|15|30|45)#1',
    { key: String.raw`guard:(?![\w.,:+-])#1`, exempt: LOOKAROUND_EXEMPTION },
    String.raw`alt:(?<![\w.,:+-])([+\p{Dash}])(0\d|1[0-4]):?(00|15|30|45)(?![\w.,:+-])|\b(?:UTC|GMT|UT)[+\p{Dash}](0?\d|1[0-4])(?::?(00|15|30|45))?(?![\w.,:+-])#1`,
    { key: String.raw`guard:\b#1`, exempt: WORD_BOUNDARY_EXEMPTION },
    'alt:(?:UTC|GMT|UT)#1',
    { key: String.raw`class:[+\p{Dash}]#2`, exempt: OFFSET_SIGN_CLASS },
    String.raw`alt:(0?\d|1[0-4])#1`,
    'quant:?#2',
    { key: String.raw`set:\d#2`, patternOnly: ZERO_OFFSET_IS_UTC },
    { key: 'class:[0-4]#2', outsideExempt: { below: TENS_DIGIT_READS_ALONE } },
    'quant:?#3',
    'quant:?#4',
    'alt:(00|15|30|45)#2',
    { key: String.raw`guard:(?![\w.,:+-])#2`, exempt: LOOKAROUND_EXEMPTION },
  ],
};

/**
 * Only the widening side. Measured with this generator's own rendering: a digit
 * added at the edge is swallowed by the neighbouring unbounded repetition, and a
 * digit removed is not — one digit fewer and the rule reports nothing, so that
 * case is kept and is worth keeping.
 */
const ABSORBED_BY_FLANKING_REPETITION =
  'The digit run this bound sizes is flanked by unbounded word-character repetitions, which ' +
  'absorb a digit added at either edge, so a wider value cannot make the rule silent. Only this ' +
  'direction is absorbed: the narrower case is silent and is asserted.';

/**
 * The class carrying the non-ASCII half of a segment is the complement of ASCII
 * and whitespace, so it has neither a derivable member for an endpoint nor an
 * outside: one step past a complement lands in the class beside it. The
 * generator renders it empty, which is why the row carries a fill. What the
 * class is for — the spellings of an elision a writer produces interchangeably,
 * and the letters a name outside ASCII is written in — is asserted by value in
 * the rule suite rather than by bound here.
 */
const ELIDED_SEGMENT_CLASS =
  'A negated set spanning every non-ASCII character that is not whitespace has no derivable ' +
  'endpoint and no outside to sit one step past. The spellings and the letters it admits are ' +
  'asserted by value in the rule suite, where each is a sample rather than a bound.';

/** Renders the elided-segment class while some other band is under test. */
const ELISION_FILL = fillText('…');

/**
 * The named-home shorthand's opening letter is a Unicode property rather than a
 * set this walk can enumerate, so it is the second class here with no endpoint
 * to sit one step past. What it admits — a letter in any script — and what it
 * refuses one step out — a digit, a hyphen — are asserted by value in the rule
 * suite, where each is a sample rather than a bound.
 */
const NAMED_HOME_LETTER_CLASS =
  'A Unicode letter property has no derivable endpoint and no outside this walk can render. ' +
  'The scripts it admits, and the digit and the hyphen it refuses, are asserted by value in ' +
  'the rule suite, where each is a sample rather than a bound.';

/** Renders the shorthand's opening letter while some other band is under test. */
const NAMED_HOME_LETTER_FILL = fillText('é');

const HOST_PATH: BandSubject = {
  scope: 'absolute-host-path',
  pattern: patternOf('absolute-host-path'),
  bands: [
    { key: String.raw`guard:(?<![\w.~])#1`, exempt: LOOKAROUND_EXEMPTION },
    { key: String.raw`guard:(?<!\/)#1`, exempt: LOOKAROUND_EXEMPTION },
    String.raw`alt:(?:\/(?:home|Users|workspace|opt)\/(?:[\w.-]|[^\p{ASCII}\s])+|\/(?:private\/)?tmp\/(?:(?:[\w.-]|[^\p{ASCII}\s])+\/)*(?:[\w.-]|[^\p{ASCII}\s])*\d{4}(?:[\w.-]|[^\p{ASCII}\s])*|\/(?:private\/)?var\/folders\/(?:[\w.-]|[^\p{ASCII}\s])+|[A-Za-z]:\\{1,2}(?:[\w.-]|[^\p{ASCII}\s])+|(?<!\/)~\p{L}(?:[\w.-]|[^\p{ASCII}\s])*\/)#1`,
    'alt:(?:home|Users|workspace|opt)#1',
    'quant:+#1',
    String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#1`,
    String.raw`class:[\w.-]#1`,
    {
      key: String.raw`class:[^\p{ASCII}\s]#1`,
      fill: ELISION_FILL,
      exempt: ELIDED_SEGMENT_CLASS,
    },
    'quant:*#1',
    'quant:?#1',
    'quant:+#2',
    String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#2`,
    String.raw`class:[\w.-]#2`,
    {
      key: String.raw`class:[^\p{ASCII}\s]#2`,
      fill: ELISION_FILL,
      exempt: ELIDED_SEGMENT_CLASS,
    },
    'quant:*#2',
    String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#3`,
    String.raw`class:[\w.-]#3`,
    {
      key: String.raw`class:[^\p{ASCII}\s]#3`,
      fill: ELISION_FILL,
      exempt: ELIDED_SEGMENT_CLASS,
    },
    {
      key: 'quant:{4}#1',
      outsideExempt: { above: ABSORBED_BY_FLANKING_REPETITION },
    },
    String.raw`set:\d#1`,
    'quant:*#3',
    String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#4`,
    String.raw`class:[\w.-]#4`,
    {
      key: String.raw`class:[^\p{ASCII}\s]#4`,
      fill: ELISION_FILL,
      exempt: ELIDED_SEGMENT_CLASS,
    },
    'quant:?#2',
    'quant:+#3',
    String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#5`,
    String.raw`class:[\w.-]#5`,
    {
      key: String.raw`class:[^\p{ASCII}\s]#5`,
      fill: ELISION_FILL,
      exempt: ELIDED_SEGMENT_CLASS,
    },
    'class:[A-Za-z]#1',
    'quant:*#4',
    String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#6`,
    String.raw`class:[\w.-]#6`,
    {
      key: String.raw`class:[^\p{ASCII}\s]#6`,
      fill: ELISION_FILL,
      exempt: ELIDED_SEGMENT_CLASS,
    },
    {
      key: String.raw`set:\p{L}#1`,
      fill: NAMED_HOME_LETTER_FILL,
      exempt: NAMED_HOME_LETTER_CLASS,
    },
    'quant:{1,2}#1',
    'quant:+#4',
    String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#7`,
    String.raw`class:[\w.-]#7`,
    {
      key: String.raw`class:[^\p{ASCII}\s]#7`,
      fill: ELISION_FILL,
      exempt: ELIDED_SEGMENT_CLASS,
    },
  ],
};

const EPOCH_MS: BandSubject = {
  scope: 'epoch-ms',
  pattern: patternOf('epoch-ms'),
  bands: [
    { key: String.raw`guard:(?<![\dA-Za-z._-])#1`, exempt: LOOKAROUND_EXEMPTION },
    // The two grouping separators, each optional: one inside the era's own two
    // digits, one in front of every digit after them. Both endpoints match —
    // absent is the ungrouped spelling and present is the grouped one — which is
    // the close itself, stated as a band rather than as a fixture.
    'quant:?#1',
    'class:[6-9]#1',
    'quant:{11}#1',
    'quant:?#2',
    String.raw`set:\d#1`,
    { key: String.raw`alt:(?:\.\d+(?![\dA-Za-z_-])|(?![\dA-Za-z._-]))#1`, fill: fillBranch(1) },
    'quant:+#1',
    String.raw`set:\d#2`,
    { key: String.raw`guard:(?![\dA-Za-z_-])#1`, exempt: LOOKAROUND_EXEMPTION },
    { key: String.raw`guard:(?![\dA-Za-z._-])#1`, exempt: LOOKAROUND_EXEMPTION },
  ],
};

const EPOCH_SECONDS: BandSubject = {
  scope: 'epoch-seconds',
  pattern: patternOf('epoch-seconds'),
  bands: [
    { key: String.raw`guard:(?<![\dA-Za-z._-])#1`, exempt: LOOKAROUND_EXEMPTION },
    // The two grouping separators, each optional: one inside the era's own two
    // digits, one in front of every digit after them. Both endpoints match —
    // absent is the ungrouped spelling and present is the grouped one — which is
    // the close itself, stated as a band rather than as a fixture.
    'quant:?#1',
    'class:[6-9]#1',
    'quant:{8}#1',
    'quant:?#2',
    String.raw`set:\d#1`,
    { key: String.raw`alt:(?:\.\d+(?![\dA-Za-z_-])|(?![\dA-Za-z._-]))#1`, fill: fillBranch(1) },
    'quant:+#1',
    String.raw`set:\d#2`,
    { key: String.raw`guard:(?![\dA-Za-z_-])#1`, exempt: LOOKAROUND_EXEMPTION },
    { key: String.raw`guard:(?![\dA-Za-z._-])#1`, exempt: LOOKAROUND_EXEMPTION },
  ],
};

const CLOCK_SECONDS: BandSubject = {
  scope: 'clock-seconds',
  pattern: patternOf('clock-seconds'),
  bands: [
    { key: String.raw`guard:(?<![\d:.,+-])#1`, exempt: LOOKAROUND_EXEMPTION },
    'quant:{1,2}#1',
    // The hour digits. The middle of the digit band repeated twice is above the
    // classifier's hour bound, which would make the two-digit endpoint silent.
    { key: String.raw`set:\d#1`, fill: fillText('1') },
    'class:[0-5]#1',
    String.raw`set:\d#2`,
    'class:[0-5]#2',
    String.raw`set:\d#3`,
    'quant:?#1',
    'quant:+#1',
    String.raw`set:\d#4`,
    { key: String.raw`guard:(?![\d:])#1`, exempt: LOOKAROUND_EXEMPTION },
  ],
};

const CLOCK_MINUTES: BandSubject = {
  scope: 'clock-minutes',
  pattern: patternOf('clock-minutes'),
  bands: [
    { key: String.raw`guard:(?<![\d:.,+-])#1`, exempt: LOOKAROUND_EXEMPTION },
    String.raw`alt:([01]\d|2[0-3])#1`,
    'class:[01]#1',
    String.raw`set:\d#1`,
    'class:[0-3]#1',
    'class:[0-5]#1',
    String.raw`set:\d#2`,
    { key: String.raw`guard:(?![\d:])#1`, exempt: LOOKAROUND_EXEMPTION },
  ],
};

const NEGATED_ARGUMENT_CLASS =
  'A negated set spans every character but the three that end an argument or the call, so it ' +
  'has no derivable endpoint for a case to sit one step outside of. What the class is for — ' +
  'reading an argument as a separator-free run — is asserted in the declared-bounds table ' +
  'below, where an argument that is not a digit run is read as declared.';

const ARGUMENT_COUNT_BOUND =
  'The fewest repetitions the argument-list quantifier allows is a three-argument call, which ' +
  'names a calendar day and no clock, so the classifier declines it and the whole gate is ' +
  'silent on a sample the pattern matches. Cases at this band and inside it render the list at ' +
  'that minimum, so both are asserted against the pattern; that the fourth argument is where ' +
  'the clock starts is asserted in the declared-bounds table below.';

const DATE_ARGUMENTS: BandSubject = {
  scope: 'date-arguments',
  pattern: patternOf('date-arguments'),
  bands: [
    String.raw`alt:(?:new\s+Date|Date\.UTC)#1`,
    'quant:+#1',
    String.raw`set:\s#1`,
    'quant:*#1',
    String.raw`set:\s#2`,
    'quant:+#2',
    { key: 'class:[^(),]#1', fill: fillText('1'), exempt: NEGATED_ARGUMENT_CLASS },
    { key: 'quant:{2,6}#1', fill: fillReps(3), patternOnly: ARGUMENT_COUNT_BOUND },
    { key: 'quant:+#3', patternOnly: ARGUMENT_COUNT_BOUND },
    { key: 'class:[^(),]#2', fill: fillText('1'), exempt: NEGATED_ARGUMENT_CLASS },
  ],
};

const MASKED_CLOCK: BandSubject = {
  scope: 'masked-digit-clock',
  pattern: patternOf('masked-digit-clock'),
  bands: [
    { key: String.raw`guard:(?<![\w:.,+-])#1`, exempt: LOOKAROUND_EXEMPTION },
    String.raw`alt:(?:(?:\d[A-Za-z]|[A-Za-z]\d):\d{2}(?::\d{2})?|\d{2}:(?:\d[A-Za-z]|[A-Za-z]\d)(?::\d{2})?|\d{2}:\d{2}:(?:\d[A-Za-z]|[A-Za-z]\d))#1`,
    String.raw`alt:(?:\d[A-Za-z]|[A-Za-z]\d)#1`,
    String.raw`set:\d#1`,
    String.raw`class:[A-Za-z]#1`,
    String.raw`class:[A-Za-z]#2`,
    String.raw`set:\d#2`,
    String.raw`quant:{2}#1`,
    String.raw`set:\d#3`,
    String.raw`quant:?#1`,
    String.raw`quant:{2}#2`,
    String.raw`set:\d#4`,
    String.raw`quant:{2}#3`,
    String.raw`set:\d#5`,
    String.raw`alt:(?:\d[A-Za-z]|[A-Za-z]\d)#2`,
    String.raw`set:\d#6`,
    String.raw`class:[A-Za-z]#3`,
    String.raw`class:[A-Za-z]#4`,
    String.raw`set:\d#7`,
    String.raw`quant:?#2`,
    String.raw`quant:{2}#4`,
    String.raw`set:\d#8`,
    String.raw`quant:{2}#5`,
    String.raw`set:\d#9`,
    String.raw`quant:{2}#6`,
    String.raw`set:\d#10`,
    String.raw`alt:(?:\d[A-Za-z]|[A-Za-z]\d)#3`,
    String.raw`set:\d#11`,
    String.raw`class:[A-Za-z]#5`,
    String.raw`class:[A-Za-z]#6`,
    String.raw`set:\d#12`,
    { key: String.raw`guard:(?![\w:])#1`, exempt: LOOKAROUND_EXEMPTION },
  ],
};

const SUBJECTS: readonly BandSubject[] = [
  ISO_DATETIME,
  RFC_1123,
  COMPACT_DATETIME,
  AMPM,
  UUID_V7,
  ZONE_ABBREVIATION,
  SEASONLESS_ZONE,
  IANA_ZONE,
  ZONE_OFFSET,
  HOST_PATH,
  EPOCH_MS,
  EPOCH_SECONDS,
  DATE_ARGUMENTS,
  CLOCK_SECONDS,
  CLOCK_MINUTES,
  MASKED_CLOCK,
];

const ALL_CASES = SUBJECTS.flatMap((subject) =>
  casesFor(subject).map(
    (item) => [`${item.scope} · ${item.key} · ${item.label} · ${item.edge}`, item] as const
  )
);

describe('the text gate band inventory', () => {
  it('carries a subject for every rule in the set', () => {
    expect(SUBJECTS.map((subject) => subject.scope)).toEqual(RULES.map((rule) => rule.name));
  });

  it.each(SUBJECTS)('$scope declares exactly the bands its pattern has', (subject) => {
    expect(screenSubject(subject)).toEqual({
      undeclared: [],
      stale: [],
      unexplained: [],
      misdeclared: [],
    });
  });

  it.each(SUBJECTS)('$scope reports the sample built from its own fills', (subject) => {
    expect(reports(subject.scope, baselineSampleOf(subject))).toBe(true);
  });

  it('states how many bands it found, covered and declared exempt', () => {
    expect(summarizeAll(SUBJECTS)).toEqual({
      found: 280,
      covered: 236,
      exempt: 44,
      insideGuards: 23,
    });
    expect(ALL_CASES.length).toBe(831);
  });
});

describe('the recorded case set', () => {
  it.each(SUBJECTS)('$scope generates the case set recorded for it', (subject) => {
    expect(caseRows(subject)).toMatchSnapshot();
  });
});

describe('the generated endpoint cases', () => {
  it.each(ALL_CASES)('the text gate reads %s as declared', (_title, item) => {
    const observed =
      item.oracle === 'full'
        ? reports(item.scope, item.sample)
        : matches(patternOf(item.scope), item.sample);

    expect(observed).toBe(item.expect === 'match');
  });
});

/**
 * The bands a regular expression cannot see: bounds this gate enforces in the
 * classifier, where the generator has nothing to walk. Each row is asserted at
 * its edge with a literal — never with a value derived from the bound, which
 * would move with it and pin nothing.
 *
 * A classifier bound built from the same declaration as a band the generator
 * does walk has no row here, and adding one back would pin nothing: the minute
 * and second ceilings are the clock patterns' own character class stated as a
 * number, so moving either moves the generated endpoints of that class and the
 * recorded case set below fails on its own.
 */
interface DeclaredBound {
  readonly rule: string;
  readonly bound: string;
  readonly inside: readonly string[];
  readonly outside: readonly string[];
}

/**
 * Every edge below is a literal, stated rather than computed from the bound it
 * pins — a fixture derived from the constant moves with the constant and detects
 * nothing. Each is split into pieces for a second reason: assembled it is a real
 * disclosing value, and this gate scans this file with no exemption, so the
 * split is chosen at a point where no piece is a finding on its own.
 */
const DECLARED_BOUNDS: readonly DeclaredBound[] = [
  {
    rule: 'compact-datetime',
    bound: 'hour ceiling, above which the digit run is not read as a clock at all',
    inside: ['11111111T', '231111'],
    outside: ['11111111T', '241111'],
  },
  {
    rule: 'compact-datetime',
    bound: 'a separator-free run must carry the zulu designator to be read at all',
    inside: ['11111111', '111111Z'],
    outside: ['11111111', '111111'],
  },
  {
    rule: 'clock-seconds',
    bound: 'hour ceiling',
    inside: ['23', ':11:11'],
    outside: ['24', ':11:11'],
  },
  {
    rule: 'iso-datetime',
    bound: 'day-boundary carve-out, refused where the value continues in digits past it',
    inside: ['2026-08-16T00:00:00', '1'],
    outside: ['2026-08-16T00:00:00'],
  },
  {
    rule: 'iso-datetime',
    bound: 'that same refusal where it is the minute field that was written wider',
    inside: ['2026-08-16T00:00', '0'],
    outside: ['2026-08-16T00:00'],
  },
  {
    rule: 'date-arguments',
    bound:
      'the fourth argument, where the clock starts — a construction of a calendar day alone ' +
      'names no time of day and is declined',
    inside: ['Date.', 'UTC(4444, 4, 4, 11)'],
    outside: ['Date.', 'UTC(4444, 4, 4)'],
  },
  {
    rule: 'date-arguments',
    bound:
      'an hour written as a digit run, without which there is no written clock for the ' +
      'constraint to reach',
    inside: ['Date.', 'UTC(4444, 4, dayIndex, 11, minuteIndex)'],
    outside: ['Date.', 'UTC(4444, 4, dayIndex, hourIndex, 11)'],
  },
  {
    rule: 'rfc1123-date',
    bound: 'a date with no time component discloses no time of day and is declined',
    inside: ['Thu, 4 Jun 4444 11', ':11:11'],
    outside: ['Thu, 4 Jun 4444'],
  },
  {
    rule: 'meridiem-clock',
    bound:
      'the afternoon marker shifts the hour by twelve, so twelve in the afternoon is noon and ' +
      'reported while twelve in the morning is midnight and carved out',
    inside: ['12', 'PM'],
    outside: ['12', 'AM'],
  },
];

function boundSample(row: DeclaredBound, edge: 'inside' | 'outside'): string {
  return (edge === 'inside' ? row.inside : row.outside).join('');
}

describe('the bands that live in the classifier rather than in a pattern', () => {
  it.each(DECLARED_BOUNDS)('$rule reports at its $bound', (row) => {
    expect(reports(row.rule, boundSample(row, 'inside'))).toBe(true);
  });

  it.each(DECLARED_BOUNDS)('$rule is silent one step past its $bound', (row) => {
    expect(reports(row.rule, boundSample(row, 'outside'))).toBe(false);
  });
});
