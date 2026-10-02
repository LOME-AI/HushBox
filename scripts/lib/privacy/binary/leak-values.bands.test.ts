import { describe, expect, it } from 'vitest';

import { PASSES, detectLeakValues } from './leak-values.js';
import {
  baselineSampleOf,
  caseRows,
  casesFor,
  fillText,
  screenSubject,
  summarizeAll,
} from '../band-cases.js';
import type { BandSubject } from '../band-cases.js';

/**
 * Every band in the binary gate's value passes, asserted by a case derived from
 * the pattern. The reasoning behind the two mechanisms — derivation for bands
 * that are new, a recorded case set for bands that moved — is written out once
 * in the text gate's band file and is not repeated here.
 *
 * This gate's passes are where the split between pattern and classifier is
 * widest: the two epoch passes read a bare digit run of a declared width, and
 * the era window that tells the run apart from any other number of that width
 * is one no regular expression carries. That window is in the declared-bounds
 * table at the foot of this file rather than absent.
 *
 * To re-record after a deliberate band change: run this file with vitest's `-u`
 * flag after the path (`pnpm test:watch <path> -u`) and read the snapshot diff —
 * each moved row names the band that moved.
 */

/**
 * Not "no sample can sit at a lookaround's edge" — one can, and does: a sample
 * carrying a member of the guard class next to the value silences the pass. The
 * accurate statement is about this generator, which renders a zero-width
 * assertion as empty text and so has no sample to emit. The guard's protection
 * survives the missing case: its key is its source text, so narrowing the class
 * inside it still turns the completeness screen red.
 */
const LOOKAROUND_EXEMPTION =
  'This generator renders a lookaround as empty text, so it emits no sample here — not because ' +
  'no value can sit at this edge, but because building one means writing text outside the match ' +
  'that this walk does not produce. The row is declared rather than omitted so that a guard ' +
  'added, widened or narrowed appears here as a changed key instead of as an absence.';

const CLASSIFIER_ERA_WINDOW =
  'Both ends of this digit set put the run outside the era window the classifier holds: an ' +
  'all-zero run of this width falls below its floor and an all-nine run sits above its ceiling. ' +
  'The endpoints are therefore asserted against the pattern, and the window itself is in the ' +
  'declared-bounds table. The width is not among the bounds it holds — the pattern carries that, ' +
  'so it is a band of its own here and is read through the whole gate.';

/**
 * Only the widening side. A field written one character wider is matched from
 * its second character onward; a field written one character narrower is not
 * matched at all, so that case is kept.
 */
const UNGUARDED_END_FIELD =
  'This uuid pattern deliberately carries no hex boundary guards — with them, most of the ' +
  'version-7 uuids in this repository’s own binaries went unreported — so a first or last ' +
  'field written one character wider is matched from its second character onward rather than ' +
  'refused. Only this direction is absorbed: the narrower case is silent and is asserted.';

/**
 * The non-ASCII half of a segment is the complement of ASCII and whitespace, so
 * it has no derivable endpoint and no outside one step past it. The spellings it
 * admits are asserted by value in this gate's own rule suite.
 */
const ELIDED_SEGMENT_CLASS =
  'A negated set spanning every non-ASCII character that is not whitespace has no derivable ' +
  'endpoint and no outside to sit one step past. The spellings and letters it admits are ' +
  'asserted by value in the rule suite, each as a sample rather than as a bound.';

/** Renders the elided-segment class while some other band is under test. */
const ELISION_FILL = fillText('…');

/**
 * The shorthand's opening letter is a Unicode property rather than a set this
 * walk can enumerate, so it is a second class with no endpoint to sit one step
 * past.
 */
const NAMED_HOME_LETTER_CLASS =
  'A Unicode letter property has no derivable endpoint and no outside this walk can render. ' +
  'The scripts it admits, and the digit and hyphen it refuses, are asserted by value in ' +
  'the rule suite, each as a sample rather than as a bound.';

/** Renders the shorthand's opening letter while some other band is under test. */
const NAMED_HOME_LETTER_FILL = fillText('é');

function patternAt(index: number): RegExp {
  const pass = PASSES[index];
  if (pass === undefined) throw new Error(`no binary-gate pass at index ${String(index)}`);
  return pass.pattern;
}

function leaks(rule: string, sample: string): boolean {
  return detectLeakValues(sample).some((leak) => leak.rule === rule);
}

function matches(pattern: RegExp, sample: string): boolean {
  return new RegExp(pattern.source, pattern.flags.replaceAll(/[gy]/gu, '')).test(sample);
}

