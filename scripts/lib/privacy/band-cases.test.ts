import { describe, expect, it } from 'vitest';

import {
  bandsOf,
  baselineSampleOf,
  caseRows,
  casesFor,
  fillBranch,
  fillReps,
  fillText,
  screenSubject,
  summarize,
  summarizeAll,
} from './band-cases.js';

describe('band discovery', () => {
  it('finds a character-class range and keys it by its own source text', () => {
    const bands = bandsOf({ scope: 'minute-tens', pattern: /[0-5]/gu, bands: [] });

    expect(bands.map((band) => band.key)).toEqual(['class:[0-5]#1']);
  });

  it('gives a class range a variant at each end and one step outside each end', () => {
    const [band] = bandsOf({ scope: 'minute-tens', pattern: /[0-5]/gu, bands: [] });

    expect(band?.variants).toEqual([
      {
        label: 'range 0-5 low',
        selection: fillText('0'),
        outside: fillText('/'),
        direction: 'below',
      },
      {
        label: 'range 0-5 high',
        selection: fillText('5'),
        outside: fillText('6'),
        direction: 'above',
      },
    ]);
  });
});

/**
 * A pattern with no meaning, deliberately. The generator does not read its
 * subjects, and a clock-shaped fixture here would be a real disclosing value in a
 * file this repository's own gate scans with no exemption.
 */
const SHAPE = { scope: 'shape', pattern: /([ab]x|c[d-f])-([p-t]y)/u, bands: [] };

describe('case generation', () => {
  it('puts the band under test at its endpoint and every other band at its fill', () => {
    const generated = casesFor(SHAPE).find(
      (item) => item.key === 'class:[d-f]#1' && item.label === 'range d-f high'
    );

    expect(generated?.sample).toBe('cf-ry');
  });

  it('emits an outside case one step past the endpoint, expecting silence', () => {
    const generated = casesFor(SHAPE).filter((item) => item.key === 'class:[d-f]#1');

    expect(generated.map((item) => [item.label, item.edge, item.sample, item.expect])).toEqual([
      ['range d-f low', 'endpoint', 'cd-ry', 'match'],
      ['range d-f low', 'outside', 'cc-ry', 'silent'],
      ['range d-f high', 'endpoint', 'cf-ry', 'match'],
      ['range d-f high', 'outside', 'cg-ry', 'silent'],
    ]);
  });

  it('walks into the alternation branch that holds the band under test', () => {
    const generated = casesFor(SHAPE).find(
      (item) => item.key === 'class:[ab]#1' && item.label === 'member b'
    );

    expect(generated?.sample).toBe('bx-ry');
  });

  it('renders every band at its fill when nothing is under test', () => {
    expect(baselineSampleOf(SHAPE)).toBe('ax-ry');
  });
});

const DECLARED_SHAPE_BANDS = [
  'alt:([ab]x|c[d-f])#1',
  'class:[ab]#1',
  'class:[d-f]#1',
  'class:[p-t]#1',
];

