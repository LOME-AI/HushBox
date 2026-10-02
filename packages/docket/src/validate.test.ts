import { describe, expect, it } from 'vitest';
import { sanitizeFindingId, validateFinding } from './validate.ts';
import { HOUR_MS, MINUTE_MS } from './durations.ts';
import type { Finding, FindingIssueCode, FindingOption, ValidationMode } from './types.ts';

const BASE: Finding = {
  id: 'AI-1',
  title: 'A title',
  severity: 'critical',
  kind: 'defect',
  status: 'live',
  status_note: null,
  area: 'apps/api',
  needs_ruling: true,
  needs_options: false,
  warning: false,
  related: [],
  group: null,
  dedicated: false,
  state: 'open',
  ruling: null,
  denial: null,
  history: [],
  questions: [],
  progress: { status: 'not-started', updated: null, verified: false, notes: [] },
  body: '\nBody.\n',
  explainer: 'Body.',
  options: [],
};

function option(id: string, recommended = false): FindingOption {
  return { id, label: `Label ${id}`, recommended, dedicated: false, meta: null, body: 'Prose.' };
}

const RULING = { option: 'A', text: null, note: null, at: '2026-07-30' } as const;
const DENIAL = { by: 'human', reason: null, at: '2026-07-30' } as const;
const UNANSWERED = {
  at: '2026-07-30',
  text: 'Which slice owns it?',
  answer: null,
  answered_at: null,
} as const;

function codes(
  overrides: Partial<Finding>,
  mode: ValidationMode = 'structural'
): FindingIssueCode[] {
  return validateFinding({ ...BASE, ...overrides }, mode).map((issue) => issue.code);
}

/**
 * The one shape the day rule refuses, and what proves the rule fires at all —
 * so it stays an instant rather than being swept to a day with the rest of the
 * corpus. It is a day plus an offset because the repository's own privacy gate
 * refuses a written-out clock in tracked text.
 */
const INSTANT = new Date(Date.UTC(2026, 6, 30) + 14 * HOUR_MS + 12 * MINUTE_MS).toISOString();

describe('sanitizeFindingId', () => {
  it('keeps characters inside the allowed set', () => {
    expect(sanitizeFindingId('EN-3.v_1')).toBe('EN-3.v_1');
  });

  it('replaces disallowed characters and collapses the runs', () => {
    expect(sanitizeFindingId('EN-3 + EN-20')).toBe('EN-3-EN-20');
  });
});

describe('validateFinding, structural invariants', () => {
  it('accepts a finding that breaks none of them', () => {
    expect(codes({ options: [option('A'), option('B', true)] })).toEqual([]);
  });

  it('rejects a ruling on a finding that is not ruled', () => {
    expect(codes({ ruling: RULING })).toEqual(['ruling-without-ruled-state']);
  });

  it('rejects a ruled finding carrying no ruling', () => {
    expect(codes({ state: 'ruled' })).toEqual(['ruled-state-without-ruling']);
  });

  it('accepts a ruled finding carrying a ruling', () => {
    expect(codes({ state: 'ruled', ruling: RULING })).toEqual([]);
  });

  it('rejects a denial on a finding that is not denied', () => {
    expect(codes({ denial: DENIAL })).toEqual(['denial-without-denied-state']);
  });

  it('rejects a denied finding carrying no denial', () => {
    expect(codes({ state: 'denied' })).toEqual(['denied-state-without-denial']);
  });

  it('accepts a denied finding carrying a denial', () => {
    expect(codes({ state: 'denied', denial: DENIAL })).toEqual([]);
  });

  it('accepts an open finding carrying an unanswered question', () => {
    expect(codes({ state: 'open', questions: [UNANSWERED] })).toEqual([]);
  });

  it('accepts a ruled finding carrying an unanswered question', () => {
    expect(codes({ state: 'ruled', ruling: RULING, questions: [UNANSWERED] })).toEqual([]);
  });

  it('rejects a blocked finding that is not ruled', () => {
    expect(codes({ progress: { ...BASE.progress, status: 'blocked' } })).toEqual([
      'blocked-without-ruling',
    ]);
  });

  it('accepts a finding verified against no ruling', () => {
    expect(codes({ progress: { ...BASE.progress, verified: true } })).toEqual([]);
  });

  it('accepts work reported on a finding nobody ruled', () => {
    expect(codes({ progress: { ...BASE.progress, status: 'done' } })).toEqual([]);
  });

  it('rejects a blocked finding that is denied', () => {
    expect(
      codes({ state: 'denied', denial: DENIAL, progress: { ...BASE.progress, status: 'blocked' } })
    ).toEqual(['blocked-without-ruling']);
  });

  it('accepts progress on a ruled finding', () => {
    expect(
      codes({ state: 'ruled', ruling: RULING, progress: { ...BASE.progress, status: 'blocked' } })
    ).toEqual([]);
  });

  it('says in the message where a blocked finding is unblocked', () => {
    const [issue] = validateFinding(
      { ...BASE, progress: { ...BASE.progress, status: 'blocked' } },
      'structural'
    );
    expect(issue?.message).toContain('console');
  });

  it('rejects duplicate option ids', () => {
    expect(codes({ options: [option('A'), option('A')] })).toEqual(['duplicate-option-id']);
  });

  it('rejects an option id holding a character outside the allowed set', () => {
    expect(codes({ options: [option('A B')] })).toEqual(['invalid-option-id']);
  });

  it('rejects an empty option id', () => {
    expect(codes({ options: [option('')] })).toEqual(['invalid-option-id']);
  });

  it('rejects an id that is not already in sanitized form', () => {
    expect(codes({ id: 'EN-3 + EN-20' })).toEqual(['unsanitized-id']);
  });

  it('reports every broken invariant rather than stopping at the first', () => {
    expect(codes({ ruling: RULING, denial: DENIAL })).toEqual([
      'ruling-without-ruled-state',
      'denial-without-denied-state',
    ]);
  });

  it('checks no emission rule', () => {
    expect(codes({ needs_ruling: false, options: [] })).toEqual([]);
  });
});