/**
 * A pass whose pattern is an escaped constant, so it carries no band at all.
 * The scope is passed as a literal rather than read back out of the pass it
 * names: built from the registry, both sides of the coverage assertion below
 * would be the same expression and a renamed pass could not fail it.
 */
function literalSubject(scope: string): BandSubject {
  return { scope, pattern: patternOf(scope), bands: [] };
}

const SUBJECTS: readonly BandSubject[] = [
  {
    scope: '0:uuidv7',
    pattern: patternAt(0),
    bands: [
      { key: 'quant:{8}#1', outsideExempt: { above: UNGUARDED_END_FIELD } },
      'class:[0-9a-f]#1',
      'quant:{4}#1',
      'class:[0-9a-f]#2',
      {
        key: 'class:[1-8]#1',
        fill: fillText('7'),
        patternOnly:
          'This is the version nibble, and the pass reads version seven alone. Every other ' +
          'member of the band is matched by the pattern and declined by the classifier, so ' +
          'both endpoints are silent through the whole gate by design.',
      },
      'quant:{3}#1',
      'class:[0-9a-f]#3',
      'class:[89ab]#1',
      'quant:{3}#2',
      'class:[0-9a-f]#4',
      { key: 'quant:{12}#1', outsideExempt: { above: UNGUARDED_END_FIELD } },
      'class:[0-9a-f]#5',
    ],
  },
  {
    scope: '1:iso-datetime',
    pattern: patternAt(1),
    bands: [
      { key: String.raw`guard:(?<!\d)#1`, exempt: LOOKAROUND_EXEMPTION },
      'quant:{4}#1',
      String.raw`set:\d#1`,
      'quant:{2}#1',
      String.raw`set:\d#2`,
      'quant:{2}#2',
      String.raw`set:\d#3`,
      'class:[T ]#1',
      'quant:{2}#3',
      String.raw`set:\d#4`,
      {
        key: 'quant:{2}#4',
        outsideExempt: {
          above:
            'This pattern carries no trailing digit guard, so a minute written one digit wider ' +
            'is matched at its first two digits and the surplus is left over rather than ' +
            'refused. Only this direction is absorbed: the narrower case is silent and is ' +
            'asserted. The absence is deliberate and measured — the sibling gate does carry ' +
            'that guard, and there a wider minute matches nothing at all and is reported by no ' +
            'rule. What a wider field must not do is reach the day-boundary carve-out on the ' +
            'strength of its first two digits, and the declared-bounds table pins that.',
        },
      },
      String.raw`set:\d#5`,
      'quant:?#1',
      'quant:{2}#5',
      String.raw`set:\d#6`,
      'quant:?#2',
      'quant:+#1',
      String.raw`set:\d#7`,
      'quant:?#3',
      'class:[Zz+-]#1',
      'quant:*#1',
      String.raw`class:[\d:]#1`,
    ],
  },
  {
    scope: '2:generalized-time',
    pattern: patternAt(2),
    bands: [
      { key: 'guard:(?<![0-9A-Za-z._-])#1', exempt: LOOKAROUND_EXEMPTION },
      'quant:{8}#1',
      String.raw`set:\d#1`,
      'quant:{2}#1',
      String.raw`set:\d#2`,
      'quant:{2}#2',
      String.raw`set:\d#3`,
      'quant:{2}#3',
      String.raw`set:\d#4`,
    ],
  },
  {
    scope: '3:clock',
    pattern: patternAt(3),
    bands: [
      { key: String.raw`guard:(?<![\d:])#1`, exempt: LOOKAROUND_EXEMPTION },
      String.raw`alt:([01]\d|2[0-3])#1`,
      'class:[01]#1',
      String.raw`set:\d#1`,
      'class:[0-3]#1',
      'class:[0-5]#1',
      String.raw`set:\d#2`,
      'class:[0-5]#2',
      String.raw`set:\d#3`,
      'quant:?#1',
      'quant:+#1',
      String.raw`set:\d#4`,
      { key: String.raw`guard:(?![\d:])#1`, exempt: LOOKAROUND_EXEMPTION },
    ],
  },
  {
    scope: '4:epoch-millis',
    pattern: patternAt(4),
    bands: [
      { key: 'guard:(?<![0-9A-Za-z._-])#1', exempt: LOOKAROUND_EXEMPTION },
      { key: String.raw`set:\d#1`, fill: fillText('1'), patternOnly: CLASSIFIER_ERA_WINDOW },
      'quant:{12}#1',
      'quant:?#1',
      String.raw`set:\d#2`,
      { key: 'guard:(?![0-9A-Za-z._-])#1', exempt: LOOKAROUND_EXEMPTION },
    ],
  },
  {
    scope: '5:epoch-seconds',
    pattern: patternAt(5),
    bands: [
      { key: 'guard:(?<![0-9A-Za-z._-])#1', exempt: LOOKAROUND_EXEMPTION },
      { key: String.raw`set:\d#1`, fill: fillText('1'), patternOnly: CLASSIFIER_ERA_WINDOW },
      'quant:{9}#1',
      'quant:?#1',
      String.raw`set:\d#2`,
      { key: 'guard:(?![0-9A-Za-z._-])#1', exempt: LOOKAROUND_EXEMPTION },
    ],
  },
  {
    scope: '6:host-path',
    pattern: patternAt(6),
    bands: [
      String.raw`alt:\/(?:home|Users|workspace|opt)\/(?:[\w.-]|[^\p{ASCII}\s])+|\/(?:private\/)?tmp\/(?:(?:[\w.-]|[^\p{ASCII}\s])+\/)*(?:[\w.-]|[^\p{ASCII}\s])+|\/(?:private\/)?var\/folders\/(?:[\w.-]|[^\p{ASCII}\s])+|[A-Za-z]:\\{1,2}(?:[\w.-]|[^\p{ASCII}\s])+#1`,
      'alt:(?:home|Users|workspace|opt)#1',
      'quant:+#1',
      String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#1`,
      String.raw`class:[\w.-]#1`,
      {
        key: String.raw`class:[^\p{ASCII}\s]#1`,
        fill: ELISION_FILL,
        exempt: ELIDED_SEGMENT_CLASS,
      },
      'quant:?#1',
      'quant:*#1',
      'quant:+#2',
      String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#2`,
      String.raw`class:[\w.-]#2`,
      {
        key: String.raw`class:[^\p{ASCII}\s]#2`,
        fill: ELISION_FILL,
        exempt: ELIDED_SEGMENT_CLASS,
      },
      'quant:+#3',
      String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#3`,
      String.raw`class:[\w.-]#3`,
      {
        key: String.raw`class:[^\p{ASCII}\s]#3`,
        fill: ELISION_FILL,
        exempt: ELIDED_SEGMENT_CLASS,
      },
      'quant:?#2',
      'quant:+#4',
      String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#4`,
      String.raw`class:[\w.-]#4`,
      {
        key: String.raw`class:[^\p{ASCII}\s]#4`,
        fill: ELISION_FILL,
        exempt: ELIDED_SEGMENT_CLASS,
      },
      'class:[A-Za-z]#1',
      'quant:{1,2}#1',
      'quant:+#5',
      String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#5`,
      String.raw`class:[\w.-]#5`,
      {
        key: String.raw`class:[^\p{ASCII}\s]#5`,
        fill: ELISION_FILL,
        exempt: ELIDED_SEGMENT_CLASS,
      },
    ],
  },
  {
    scope: '7:host-path',
    pattern: patternAt(7),
    bands: [
      { key: String.raw`guard:(?<!\/)#1`, exempt: LOOKAROUND_EXEMPTION },
      {
        key: String.raw`set:\p{L}#1`,
        fill: NAMED_HOME_LETTER_FILL,
        exempt: NAMED_HOME_LETTER_CLASS,
      },
      'quant:*#1',
      String.raw`alt:(?:[\w.-]|[^\p{ASCII}\s])#1`,
      String.raw`class:[\w.-]#1`,
      {
        key: String.raw`class:[^\p{ASCII}\s]#1`,
        fill: ELISION_FILL,
        exempt: ELIDED_SEGMENT_CLASS,
      },
    ],
  },
  literalSubject('8:toolchain-identity'),
  literalSubject('9:toolchain-identity'),
  literalSubject('10:toolchain-identity'),
  literalSubject('11:toolchain-identity'),
  literalSubject('12:toolchain-identity'),
  literalSubject('13:toolchain-identity'),
  literalSubject('14:toolchain-identity'),
  literalSubject('15:toolchain-identity'),
  literalSubject('16:toolchain-identity'),
  literalSubject('17:toolchain-identity'),
  literalSubject('18:toolchain-identity'),
  literalSubject('19:toolchain-identity'),
  literalSubject('20:toolchain-identity'),
  literalSubject('21:toolchain-identity'),
  literalSubject('22:toolchain-identity'),
  literalSubject('23:toolchain-identity'),
  literalSubject('24:toolchain-identity'),
];

