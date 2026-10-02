import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { judgeVerdict, main, parseNeeds, type Need, type Needs } from './deploy-verdict.js';
import { BORROWED_JOBS } from '../lib/publication/borrowed-jobs.js';

const RESULTS = ['success', 'failure', 'cancelled', 'skipped'] as const;
type Result = (typeof RESULTS)[number];

/**
 * The triggering events: the hand-pressed dispatch, the push every other mode
 * runs on, and an event the gate was never written for.
 */
const EVENTS = ['workflow_dispatch', 'push', 'pull_request'] as const;

/** The borrow output's spellings: the one borrow mode accepts, the empty skip, and a near miss. */
const BORROWED_OUTPUTS = ['true', '', 'TRUE'] as const;

const need = (result: Result, outputs: Readonly<Record<string, string>> = {}): Need => ({
  result,
  outputs,
});

const needsOf = (borrow: Need, results: readonly Result[]): Needs => ({
  borrow,
  ...Object.fromEntries(
    BORROWED_JOBS.map((name, index) => [name, need(results[index] ?? 'success')])
  ),
});

const without = (needs: Needs, dropped: string): Needs =>
  Object.fromEntries(Object.entries(needs).filter(([name]) => name !== dropped));

const allSuccess = (): Result[] => BORROWED_JOBS.map(() => 'success');
const allSkipped = (): Result[] => BORROWED_JOBS.map(() => 'skipped');
const borrowedBy = (result: Result, borrowed: string): Need => need(result, { borrowed });

/** Every assignment of a result to each borrowed job, as a sequence in job order. */
function* everyAssignment(depth: number): Generator<Result[]> {
  if (depth === 0) {
    yield [];
    return;
  }
  for (const head of RESULTS) {
    for (const tail of everyAssignment(depth - 1)) yield [head, ...tail];
  }
}

interface Case {
  readonly event: string;
  readonly borrowResult: Result;
  readonly borrowed: string;
  readonly results: readonly Result[];
}

/** Every event, borrow result, borrow output and assignment of results to the borrowed jobs. */
function* everyCase(): Generator<Case> {
  for (const event of EVENTS) {
    for (const borrowResult of RESULTS) {
      for (const borrowed of BORROWED_OUTPUTS) {
        for (const results of everyAssignment(BORROWED_JOBS.length)) {
          yield { event, borrowResult, borrowed, results };
        }
      }
    }
  }
}

/**
 * The rule the table checks against, stated without reference to how the gate
 * computes it: a failed or cancelled need always refuses, a dispatch passes
 * anything else, and outside dispatch and borrow mode anything short of
 * success refuses.
 */
function expected(
  event: string,
  borrowResult: Result,
  borrowed: string,
  results: readonly Result[]
): boolean {
  const every = [borrowResult, ...results];
  if (every.some((result) => result === 'failure' || result === 'cancelled')) return false;
  if (event === 'workflow_dispatch') return true;
  const borrowMode = borrowResult === 'success' && borrowed === 'true';
  return borrowMode || every.every((result) => result === 'success');
}

