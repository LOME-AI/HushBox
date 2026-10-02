import { describe, it, expect } from 'vitest';
import { makeFinding } from '@/test-utils/finding-fixture';
import {
  decisionResetsProgress,
  describeProgressWork,
  hasProgressWork,
  isBlocked,
  isDecided,
} from './decided-work';
import type { FindingJson, ProgressNote, ProgressStatus } from '@hushbox/docket';

function note(text: string): ProgressNote {
  return { at: '2026-07-30', by: 'agent', text };
}

function withStatus(status: ProgressStatus): { progress: FindingJson['progress'] } {
  return { progress: { status, updated: null, verified: false, notes: [] } };
}

describe('isDecided', () => {
  it('is false for a finding nobody has decided', () => {
    expect(isDecided(makeFinding({ id: 'A-1' }))).toBe(false);
  });

  it('is true for a ruled finding', () => {
    const finding = makeFinding({
      id: 'A-1',
      state: 'ruled',
      ruling: { option: 'A', text: null, note: null, at: '2026-07-30' },
    });

    expect(isDecided(finding)).toBe(true);
  });

  it('is true for a denied finding', () => {
    const finding = makeFinding({
      id: 'A-1',
      state: 'denied',
      denial: { reason: 'not worth it', by: 'human', at: '2026-07-30' },
    });

    expect(isDecided(finding)).toBe(true);
  });
});

describe('isBlocked', () => {
  it('is true for a ruled finding an agent stopped on', () => {
    expect(isBlocked(makeFinding({ id: 'A-1', state: 'ruled', ...withStatus('blocked') }))).toBe(
      true
    );
  });

  it('is false for a ruled finding still moving', () => {
    expect(
      isBlocked(makeFinding({ id: 'A-1', state: 'ruled', ...withStatus('in-progress') }))
    ).toBe(false);
  });

  it('is false for an undecided finding, which carries no work to stop', () => {
    expect(isBlocked(makeFinding({ id: 'A-1', state: 'open', ...withStatus('blocked') }))).toBe(
      false
    );
  });
});

describe('hasProgressWork', () => {
  it('is false for a finding nobody has touched', () => {
    expect(hasProgressWork(makeFinding({ id: 'A-1' }))).toBe(false);
  });

  it('is true once a note is recorded', () => {
    const finding = makeFinding({
      id: 'A-1',
      progress: { status: 'not-started', updated: null, verified: false, notes: [note('one')] },
    });

    expect(hasProgressWork(finding)).toBe(true);
  });

  it('is true once the work has been verified', () => {
    const finding = makeFinding({
      id: 'A-1',
      progress: { status: 'not-started', updated: null, verified: true, notes: [] },
    });

    expect(hasProgressWork(finding)).toBe(true);
  });

  it('is true once the work has started, even with nothing written down', () => {
    const finding = makeFinding({
      id: 'A-1',
      progress: { status: 'in-progress', updated: null, verified: false, notes: [] },
    });

    expect(hasProgressWork(finding)).toBe(true);
  });
});

describe('decisionResetsProgress', () => {
  it('is false for a finding nobody has touched', () => {
    expect(decisionResetsProgress(makeFinding({ id: 'A-1' }))).toBe(false);
  });

  it('is false for notes alone, which a decision keeps', () => {
    const finding = makeFinding({
      id: 'A-1',
      progress: { status: 'not-started', updated: null, verified: false, notes: [note('one')] },
    });

    expect(decisionResetsProgress(finding)).toBe(false);
  });

  it('is true once the work has been verified', () => {
    const finding = makeFinding({
      id: 'A-1',
      progress: { status: 'not-started', updated: null, verified: true, notes: [] },
    });

    expect(decisionResetsProgress(finding)).toBe(true);
  });

  it('is true once the status has moved off its default', () => {
    const finding = makeFinding({
      id: 'A-1',
      progress: { status: 'in-progress', updated: null, verified: false, notes: [] },
    });

    expect(decisionResetsProgress(finding)).toBe(true);
  });
});

describe('describeProgressWork', () => {
  function progress(
    status: 'not-started' | 'in-progress' | 'done',
    verified: boolean,
    notes: readonly ProgressNote[]
  ): ReturnType<typeof makeFinding> {
    return makeFinding({
      id: 'A-1',
      progress: { status, updated: null, verified, notes },
    });
  }

  it('names the note count when notes are all there is', () => {
    expect(describeProgressWork(progress('not-started', false, [note('one'), note('two')]))).toBe(
      '2 progress notes are recorded against it.'
    );
  });

  it('names a single note without pluralising it', () => {
    expect(describeProgressWork(progress('not-started', false, [note('one')]))).toBe(
      '1 progress note is recorded against it.'
    );
  });

  it('says what the work is when the status is all there is, rather than naming zero notes', () => {
    expect(describeProgressWork(progress('in-progress', false, []))).toBe(
      'It is marked In progress, with no progress notes.'
    );
  });

  it('says the work was verified when that is all there is', () => {
    expect(describeProgressWork(progress('not-started', true, []))).toBe(
      'It is verified, with no progress notes.'
    );
  });

  it('names the status and the notes together', () => {
    expect(describeProgressWork(progress('in-progress', false, [note('one')]))).toBe(
      'It is marked In progress, with 1 progress note.'
    );
  });

  it('names every kind of work at once', () => {
    expect(describeProgressWork(progress('done', true, [note('one'), note('two')]))).toBe(
      'It is marked Done and verified, with 2 progress notes.'
    );
  });
});