describe('the completeness screen', () => {
  it('passes when the declaration and the pattern agree', () => {
    const screen = screenSubject({ ...SHAPE, bands: DECLARED_SHAPE_BANDS });

    expect(screen).toEqual({ undeclared: [], stale: [], unexplained: [], misdeclared: [] });
  });

  it('reports a band the pattern has and the declaration does not', () => {
    const screen = screenSubject({ ...SHAPE, bands: DECLARED_SHAPE_BANDS.slice(1) });

    expect(screen.undeclared).toEqual(['alt:([ab]x|c[d-f])#1']);
  });

  it('reports a declaration the pattern no longer has', () => {
    const screen = screenSubject({ ...SHAPE, bands: [...DECLARED_SHAPE_BANDS, 'class:[0-9]#9'] });

    expect(screen.stale).toEqual(['class:[0-9]#9']);
  });

  it('reports a band that yields no case and claims no exemption', () => {
    const subject = { scope: 'negated', pattern: /[^0-5]/u, bands: ['class:[^0-5]#1'] };

    expect(screenSubject(subject).unexplained).toEqual(['class:[^0-5]#1']);
  });

  it.each([
    ['a negated escape set', /\D[a-c]/u, String.raw`set:\D#1`],
    ['a unicode property escape', /\p{Lu}[a-c]/u, String.raw`set:\p{Lu}#1`],
    ['a negated class', /[^0-5][a-c]/u, 'class:[^0-5]#1'],
  ])('reports %s as a band with no endpoint to sit on', (_name, pattern, key) => {
    const subject = { scope: 'no-endpoint', pattern, bands: [key, 'class:[a-c]#1'] };

    expect(screenSubject(subject).unexplained).toEqual([key]);
  });

  it('renders a band with no derivable member as nothing at all', () => {
    const subject = { scope: 'no-endpoint', pattern: /[^0-5][a-c]/u, bands: [] };

    expect(baselineSampleOf(subject)).toBe('b');
  });

  it('offers no low outside for a range that starts at the first code point', () => {
    const pattern = new RegExp(String.raw`[\u{0}-\u{5}]`, 'u');
    const [band] = bandsOf({ scope: 'floor', pattern, bands: [] });

    expect(band?.variants.map((variant) => variant.outside === undefined)).toEqual([true, false]);
  });

  it('accepts that same band once its exemption states a reason', () => {
    const subject = {
      scope: 'negated',
      pattern: /[^0-5]/u,
      bands: [{ key: 'class:[^0-5]#1', exempt: 'a negated class has no endpoint to sit on' }],
    };

    expect(screenSubject(subject).unexplained).toEqual([]);
  });

  it('reports a fill aimed at a band the pattern does not have', () => {
    const screen = screenSubject({
      ...SHAPE,
      bands: [...DECLARED_SHAPE_BANDS, { key: 'class:[0-9]#9', fill: fillText('4') }],
    });

    expect(screen.misdeclared).toEqual(['class:[0-9]#9']);
  });

  it('adds those counts up across several subjects', () => {
    const subject = { ...SHAPE, bands: DECLARED_SHAPE_BANDS };

    expect(summarizeAll([subject, subject])).toEqual({
      found: 8,
      covered: 8,
      exempt: 0,
      insideGuards: 0,
    });
  });

  it('counts nothing over no subjects at all', () => {
    expect(summarizeAll([])).toEqual({ found: 0, covered: 0, exempt: 0, insideGuards: 0 });
  });

  it('counts the choice points that live inside a guard and are in no inventory', () => {
    const subject = { scope: 'guarded', pattern: /(?<![0-5a-f])x/u, bands: [] };

    expect(summarize(subject)).toEqual({ found: 1, covered: 1, exempt: 0, insideGuards: 1 });
  });

  it('counts what it found, covered and declared exempt', () => {
    expect(summarize({ ...SHAPE, bands: DECLARED_SHAPE_BANDS })).toEqual({
      found: 4,
      covered: 4,
      exempt: 0,
      insideGuards: 0,
    });
  });
});