describe('validateFinding, emission rules, denied at emission', () => {
  const DENIED_AT_EMISSION: Partial<Finding> = {
    state: 'denied',
    denial: { by: 'audit', reason: 'Refuted.', at: '2026-07-30' },
    needs_options: true,
    options: [],
  };

  it('accepts one that records no ruling was needed', () => {
    expect(codes({ ...DENIED_AT_EMISSION, needs_ruling: false }, 'emission')).toEqual([]);
  });

  it('accepts one that records a ruling was needed', () => {
    expect(codes({ ...DENIED_AT_EMISSION, needs_ruling: true }, 'emission')).toEqual([]);
  });

  it('rejects one carrying options, since the audit never analysed it for them', () => {
    expect(
      codes({ ...DENIED_AT_EMISSION, needs_ruling: false, options: [option('A')] }, 'emission')
    ).toEqual(['emission-option-count']);
  });

  it('rejects one that does not ask for options, since resurrecting it mints them', () => {
    expect(codes({ ...DENIED_AT_EMISSION, needs_options: false }, 'emission')).toEqual([
      'emission-needs-options',
    ]);
  });

  it('leaves the finding to the later rules when no denial is actually present', () => {
    expect(
      codes(
        { state: 'denied', denial: null, needs_ruling: false, options: [option('A')] },
        'emission'
      )
    ).toEqual(['emission-state']);
  });
});

describe('validateFinding, emission rules', () => {
  it('accepts a needs-ruling finding shipping two options with one recommendation', () => {
    expect(codes({ options: [option('A', true), option('B')] }, 'emission')).toEqual([]);
  });

  it('accepts a needs-ruling finding shipping no options and asking for them', () => {
    expect(codes({ needs_options: true, options: [] }, 'emission')).toEqual([]);
  });

  it('accepts a needs-ruling finding shipping exactly one option', () => {
    expect(codes({ options: [option('A')] }, 'emission')).toEqual([]);
  });

  it('rejects a needs-ruling finding shipping no options without asking for them', () => {
    expect(codes({ options: [] }, 'emission')).toEqual(['emission-needs-options']);
  });

  it('rejects a needs-ruling finding recommending two options', () => {
    expect(codes({ options: [option('A', true), option('B', true)] }, 'emission')).toEqual([
      'emission-recommended-count',
    ]);
  });

  it('accepts a no-ruling-needed finding shipping one option and a ruling', () => {
    expect(
      codes(
        { needs_ruling: false, state: 'ruled', ruling: RULING, options: [option('A')] },
        'emission'
      )
    ).toEqual([]);
  });

  it('rejects a no-ruling-needed finding shipping two options', () => {
    expect(
      codes(
        {
          needs_ruling: false,
          state: 'ruled',
          ruling: RULING,
          options: [option('A'), option('B')],
        },
        'emission'
      )
    ).toEqual(['emission-option-count']);
  });

  it('rejects a no-ruling-needed finding that does not ship ruled', () => {
    expect(codes({ needs_ruling: false, options: [option('A')] }, 'emission')).toEqual([
      'emission-state',
    ]);
  });

  it('checks no structural invariant', () => {
    expect(
      codes({ ruling: RULING, options: [option('A', true), option('B')] }, 'emission')
    ).toEqual([]);
  });
});

