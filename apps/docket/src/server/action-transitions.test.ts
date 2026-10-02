import { describe, it, expect } from 'vitest';
import { parseFinding } from '@hushbox/docket';
import { findingFile, type FindingOverrides } from '../test-utils/audit-fixture';
import { ACTION_TRANSITIONS, buildTransition } from './action-transitions';
import type { Finding, Transition, Write } from '@hushbox/docket';

const AT = '2026-07-31';

function fixture(overrides: FindingOverrides = {}, extra: Partial<Finding> = {}): Finding {
  const parsed = parseFinding(findingFile('AC-1', overrides), 'findings/AC-1.md');
  if (!parsed.ok) throw new Error('the fixture finding did not parse');
  return { ...parsed.value, ...extra };
}

function blocked(): Finding {
  return fixture(
    { state: 'ruled' },
    {
      progress: {
        status: 'blocked',
        updated: AT,
        verified: false,
        notes: [{ at: AT, by: 'agent', text: 'the schema change has not landed' }],
      },
    }
  );
}

/** The write a transition would make, or a failure the caller has to read. */
function written(transition: Transition, finding: Finding = fixture()): Write {
  const outcome = transition(finding);
  if (!outcome.ok) throw new Error(`the transition was refused as ${outcome.error.code}`);
  return outcome.value;
}

describe('rule', () => {
  it('rules the finding as the human', () => {
    const write = written(ACTION_TRANSITIONS.rule({ option: 'A' }, AT));

    expect(write.writer).toBe('human');
    expect(write.patch).toMatchObject({
      state: 'ruled',
      ruling: { option: 'A', text: null, note: null, at: AT },
    });
  });

  it('carries the text and the note the ruling was given', () => {
    const write = written(
      ACTION_TRANSITIONS.rule({ option: 'A', text: 'Do it', note: 'Because' }, AT)
    );

    expect(write.patch.ruling).toMatchObject({ text: 'Do it', note: 'Because' });
  });

  it('names the mark in the same patch when the ruling decided one', () => {
    const write = written(ACTION_TRANSITIONS.rule({ option: 'A', dedicated: true }, AT));

    expect(write.patch.dedicated).toBe(true);
  });

  it('names no mark when the ruling decided none', () => {
    const write = written(ACTION_TRANSITIONS.rule({ option: 'A' }, AT));

    expect(Object.hasOwn(write.patch, 'dedicated')).toBe(false);
  });
});

describe('dedicate', () => {
  it('marks the finding as the human', () => {
    const write = written(ACTION_TRANSITIONS.dedicate({ dedicated: true }, AT));

    expect(write).toEqual({ writer: 'human', patch: { dedicated: true } });
  });

  it('clears the mark', () => {
    const write = written(
      ACTION_TRANSITIONS.dedicate({ dedicated: false }, AT),
      fixture({ dedicated: true })
    );

    expect(write.patch.dedicated).toBe(false);
  });
});

describe('deny', () => {
  it('denies the finding with the reason it was given', () => {
    const write = written(ACTION_TRANSITIONS.deny({ reason: 'Not worth it' }, AT));

    expect(write.patch).toMatchObject({
      state: 'denied',
      denial: { by: 'human', reason: 'Not worth it' },
    });
  });

  it('takes a denial with no reason', () => {
    const write = written(ACTION_TRANSITIONS.deny({}, AT));

    expect(write.patch.denial).toMatchObject({ reason: null });
  });
});

describe('reopen', () => {
  it('returns a decided finding to the open state', () => {
    const write = written(ACTION_TRANSITIONS.reopen({}, AT), fixture({ state: 'ruled' }));

    expect(write.patch.state).toBe('open');
  });

  it('refuses a finding nobody decided', () => {
    const outcome = ACTION_TRANSITIONS.reopen({}, AT)(fixture());

    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid-transition' } });
  });
});

describe('ask', () => {
  it('appends the question as the human', () => {
    const write = written(ACTION_TRANSITIONS.ask({ text: 'Is this still true?' }, AT));

    expect(write.writer).toBe('human');
    expect(write.patch.questions).toMatchObject([{ text: 'Is this still true?', answer: null }]);
  });
});

describe('withdraw', () => {
  it('drops the question at the index it names', () => {
    const asked = written(ACTION_TRANSITIONS.ask({ text: 'Is this still true?' }, AT));
    const carrying = { ...fixture(), questions: asked.patch.questions ?? [] };

    const write = written(ACTION_TRANSITIONS.withdraw({ index: 0 }, AT), carrying);

    expect(write.patch.questions).toEqual([]);
  });

  it('refuses an index no question sits at', () => {
    const outcome = ACTION_TRANSITIONS.withdraw({ index: 3 }, AT)(fixture());

    expect(outcome).toMatchObject({ ok: false, error: { code: 'unknown-question' } });
  });
});

describe('unblock', () => {
  it('returns the finding to the queue with the answer attributed to the human', () => {
    const write = written(ACTION_TRANSITIONS.unblock({ note: 'Ship it.' }, AT), blocked());

    expect(write.patch.progress).toMatchObject({ status: 'not-started' });
    expect(write.patch.progress?.notes?.at(-1)).toMatchObject({ by: 'human', text: 'Ship it.' });
  });

  it('keeps the note the block was raised with', () => {
    const write = written(ACTION_TRANSITIONS.unblock({ note: 'Ship it.' }, AT), blocked());

    expect(write.patch.progress?.notes).toHaveLength(2);
  });

  it('names the mark in the same patch when the answer decided one', () => {
    const write = written(
      ACTION_TRANSITIONS.unblock({ note: 'It needs a session.', dedicated: true }, AT),
      blocked()
    );

    expect(write.patch.dedicated).toBe(true);
  });

  it('marks nothing when the answer it rode on was refused', () => {
    const outcome = ACTION_TRANSITIONS.unblock(
      { note: 'Carry on.', dedicated: true },
      AT
    )(fixture());

    expect(outcome).toMatchObject({ ok: false, error: { code: 'invalid-transition' } });
  });
});

describe('progress', () => {
  it('writes a status as the human', () => {
    const write = written(ACTION_TRANSITIONS.progress({ status: 'in-progress' }, AT));

    expect(write.writer).toBe('human');
    expect(write.patch.progress).toMatchObject({ status: 'in-progress' });
  });

  it('leaves the agent’s last report where it was', () => {
    const write = written(ACTION_TRANSITIONS.progress({ status: 'in-progress' }, AT));

    expect(Object.hasOwn(write.patch.progress ?? {}, 'updated')).toBe(false);
  });

  it('names only the field the call carried', () => {
    const write = written(ACTION_TRANSITIONS.progress({ verified: true }, AT));

    expect(write.patch.progress).toEqual({ verified: true });
  });

  it('appends a note as the human', () => {
    const write = written(ACTION_TRANSITIONS.progress({ note: 'Checked this myself' }, AT));

    expect(write.patch.progress?.notes).toMatchObject([
      { by: 'human', text: 'Checked this myself' },
    ]);
  });
});

describe('buildTransition', () => {
  it('builds the transition the named action declares', () => {
    const write = written(buildTransition('deny', { reason: 'Not worth it' }, AT));

    expect(write.patch).toMatchObject({ state: 'denied' });
  });
});