describe('judgeVerdict', () => {
  it('matches the fail-closed rule on every combination of events, results and borrow states', () => {
    const disagreements: string[] = [];
    for (const { event, borrowResult, borrowed, results } of everyCase()) {
      const needs = needsOf(borrowedBy(borrowResult, borrowed), results);
      if (judgeVerdict(needs, event).deploy !== expected(event, borrowResult, borrowed, results)) {
        disagreements.push(
          `${event}/${borrowResult}/${JSON.stringify(borrowed)}/${results.join(',')}`
        );
      }
    }

    expect(disagreements.slice(0, 10)).toEqual([]);
  });

  it('deploys a full run whose every check succeeded', () => {
    expect(judgeVerdict(needsOf(borrowedBy('success', 'false'), allSuccess()), 'push').deploy).toBe(
      true
    );
  });

  it('deploys a borrowed run whose checks were all skipped', () => {
    expect(judgeVerdict(needsOf(borrowedBy('success', 'true'), allSkipped()), 'push').deploy).toBe(
      true
    );
  });

  it('refuses a skipped check when the borrow output was never written', () => {
    expect(judgeVerdict(needsOf(need('success'), allSkipped()), 'push').deploy).toBe(false);
  });

  it('refuses a need it was not written to judge', () => {
    const needs = {
      ...needsOf(borrowedBy('success', 'false'), allSuccess()),
      extra: need('success'),
    };

    expect(judgeVerdict(needs, 'push')).toEqual({
      deploy: false,
      reason: expect.stringContaining('extra'),
    });
  });

  it('refuses when a borrowed job is missing from its needs', () => {
    const needs = without(needsOf(borrowedBy('success', 'false'), allSuccess()), 'e2e');

    expect(judgeVerdict(needs, 'push')).toEqual({
      deploy: false,
      reason: expect.stringContaining('e2e'),
    });
  });

  it('refuses when the borrow job is missing from its needs', () => {
    const needs = without(needsOf(borrowedBy('success', 'true'), allSkipped()), 'borrow');

    expect(judgeVerdict(needs, 'push')).toEqual({
      deploy: false,
      reason: expect.stringContaining('borrow'),
    });
  });

  it('names the need that stopped the deploy', () => {
    const results = allSuccess().map((result, index) =>
      BORROWED_JOBS[index] === 'mobile-test' ? 'failure' : result
    );

    expect(judgeVerdict(needsOf(borrowedBy('success', 'false'), results), 'push').reason).toContain(
      'mobile-test'
    );
  });
});

const DISPATCH = 'workflow_dispatch';

const withCheck = (name: string, result: Result): Result[] =>
  allSkipped().map((skipped, index) => (BORROWED_JOBS[index] === name ? result : skipped));

/** The bypass statement followed by exactly these jobs, in job order, ending the reason. */
const skippedList = (names: readonly string[]): RegExp =>
  new RegExp(String.raw`without the code-quality checks[^]*: ${names.join(', ')}\.$`);

describe('judgeVerdict on a dispatch run', () => {
  it('deploys when every check was skipped', () => {
    expect(judgeVerdict(needsOf(need('success'), allSkipped()), DISPATCH).deploy).toBe(true);
  });

  it('refuses a failed check', () => {
    expect(judgeVerdict(needsOf(need('success'), withCheck('lint', 'failure')), DISPATCH)).toEqual({
      deploy: false,
      reason: expect.stringContaining('lint'),
    });
  });

  it('refuses a cancelled check', () => {
    expect(
      judgeVerdict(needsOf(need('success'), withCheck('test', 'cancelled')), DISPATCH)
    ).toEqual({ deploy: false, reason: expect.stringContaining('test') });
  });

  it('refuses a cancelled borrow job', () => {
    expect(judgeVerdict(needsOf(need('cancelled'), allSkipped()), DISPATCH).deploy).toBe(false);
  });

  it('refuses when a check is missing from its needs', () => {
    const needs = without(needsOf(need('success'), allSkipped()), 'e2e');

    expect(judgeVerdict(needs, DISPATCH)).toEqual({
      deploy: false,
      reason: expect.stringContaining('e2e'),
    });
  });

  it('refuses a need it was not written to judge', () => {
    const needs = { ...needsOf(need('success'), allSkipped()), extra: need('skipped') };

    expect(judgeVerdict(needs, DISPATCH)).toEqual({
      deploy: false,
      reason: expect.stringContaining('extra'),
    });
  });

  it('states that the release ships without the code-quality checks', () => {
    expect(judgeVerdict(needsOf(need('success'), allSkipped()), DISPATCH).reason).toContain(
      'without the code-quality checks'
    );
  });

  it('names each skipped check', () => {
    const { reason } = judgeVerdict(needsOf(need('success'), allSkipped()), DISPATCH);

    expect(reason).toMatch(skippedList(BORROWED_JOBS));
  });

  it('leaves a check that ran out of the skipped list', () => {
    const { reason } = judgeVerdict(
      needsOf(need('success'), withCheck('mobile-test', 'success')),
      DISPATCH
    );

    expect(reason).toMatch(skippedList(BORROWED_JOBS.filter((name) => name !== 'mobile-test')));
  });

  it('reports a run whose every check succeeded as fully checked', () => {
    expect(judgeVerdict(needsOf(need('success'), allSuccess()), DISPATCH)).toEqual({
      deploy: true,
      reason: 'Every check succeeded here.',
    });
  });
});