describe('validateFinding, day-resolution timestamps', () => {
  const RULING_SUPERSEDED = {
    at: '2026-07-28',
    kind: 'ruling',
    superseded_at: '2026-07-29',
    option: 'A',
    text: null,
    note: null,
  } as const;
  const DENIAL_SUPERSEDED = {
    at: '2026-07-28',
    kind: 'denial',
    superseded_at: '2026-07-29',
    reason: null,
    by: 'human',
  } as const;
  const ANSWERED = {
    at: '2026-07-29',
    text: 'Which slice owns it?',
    answer: 'The chat slice.',
    answered_at: '2026-07-30',
  } as const;
  const NOTE = { at: '2026-07-30', by: 'agent', text: 'Rewired the reader.' } as const;
  const PROGRESS = {
    status: 'in-progress',
    updated: '2026-07-30',
    verified: false,
    notes: [NOTE],
  } as const;

  it('accepts a finding whose every timestamp is a day', () => {
    expect(
      codes({
        state: 'ruled',
        ruling: RULING,
        history: [RULING_SUPERSEDED, DENIAL_SUPERSEDED],
        questions: [ANSWERED, UNANSWERED],
        progress: PROGRESS,
      })
    ).toEqual([]);
  });

  it('rejects a ruling stamped with an instant', () => {
    expect(codes({ state: 'ruled', ruling: { ...RULING, at: INSTANT } })).toEqual([
      'non-day-timestamp',
    ]);
  });

  it('rejects a denial stamped with an instant', () => {
    expect(codes({ state: 'denied', denial: { ...DENIAL, at: INSTANT } })).toEqual([
      'non-day-timestamp',
    ]);
  });

  it('rejects a superseded ruling stamped with an instant', () => {
    expect(codes({ history: [{ ...RULING_SUPERSEDED, at: INSTANT }] })).toEqual([
      'non-day-timestamp',
    ]);
  });

  it('rejects a superseded ruling replaced at an instant', () => {
    expect(codes({ history: [{ ...RULING_SUPERSEDED, superseded_at: INSTANT }] })).toEqual([
      'non-day-timestamp',
    ]);
  });

  it('rejects a cleared denial stamped with an instant', () => {
    expect(codes({ history: [{ ...DENIAL_SUPERSEDED, at: INSTANT }] })).toEqual([
      'non-day-timestamp',
    ]);
  });

  it('rejects a cleared denial replaced at an instant', () => {
    expect(codes({ history: [{ ...DENIAL_SUPERSEDED, superseded_at: INSTANT }] })).toEqual([
      'non-day-timestamp',
    ]);
  });

  it('rejects a question asked at an instant', () => {
    expect(codes({ questions: [{ ...UNANSWERED, at: INSTANT }] })).toEqual(['non-day-timestamp']);
  });

  it('rejects a question answered at an instant', () => {
    expect(codes({ questions: [{ ...ANSWERED, answered_at: INSTANT }] })).toEqual([
      'non-day-timestamp',
    ]);
  });

  it('accepts a question nobody has answered yet', () => {
    expect(codes({ questions: [UNANSWERED] })).toEqual([]);
  });

  it('rejects a progress note written at an instant', () => {
    expect(codes({ progress: { ...PROGRESS, notes: [{ ...NOTE, at: INSTANT }] } })).toEqual([
      'non-day-timestamp',
    ]);
  });

  it('rejects progress updated at an instant', () => {
    expect(codes({ progress: { ...PROGRESS, updated: INSTANT } })).toEqual(['non-day-timestamp']);
  });

  it('accepts progress nobody has updated', () => {
    expect(codes({ progress: { ...PROGRESS, updated: null } })).toEqual([]);
  });

  it('accepts a progress note quoting an instant in its own prose', () => {
    expect(
      codes({
        progress: { ...PROGRESS, notes: [{ ...NOTE, text: `Ruled at ${INSTANT}.` }] },
      })
    ).toEqual([]);
  });

  it('names the field the instant sits on', () => {
    const [issue] = validateFinding(
      { ...BASE, progress: { ...PROGRESS, notes: [{ ...NOTE, at: INSTANT }] } },
      'structural'
    );
    expect(issue?.field).toBe('progress.notes[0].at');
  });

  it('reports every instant rather than stopping at the first', () => {
    expect(
      codes({
        state: 'ruled',
        ruling: { ...RULING, at: INSTANT },
        progress: { ...PROGRESS, updated: INSTANT },
      })
    ).toEqual(['non-day-timestamp', 'non-day-timestamp']);
  });

  it('checks no emission rule', () => {
    expect(
      codes(
        { needs_ruling: true, options: [option('A')], progress: { ...PROGRESS, updated: INSTANT } },
        'emission'
      )
    ).toEqual([]);
  });
});
