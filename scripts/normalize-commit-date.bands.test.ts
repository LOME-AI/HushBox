import { describe, expect, it } from 'vitest';

import { STAMP_LINE } from './normalize-commit-date.js';
import {
  baselineSampleOf,
  caseRows,
  casesFor,
  screenSubject,
  summarize,
} from './lib/privacy/band-cases.js';
import type { BandSubject } from './lib/privacy/band-cases.js';

/**
 * Every band in the normalizer's stamp parser, asserted by a case derived from
 * the pattern. The reasoning behind the two mechanisms — derivation for bands
 * that are new, a recorded case set for bands that moved — is written out once
 * in the text gate's band file and is not repeated here.
 *
 * This consumer has no classifier behind its pattern: the stamp is split by
 * position afterwards precisely because the pattern already guarantees the
 * shape, so the pattern is the whole verdict and both oracles coincide. What
 * lives in code here is a different kind of bound — the recognized-header set
 * and the conforming-stamp predicate — and those are declared at the foot of
 * this file.
 *
 * To re-record after a deliberate band change: run this file with vitest's `-u`
 * flag after the path (`pnpm test:watch <path> -u`) and read the snapshot diff —
 * each moved row names the band that moved.
 */

const STAMP: BandSubject = {
  scope: 'stamp-line',
  pattern: STAMP_LINE,
  bands: [
    'alt:(?:author|committer)#1',
    'quant:*#1',
    'set:.#1',
    'quant:*#2',
    'set:.#2',
    'quant:?#1',
    'quant:+#1',
    String.raw`set:\d#1`,
    'class:[+-]#1',
    'quant:{4}#1',
    String.raw`set:\d#2`,
  ],
};

const ALL_CASES = casesFor(STAMP).map(
  (item) => [`${item.key} · ${item.label} · ${item.edge}`, item] as const
);

describe('the stamp parser band inventory', () => {
  it('declares exactly the bands its pattern has', () => {
    expect(screenSubject(STAMP)).toEqual({
      undeclared: [],
      stale: [],
      unexplained: [],
      misdeclared: [],
    });
  });

  it('matches the sample built from its own fills', () => {
    expect(STAMP_LINE.test(baselineSampleOf(STAMP))).toBe(true);
  });

  it('states how many bands it found, covered and declared exempt', () => {
    expect(summarize(STAMP)).toEqual({ found: 11, covered: 11, exempt: 0, insideGuards: 0 });
    expect(ALL_CASES.length).toBe(24);
  });

  it('generates the case set recorded for it', () => {
    expect(caseRows(STAMP)).toMatchSnapshot();
  });
});

describe('the generated endpoint cases', () => {
  it.each(ALL_CASES)('the stamp parser reads %s as declared', (_title, item) => {
    expect(STAMP_LINE.test(item.sample)).toBe(item.expect === 'match');
  });
});

/*
 * The bands this rebuild enforces in code, where there is no pattern to walk.
 * They are declarations and nothing more — deliberately not assertions.
 *
 * Reaching either one from here needs a second export from the module under
 * test, and the assertion it would carry could only check that a reason string
 * is longer than some number — it could not fail for its own subject. An
 * unfalsifiable assertion is worse than an honest note, so this is the note.
 *
 * Neither band is unguarded. Which test pins each one was measured by moving
 * the bound one step in each direction and recording what died, not read off
 * the code:
 *
 * - The **recognized-header set** decides what the rebuild carries. Moving any
 *   member — one character shorter or longer — is caught by the tests that
 *   normalize a commit carrying that header, because the real header then
 *   falls outside the set and the whole rewrite refuses. What holds a member is
 *   therefore the fixtures that carry it: `tree`, `author` and `committer` are
 *   held by every normalizing test, and `encoding` — which most commits do not
 *   carry at all — is held by the fewest. The refusal test for an unrecognized
 *   header pins that the guard exists and pins no member, since a moved member
 *   leaves an already-outside header outside.
 *
 * - The **conforming-stamp predicate** is two bounds in one expression, a
 *   whole-day epoch and a UTC-rendered offset, and each half is pinned by its
 *   own fixture: the offset half by the commit whose epoch already sits on a
 *   day boundary but is rendered at a non-UTC offset, the epoch half by the
 *   UTC-rendered stamp minutes past the boundary. Moving the day multiple
 *   itself is caught by the already-conforming commit. Loosening either
 *   equality to accept everything sorting below it changes nothing git can
 *   store: `+0000` is the lowest offset git renders, and git's own object
 *   check refuses a negative epoch in a stamp line.
 */