describe('declared semantics', () => {
  const declaredFill = {
    ...SHAPE,
    bands: DECLARED_SHAPE_BANDS.map((key) =>
      key === 'class:[p-t]#1' ? { key, fill: fillText('t') } : key
    ),
  };

  it('uses a declared fill in place of the middle of the band', () => {
    expect(baselineSampleOf(declaredFill)).toBe('ax-ty');
  });

  it('wraps every sample in the context the rule needs to be read at all', () => {
    const withContext = { ...SHAPE, bands: DECLARED_SHAPE_BANDS, context: (s: string) => `[${s}]` };

    expect(baselineSampleOf(withContext)).toBe('[ax-ry]');
    expect(casesFor(withContext).every((item) => item.sample.startsWith('['))).toBe(true);
  });

  it('generates no case for a band declared exempt', () => {
    const subject = {
      ...SHAPE,
      bands: DECLARED_SHAPE_BANDS.map((key) =>
        key === 'class:[d-f]#1' ? { key, exempt: 'declared for the test' } : key
      ),
    };

    expect(casesFor(subject).some((item) => item.key === 'class:[d-f]#1')).toBe(false);
    expect(summarize(subject)).toEqual({ found: 4, covered: 3, exempt: 1, insideGuards: 0 });
  });

  it('generates no outside case inside a group the pattern can do without', () => {
    const subject = { scope: 'optional', pattern: /a(?::([0-5]\d))?/u, bands: [] };
    const edges = new Set(casesFor(subject).map((item) => item.edge));

    expect([...edges]).toEqual(['endpoint']);
  });

  it('still generates outside cases for a band the pattern cannot do without', () => {
    const subject = { scope: 'required', pattern: /a:([0-5]\d)/u, bands: [] };

    expect(casesFor(subject).some((item) => item.edge === 'outside')).toBe(true);
  });

  it('drops the outside cases of a band declared to have no silent outside', () => {
    const subject = {
      scope: 'required',
      pattern: /a:([0-5]\d)/u,
      bands: [
        {
          key: 'class:[0-5]#1',
          outsideExempt: { above: 'declared for the test', below: 'declared for the test' },
        },
      ],
    };
    const kept = casesFor(subject).filter((item) => item.key === 'class:[0-5]#1');

    expect(kept.every((item) => item.edge === 'endpoint')).toBe(true);
    expect(kept.length).toBe(2);
  });

  it.each([
    ['above', 'below'],
    ['below', 'above'],
  ])('drops only the %s outside case when only that direction is absorbed', (dropped, kept) => {
    const subject = {
      scope: 'required',
      pattern: /a:([0-5]\d)/u,
      bands: [{ key: 'class:[0-5]#1', outsideExempt: { [dropped]: 'declared for the test' } }],
    };
    const outside = casesFor(subject).filter(
      (item) => item.key === 'class:[0-5]#1' && item.edge === 'outside'
    );

    expect(outside.map((item) => item.direction)).toEqual([kept]);
  });

  it('refuses a class element it cannot read rather than reporting no band there', () => {
    const pattern = new RegExp(String.raw`[\q{ab}]`, 'v');

    expect(() => bandsOf({ scope: 'disjunction', pattern, bands: [] })).toThrow(
      /unsupported class element/u
    );
  });

  it('refuses a pattern construct it cannot walk rather than reporting no band there', () => {
    expect(() => bandsOf({ scope: 'backreference', pattern: /(a)\1/u, bands: [] })).toThrow(
      /unsupported pattern construct/u
    );
  });

  it('refuses a branch fill that names a branch the alternation does not have', () => {
    const subject = {
      ...SHAPE,
      bands: DECLARED_SHAPE_BANDS.map((key) =>
        key === 'alt:([ab]x|c[d-f])#1' ? { key, fill: fillBranch(9) } : key
      ),
    };

    expect(() => baselineSampleOf(subject)).toThrow(/branch fill out of range/u);
  });

  it('refuses a repetition fill on a band that has no repetition', () => {
    const subject = {
      ...SHAPE,
      bands: DECLARED_SHAPE_BANDS.map((key) =>
        key === 'class:[p-t]#1' ? { key, fill: fillReps(2) } : key
      ),
    };

    expect(() => baselineSampleOf(subject)).toThrow(/repetition fill on a construct/u);
  });

  it('records each case as a row naming the band and digesting the sample', () => {
    const rows = caseRows({ scope: 'required', pattern: /a:([0-5]\d)/u, bands: [] });

    expect(rows[0]).toMatch(
      /^class:\[0-5\]#1 \| range 0-5 low \| endpoint \| match \| full \| [0-9a-f]{16}$/u
    );
    expect(rows.some((row) => row.includes(':'))).toBe(true);
  });

  it('moves the recorded digest when a band is narrowed by one step', () => {
    const wide = caseRows({ scope: 'shape', pattern: /([ab]x|c[d-f])-([p-t]y)/u, bands: [] });
    const narrowed = caseRows({ scope: 'shape', pattern: /([ab]x|c[d-e])-([p-t]y)/u, bands: [] });

    expect(narrowed).not.toEqual(wide);
  });

  it('marks a band the whole gate cannot see as asserted against the pattern alone', () => {
    const subject = {
      ...SHAPE,
      bands: DECLARED_SHAPE_BANDS.map((key) =>
        key === 'class:[d-f]#1' ? { key, patternOnly: 'declared for the test' } : key
      ),
    };
    const oracles = new Set(
      casesFor(subject)
        .filter((item) => item.key === 'class:[d-f]#1')
        .map((item) => item.oracle)
    );

    expect([...oracles]).toEqual(['pattern']);
    expect(casesFor(subject).every((item) => item.oracle === 'pattern')).toBe(false);
  });
});