describe('judgeVerdict on an event other than a dispatch', () => {
  it('refuses a skipped check when the borrow output was never written', () => {
    expect(judgeVerdict(needsOf(need('success'), allSkipped()), 'pull_request').deploy).toBe(false);
  });
});

const serialized = (needs: Needs): string => JSON.stringify(needs);

describe('parseNeeds', () => {
  it('reads the needs context GitHub serializes', () => {
    const needs = needsOf(borrowedBy('success', 'true'), allSkipped());

    expect(parseNeeds(serialized(needs))).toEqual(needs);
  });

  it('refuses an empty context', () => {
    expect(() => parseNeeds('')).toThrow(/NEEDS/);
  });

  it('refuses text that is not JSON', () => {
    expect(() => parseNeeds('{not json')).toThrow(/NEEDS/);
  });

  it('refuses a result outside the four GitHub reports', () => {
    const text = serialized(needsOf(borrowedBy('success', 'false'), allSuccess())).replace(
      '"result":"success"',
      '"result":"neutral"'
    );

    expect(() => parseNeeds(text)).toThrow(/NEEDS/);
  });

  it('refuses a need carrying no outputs', () => {
    expect(() => parseNeeds(JSON.stringify({ borrow: { result: 'success' } }))).toThrow(/NEEDS/);
  });
});

describe('main', () => {
  let printed: string[];

  beforeEach(() => {
    printed = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      printed.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exits 0 on a verdict that deploys', () => {
    const env = {
      NEEDS: serialized(needsOf(borrowedBy('success', 'true'), allSkipped())),
      GITHUB_EVENT_NAME: 'push',
    };

    expect(main(env)).toBe(0);
  });

  it('exits 1 on a verdict that refuses', () => {
    const env = {
      NEEDS: serialized(needsOf(borrowedBy('success', ''), allSkipped())),
      GITHUB_EVENT_NAME: 'push',
    };

    expect(main(env)).toBe(1);
  });

  it('exits 0 on a dispatch run whose checks were skipped', () => {
    const env = {
      NEEDS: serialized(needsOf(need('success'), allSkipped())),
      GITHUB_EVENT_NAME: DISPATCH,
    };

    expect(main(env)).toBe(0);
  });

  it('refuses to judge when the needs context was never handed over', () => {
    expect(() => main({ GITHUB_EVENT_NAME: 'push' })).toThrow(/NEEDS/);
  });

  it('refuses to judge when the triggering event was never set', () => {
    const env = { NEEDS: serialized(needsOf(need('success'), allSuccess())) };

    expect(() => main(env)).toThrow(/GITHUB_EVENT_NAME/);
  });

  it('refuses to judge when the triggering event is empty', () => {
    const env = {
      NEEDS: serialized(needsOf(need('success'), allSuccess())),
      GITHUB_EVENT_NAME: '',
    };

    expect(() => main(env)).toThrow(/GITHUB_EVENT_NAME/);
  });

  it('prints the reason for its verdict', () => {
    const env = {
      NEEDS: serialized(needsOf(borrowedBy('success', ''), allSkipped())),
      GITHUB_EVENT_NAME: 'push',
    };

    main(env);

    expect(printed.join('')).toContain('lint');
  });
});