const ALL_CASES = SUBJECTS.flatMap((subject) =>
  casesFor(subject).map(
    (item) => [`${item.scope} · ${item.key} · ${item.label} · ${item.edge}`, item] as const
  )
);

function ruleOf(scope: string): string {
  return scope.slice(scope.indexOf(':') + 1);
}

function patternOf(scope: string): RegExp {
  return patternAt(Number(scope.slice(0, scope.indexOf(':'))));
}

describe('the binary gate band inventory', () => {
  it('carries a subject for every value pass in the set', () => {
    expect(SUBJECTS.map((subject) => subject.scope)).toEqual(
      PASSES.map((pass, index) => `${String(index)}:${pass.rule}`)
    );
  });

  it.each(SUBJECTS)('$scope declares exactly the bands its pattern has', (subject) => {
    expect(screenSubject(subject)).toEqual({
      undeclared: [],
      stale: [],
      unexplained: [],
      misdeclared: [],
    });
  });

  it.each(SUBJECTS)('$scope leaks on the sample built from its own fills', (subject) => {
    expect(leaks(ruleOf(subject.scope), baselineSampleOf(subject))).toBe(true);
  });

  it('states how many bands it found, covered and declared exempt', () => {
    expect(summarizeAll(SUBJECTS)).toEqual({
      found: 101,
      covered: 85,
      exempt: 16,
      insideGuards: 8,
    });
    expect(ALL_CASES.length).toBe(346);
  });
});

describe('the recorded case set', () => {
  it.each(SUBJECTS)('$scope generates the case set recorded for it', (subject) => {
    expect(caseRows(subject)).toMatchSnapshot();
  });
});

describe('the generated endpoint cases', () => {
  it.each(ALL_CASES)('the binary gate reads %s as declared', (_title, item) => {
    const observed =
      item.oracle === 'full'
        ? leaks(ruleOf(item.scope), item.sample)
        : matches(patternOf(item.scope), item.sample);

    expect(observed).toBe(item.expect === 'match');
  });
});

/**
 * The bands a regular expression cannot see. Each edge is a literal, never a
 * value derived from the bound it pins — a fixture computed from the constant
 * moves with the constant and pins nothing.
 */
interface DeclaredBound {
  readonly rule: string;
  readonly bound: string;
  readonly inside: string;
  readonly outside: string;
}

/** Interpolated so no version-7 uuid is ever written whole into this file. */
function uuidWithVersion(version: string): string {
  return `11111111-1111-${version}111-8111-111111111111`;
}

/**
 * A day-boundary datetime, optionally continuing past where the pattern stops
 * reading. Held as pieces joined at use rather than as one literal: the lint
 * autofixer inlines a template-literal split, and this file is scanned by the
 * repository's own text gate with no exemption.
 */
function dayBoundary(...beyond: readonly string[]): string {
  return ['2026-01-02', 'T', '00', ':', '00', ':', '00', ...beyond].join('');
}

/** The same instant written without its seconds field, which the pattern makes optional. */
function dayBoundaryToMinute(...beyond: readonly string[]): string {
  return ['2026-01-02', 'T', '00', ':', '00', ...beyond].join('');
}

const DECLARED_BOUNDS: readonly DeclaredBound[] = [
  {
    rule: 'epoch-millis',
    bound: 'era floor',
    inside: '1000000000000',
    outside: '0999999999999',
  },
  {
    rule: 'epoch-millis',
    bound: 'era ceiling',
    inside: '2500000000000',
    outside: '2500000000001',
  },
  {
    rule: 'epoch-seconds',
    bound: 'era floor',
    inside: '1000000000',
    outside: '0999999999',
  },
  {
    rule: 'epoch-seconds',
    bound: 'era ceiling',
    inside: '2500000000',
    outside: '2500000001',
  },
  {
    rule: 'uuidv7',
    bound: 'the one version nibble this pass reads',
    inside: uuidWithVersion('7'),
    outside: uuidWithVersion('4'),
  },
  {
    rule: 'iso-datetime',
    bound: 'the day-boundary carve-out, refused where the value continues in digits',
    inside: dayBoundary('1'),
    outside: dayBoundary(),
  },
  {
    rule: 'iso-datetime',
    bound: 'that same refusal where it is the minute field that was written wider',
    inside: dayBoundaryToMinute('0'),
    outside: dayBoundaryToMinute(),
  },
];

describe('the bands that live in the classifier rather than in a pattern', () => {
  it.each(DECLARED_BOUNDS)('$rule leaks at its $bound', (row) => {
    expect(leaks(row.rule, row.inside)).toBe(true);
  });

  it.each(DECLARED_BOUNDS)('$rule is silent one step past its $bound', (row) => {
    expect(leaks(row.rule, row.outside)).toBe(false);
  });
});
