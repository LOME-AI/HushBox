import { writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AGENT_OWNED_FIELDS, parseFinding, unblockFinding, updateProgress } from '@hushbox/docket';
import { createAuditFixture, findingFile } from '../test-utils/audit-fixture';
import { SETTABLE_FIELDS, alsoNoting, runWrite } from './write';
import type { CliDeps } from './deps';
import type {
  AskCommand,
  DedicateCommand,
  DenyCommand,
  MoveCommand,
  RemarkCommand,
  ReopenCommand,
  RuleCommand,
  UnblockCommand,
  VerifyCommand,
  WithdrawCommand,
} from './parse-command';
import type { AuditFixture } from '../test-utils/audit-fixture';
import type { Finding } from '@hushbox/docket';

const AT = '2026-07-31';

describe('runWrite', () => {
  let fixture: AuditFixture;
  let out: string[];
  let err: string[];

  beforeEach(async () => {
    fixture = await createAuditFixture();
    out = [];
    err = [];
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  function deps(): CliDeps {
    return {
      repoRoot: fixture.root,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      now: () => AT,
    };
  }

  async function read(id: string): Promise<ReturnType<typeof parseFinding>> {
    const file = path.join(fixture.findingsDir, `${id}.md`);
    return parseFinding(await fs.readFile(file, 'utf8'), file);
  }

  async function findingValue(id: string): Promise<Finding> {
    const parsed = await read(id);
    if (!parsed.ok) throw new Error('the fixture finding no longer parses');
    return parsed.value;
  }

  async function findingOf(id: string): Promise<Record<string, unknown>> {
    return (await findingValue(id)) as unknown as Record<string, unknown>;
  }

  describe('--set', () => {
    it('writes the progress status', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'in-progress' },
        deps()
      );
      expect(code).toBe(0);
      const finding = await findingOf('AC-1');
      expect(finding['progress']).toMatchObject({ status: 'in-progress' });
    });

    it('stamps the write time as the agent writer', async () => {
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'done' },
        deps()
      );
      const finding = await findingOf('AC-1');
      expect(finding['progress']).toMatchObject({ updated: AT });
    });

    it('confirms what it wrote', async () => {
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'done' },
        deps()
      );
      expect(out.join('\n')).toContain('AC-1 progress.status is now "done"');
    });

    it('marks a finding dedicated', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'dedicated', value: 'true' },
        deps()
      );
      expect(code).toBe(0);
      expect(await findingOf('AC-1')).toMatchObject({ dedicated: true });
    });

    it('confirms the mark it wrote', async () => {
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'dedicated', value: 'true' },
        deps()
      );
      expect(out.join('\n')).toContain('AC-1 is now dedicated');
    });

    it('confirms the mark it cleared', async () => {
      await fixture.writeFinding('AC-1', { dedicated: true });
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'dedicated', value: 'false' },
        deps()
      );
      expect(out.join('\n')).toContain('AC-1 is no longer dedicated');
    });

    it('clears a mark', async () => {
      await fixture.writeFinding('AC-1', { dedicated: true });
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'dedicated', value: 'false' },
        deps()
      );
      expect(code).toBe(0);
    });

    it('writes the cleared mark through to the file', async () => {
      await fixture.writeFinding('AC-1', { dedicated: true });
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'dedicated', value: 'false' },
        deps()
      );
      expect(await findingOf('AC-1')).toMatchObject({ dedicated: false });
    });

    it('refuses a value that is neither true nor false', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'dedicated', value: 'yes' },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('dedicated must be true or false');
      expect(await findingOf('AC-1')).toMatchObject({ dedicated: false });
    });

    it('refuses a progress status outside the enum', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'nearly' },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('progress.status must be one of');
    });

    it('refuses to write state, which belongs to the human', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'state', value: 'ruled' },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('not-owned');
      expect(err.join('\n')).toContain('state');
    });

    it('leaves the file untouched when it refuses a state write', async () => {
      const before = await fs.readFile(path.join(fixture.findingsDir, 'AC-1.md'), 'utf8');
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'state', value: 'ruled' },
        deps()
      );
      expect(await fs.readFile(path.join(fixture.findingsDir, 'AC-1.md'), 'utf8')).toBe(before);
    });

    it('refuses to write a ruling, which belongs to the human', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'ruling', value: 'A' },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('not-owned');
    });

    it('refuses to write the human verification', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.verified', value: 'true' },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('not-owned');
    });

    it('sends a progress note to the note command rather than corrupting the array', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.notes', value: 'hello' },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('--note');
    });

    it('sends the store spelling of an answer to the answer command too', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'answers', value: 'yes' },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('--answer');
    });

    it('refuses the bare spelling of a note, which no writer owns', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'notes', value: 'hello' },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('not-owned');
    });

    it('sends an answer to the answer command', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'questions.answers', value: 'yes' },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('--answer');
    });

    it('refuses to set the time it last reported, which the store stamps', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.updated', value: '2020-01-01' },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('progress.updated is not written this way');
      expect(err.join('\n')).toContain('stamped');
      const finding = await findingOf('AC-1');
      expect(finding['progress']).not.toMatchObject({ updated: '2020-01-01' });
    });

    it('names the writes that move the stamp rather than claiming every write does', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.updated', value: '2020-01-01' },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('stamped automatically whenever you report progress');
    });
  });

  describe('--note', () => {
    it('appends a progress note attributed to the agent', async () => {
      const code = await runWrite(
        { kind: 'note', audit: null, id: 'AC-1', text: 'index drafted' },
        deps()
      );
      expect(code).toBe(0);
      const finding = await findingOf('AC-1');
      expect(finding['progress']).toMatchObject({
        notes: [{ at: AT, by: 'agent', text: 'index drafted' }],
      });
    });

    it('confirms the note it appended', async () => {
      await runWrite({ kind: 'note', audit: null, id: 'AC-1', text: 'index drafted' }, deps());
      expect(out.join('\n')).toContain('AC-1 progress note added');
    });
  });

  describe('a dedicated finding', () => {
    beforeEach(async () => {
      await fixture.writeFinding('AC-1', { dedicated: true });
    });

    it('still takes a progress note, because a listing skips it but a write never does', async () => {
      const code = await runWrite(
        { kind: 'note', audit: null, id: 'AC-1', text: 'session held' },
        deps()
      );
      expect(code).toBe(0);
      const finding = await findingOf('AC-1');
      expect(finding['progress']).toMatchObject({
        notes: [{ at: AT, by: 'agent', text: 'session held' }],
      });
    });

    it('still takes a progress status', async () => {
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'in-progress' },
        deps()
      );
      expect(code).toBe(0);
      expect(await findingOf('AC-1')).toMatchObject({ progress: { status: 'in-progress' } });
    });

    it('still takes an answer to a question asked of it', async () => {
      await fs.writeFile(
        path.join(fixture.findingsDir, 'AC-1.md'),
        findingFile('AC-1', { dedicated: true }).replace(
          'questions: []',
          'questions:\n  - { at: "2026-07-30", text: "Which epoch?", answer: null, answered_at: null }'
        )
      );
      const code = await runWrite(
        { kind: 'answer', audit: null, id: 'AC-1', text: 'the current one', index: null },
        deps()
      );
      expect(code).toBe(0);
      const finding = await findingOf('AC-1');
      expect(finding['questions']).toMatchObject([{ answer: 'the current one' }]);
    });
  });

  describe('--answer', () => {
    beforeEach(async () => {
      await fs.writeFile(
        path.join(fixture.findingsDir, 'AC-1.md'),
        findingFile('AC-1', { state: 'open' }).replace(
          'questions: []',
          'questions:\n  - { at: "2026-07-30", text: "Which epoch?", answer: null, answered_at: null }'
        )
      );
    });

    it('answers the first unanswered question when no index is given', async () => {
      const code = await runWrite(
        { kind: 'answer', audit: null, id: 'AC-1', text: 'the current one', index: null },
        deps()
      );
      expect(code).toBe(0);
      const finding = await findingOf('AC-1');
      expect(finding['questions']).toMatchObject([{ answer: 'the current one', answered_at: AT }]);
    });

    it('leaves the state alone, because an answer decides nothing', async () => {
      await runWrite(
        { kind: 'answer', audit: null, id: 'AC-1', text: 'the current one', index: null },
        deps()
      );
      const finding = await findingOf('AC-1');
      expect(finding['state']).toBe('open');
    });

    it('confirms the answer and how many questions it left open', async () => {
      await runWrite(
        { kind: 'answer', audit: null, id: 'AC-1', text: 'the current one', index: null },
        deps()
      );
      expect(out.join('\n')).toContain('AC-1 question 0 answered, 0 still open');
    });

    it('answers the question the index names', async () => {
      const code = await runWrite(
        { kind: 'answer', audit: null, id: 'AC-1', text: 'the current one', index: 0 },
        deps()
      );
      expect(code).toBe(0);
    });

    it('refuses an index with no question behind it', async () => {
      const code = await runWrite(
        { kind: 'answer', audit: null, id: 'AC-1', text: 'no', index: 4 },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('unknown-question');
    });

    it('leaves the report time where the last progress report left it', async () => {
      const reportedAt = '2026-07-30';
      await runWrite(
        { kind: 'note', audit: null, id: 'AC-1', text: 'index drafted' },
        { ...deps(), now: () => reportedAt }
      );

      const code = await runWrite(
        { kind: 'answer', audit: null, id: 'AC-1', text: 'the current one', index: null },
        deps()
      );

      expect(code).toBe(0);
      const finding = await findingOf('AC-1');
      expect(finding['progress']).toMatchObject({ updated: reportedAt });
    });

    it('says so when there is nothing to answer', async () => {
      const code = await runWrite(
        { kind: 'answer', audit: null, id: 'AC-2', text: 'no', index: null },
        deps()
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('no unanswered question');
    });
  });

  const MANDATE = 'the smaller fix ships first';
  const RELAYED =
    'the smaller fix ships first — relayed from the human by the implementation agent';

  interface Note {
    readonly at: string;
    readonly by: string;
    readonly text: string;
  }

  async function notesOf(id: string): Promise<readonly Note[]> {
    const finding = await findingOf(id);
    return (finding['progress'] as { readonly notes: readonly Note[] }).notes;
  }

  function ruleCommand(extra: { text?: string; dedicated?: boolean } = {}): RuleCommand {
    return { kind: 'rule', audit: null, id: 'AC-1', option: 'A', mandate: MANDATE, ...extra };
  }

  describe('--rule', () => {
    it('rules the finding as the human', async () => {
      const code = await runWrite(ruleCommand(), deps());
      expect(code).toBe(0);
      const finding = await findingOf('AC-1');
      expect(finding['state']).toBe('ruled');
      expect(finding['ruling']).toMatchObject({ option: 'A', at: AT });
    });

    it('records the mandate as the ruling note', async () => {
      await runWrite(ruleCommand(), deps());
      expect(await findingOf('AC-1')).toMatchObject({ ruling: { note: RELAYED } });
    });

    it('writes what the ruling decided when it says so in its own words', async () => {
      await runWrite(ruleCommand({ text: 'none of these; do the narrow fix' }), deps());
      expect(await findingOf('AC-1')).toMatchObject({
        ruling: { text: 'none of these; do the narrow fix' },
      });
    });

    it('leaves the decision text unwritten when the ruling gives none', async () => {
      await runWrite(ruleCommand(), deps());
      expect(await findingOf('AC-1')).toMatchObject({ ruling: { text: null } });
    });

    it('marks the finding in the write that decided it', async () => {
      await runWrite(ruleCommand({ dedicated: true }), deps());
      expect(await findingOf('AC-1')).toMatchObject({ dedicated: true });
    });

    it('takes a ruling that raced a mark it says nothing about', async () => {
      const marked = findingFile('AC-1', { dedicated: true });
      const code = await runWrite(ruleCommand(), depsThatEditDuring(marked));
      expect(code).toBe(0);
    });

    it('refuses a ruling that raced the mark it names', async () => {
      const marked = findingFile('AC-1', { dedicated: true });
      const code = await runWrite(ruleCommand({ dedicated: false }), depsThatEditDuring(marked));
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('conflict');
    });

    it('confirms the ruling it wrote', async () => {
      await runWrite(ruleCommand(), deps());
      expect(out.join('\n')).toContain('AC-1 is ruled "A"');
    });
  });

  describe('--deny', () => {
    const denial: DenyCommand = { kind: 'deny', audit: null, id: 'AC-1', mandate: MANDATE };

    it('denies the finding as the human', async () => {
      const code = await runWrite(denial, deps());
      expect(code).toBe(0);
      const finding = await findingOf('AC-1');
      expect(finding['state']).toBe('denied');
      expect(finding['denial']).toMatchObject({ by: 'human', at: AT });
    });

    it('records the mandate as the reason', async () => {
      await runWrite(denial, deps());
      expect(await findingOf('AC-1')).toMatchObject({ denial: { reason: RELAYED } });
    });

    it('refuses a finding that is already denied', async () => {
      await runWrite(denial, deps());
      const code = await runWrite(denial, deps());
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('invalid-transition');
    });

    it('confirms the denial it wrote', async () => {
      await runWrite(denial, deps());
      expect(out.join('\n')).toContain('AC-1 is denied');
    });
  });

  describe('--reopen', () => {
    const reopening: ReopenCommand = { kind: 'reopen', audit: null, id: 'AC-1', mandate: MANDATE };

    it('reopens a decided finding', async () => {
      await runWrite(ruleCommand(), deps());
      const code = await runWrite(reopening, deps());
      expect(code).toBe(0);
      expect(await findingOf('AC-1')).toMatchObject({ state: 'open', ruling: null });
    });

    it('records the mandate as a note attributed to the human', async () => {
      await runWrite(ruleCommand(), deps());
      await runWrite(reopening, deps());
      expect(await notesOf('AC-1')).toEqual([{ at: AT, by: 'human', text: RELAYED }]);
    });

    it('keeps the notes the finding already carried', async () => {
      await runWrite({ kind: 'note', audit: null, id: 'AC-1', text: 'index drafted' }, deps());
      await runWrite(ruleCommand(), deps());
      await runWrite(reopening, deps());
      expect(await notesOf('AC-1')).toMatchObject([
        { by: 'agent', text: 'index drafted' },
        { by: 'human', text: RELAYED },
      ]);
    });

    it('keeps the progress reset the reopening makes', async () => {
      await runWrite(ruleCommand(), deps());
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'done' },
        deps()
      );
      await runWrite(reopening, deps());
      expect(await findingOf('AC-1')).toMatchObject({
        progress: { status: 'not-started', verified: false },
      });
    });

    it('refuses a finding nobody decided', async () => {
      const code = await runWrite(reopening, deps());
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('invalid-transition');
    });

    it('confirms the reopening', async () => {
      await runWrite(ruleCommand(), deps());
      await runWrite(reopening, deps());
      expect(out.join('\n')).toContain('AC-1 is open again');
    });
  });

  async function ruledAndBlocked(): Promise<void> {
    await runWrite(ruleCommand(), deps());
    await runWrite(
      { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'blocked' },
      deps()
    );
  }

  describe('--unblock', () => {
    const unblocking: UnblockCommand = {
      kind: 'unblock',
      audit: null,
      id: 'AC-1',
      mandate: MANDATE,
    };

    it('answers the block in the mandate’s words, attributed to the human', async () => {
      await ruledAndBlocked();
      const code = await runWrite(unblocking, deps());
      expect(code).toBe(0);
      expect(await notesOf('AC-1')).toEqual([{ at: AT, by: 'human', text: RELAYED }]);
    });

    it('hands the work back to an agent', async () => {
      await ruledAndBlocked();
      await runWrite(unblocking, deps());
      expect(await findingOf('AC-1')).toMatchObject({ progress: { status: 'not-started' } });
    });

    it('keeps the note the block was raised in', async () => {
      await ruledAndBlocked();
      await runWrite(
        { kind: 'note', audit: null, id: 'AC-1', text: 'bigger than the task' },
        deps()
      );
      await runWrite(unblocking, deps());
      expect(await notesOf('AC-1')).toMatchObject([
        { by: 'agent', text: 'bigger than the task' },
        { by: 'human', text: RELAYED },
      ]);
    });

    it('marks the finding in the write that answered the block', async () => {
      await ruledAndBlocked();
      await runWrite({ ...unblocking, dedicated: true }, deps());
      expect(await findingOf('AC-1')).toMatchObject({ dedicated: true });
    });

    it('refuses a finding that is not blocked', async () => {
      const code = await runWrite(unblocking, deps());
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('invalid-transition');
    });

    it('confirms the unblocking', async () => {
      await ruledAndBlocked();
      await runWrite(unblocking, deps());
      expect(out.join('\n')).toContain('AC-1 is unblocked');
    });
  });

  describe('--ask', () => {
    const asking: AskCommand = {
      kind: 'ask',
      audit: null,
      id: 'AC-1',
      text: 'Which epoch does this mean?',
      mandate: MANDATE,
    };

    it('appends the question as the human', async () => {
      const code = await runWrite(asking, deps());
      expect(code).toBe(0);
      expect(await findingOf('AC-1')).toMatchObject({
        questions: [{ at: AT, text: 'Which epoch does this mean?', answer: null }],
      });
    });

    it('records the mandate as a note attributed to the human', async () => {
      await runWrite(asking, deps());
      expect(await notesOf('AC-1')).toEqual([{ at: AT, by: 'human', text: RELAYED }]);
    });

    it('lands beside a note another writer added while it was being asked', async () => {
      const others = findingFile('AC-1').replace(
        'notes: []',
        'notes:\n    - { at: "2026-07-31", by: "agent", text: "someone else was here" }'
      );
      const code = await runWrite(asking, depsThatEditDuring(others));
      expect(code).toBe(0);
      expect(await notesOf('AC-1')).toMatchObject([
        { by: 'agent', text: 'someone else was here' },
        { by: 'human', text: RELAYED },
      ]);
    });

    it('confirms the question it asked', async () => {
      await runWrite(asking, deps());
      expect(out.join('\n')).toContain('AC-1 asked, 1 unanswered');
    });
  });

  describe('--withdraw', () => {
    const withdrawing: WithdrawCommand = {
      kind: 'withdraw',
      audit: null,
      id: 'AC-1',
      index: 0,
      mandate: MANDATE,
    };

    beforeEach(async () => {
      await fs.writeFile(
        path.join(fixture.findingsDir, 'AC-1.md'),
        findingFile('AC-1').replace(
          'questions: []',
          'questions:\n  - { at: "2026-07-30", text: "Which epoch?", answer: null, answered_at: null }'
        )
      );
    });

    it('drops the question the index names', async () => {
      const code = await runWrite(withdrawing, deps());
      expect(code).toBe(0);
      expect(await findingOf('AC-1')).toMatchObject({ questions: [] });
    });

    it('records the mandate as a note attributed to the human', async () => {
      await runWrite(withdrawing, deps());
      expect(await notesOf('AC-1')).toEqual([{ at: AT, by: 'human', text: RELAYED }]);
    });

    it('refuses an index with no question behind it', async () => {
      const code = await runWrite({ ...withdrawing, index: 3 }, deps());
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('unknown-question');
    });

    it('confirms the withdrawal', async () => {
      await runWrite(withdrawing, deps());
      expect(out.join('\n')).toContain('AC-1 question 0 withdrawn, 0 left');
    });
  });

  describe('--dedicate', () => {
    const dedicating: DedicateCommand = {
      kind: 'dedicate',
      audit: null,
      id: 'AC-1',
      dedicated: true,
      mandate: MANDATE,
    };

    it('marks the finding', async () => {
      const code = await runWrite(dedicating, deps());
      expect(code).toBe(0);
      expect(await findingOf('AC-1')).toMatchObject({ dedicated: true });
    });

    it('records the mandate as a note attributed to the human', async () => {
      await runWrite(dedicating, deps());
      expect(await notesOf('AC-1')).toEqual([{ at: AT, by: 'human', text: RELAYED }]);
    });

    it('clears a mark on the same mandate', async () => {
      await fixture.writeFinding('AC-1', { dedicated: true });
      const code = await runWrite({ ...dedicating, dedicated: false }, deps());
      expect(code).toBe(0);
      expect(await findingOf('AC-1')).toMatchObject({ dedicated: false });
    });

    it('confirms the mark it set', async () => {
      await runWrite(dedicating, deps());
      expect(out.join('\n')).toContain('AC-1 is now dedicated');
    });

    it('confirms the mark it cleared', async () => {
      await fixture.writeFinding('AC-1', { dedicated: true });
      await runWrite({ ...dedicating, dedicated: false }, deps());
      expect(out.join('\n')).toContain('AC-1 is no longer dedicated');
    });
  });

  describe('--verify', () => {
    const verifying: VerifyCommand = {
      kind: 'verify',
      audit: null,
      id: 'AC-1',
      verified: true,
      mandate: MANDATE,
    };

    it('records the reader’s verdict on the work', async () => {
      const code = await runWrite(verifying, deps());
      expect(code).toBe(0);
      expect(await findingOf('AC-1')).toMatchObject({ progress: { verified: true } });
    });

    it('records the mandate as a note attributed to the human', async () => {
      await runWrite(verifying, deps());
      expect(await notesOf('AC-1')).toEqual([{ at: AT, by: 'human', text: RELAYED }]);
    });

    it('leaves the agent’s last-reported stamp where the agent left it', async () => {
      const reportedAt = '2026-07-30';
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'done' },
        { ...deps(), now: () => reportedAt }
      );
      await runWrite(verifying, deps());
      expect(await findingOf('AC-1')).toMatchObject({ progress: { updated: reportedAt } });
    });

    it('takes back a verification', async () => {
      await runWrite(verifying, deps());
      const code = await runWrite({ ...verifying, verified: false }, deps());
      expect(code).toBe(0);
      expect(await findingOf('AC-1')).toMatchObject({ progress: { verified: false } });
    });

    it('confirms the verdict it recorded', async () => {
      await runWrite(verifying, deps());
      expect(out.join('\n')).toContain('AC-1 progress is verified');
    });
  });

  describe('--move', () => {
    const moving: MoveCommand = {
      kind: 'move',
      audit: null,
      id: 'AC-1',
      status: 'done',
      mandate: MANDATE,
    };

    it('puts the work where the reader moved it', async () => {
      const code = await runWrite(moving, deps());
      expect(code).toBe(0);
      expect(await findingOf('AC-1')).toMatchObject({ progress: { status: 'done' } });
    });

    it('records the mandate as a note attributed to the human', async () => {
      await runWrite(moving, deps());
      expect(await notesOf('AC-1')).toEqual([{ at: AT, by: 'human', text: RELAYED }]);
    });

    it('leaves the agent’s last-reported stamp where the agent left it', async () => {
      const reportedAt = '2026-07-30';
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'in-progress' },
        { ...deps(), now: () => reportedAt }
      );
      await runWrite(moving, deps());
      expect(await findingOf('AC-1')).toMatchObject({ progress: { updated: reportedAt } });
    });

    it('refuses a move that raced the status it replaces', async () => {
      const moved = findingFile('AC-1').replace('status: "not-started"', 'status: "in-progress"');
      const code = await runWrite(moving, depsThatEditDuring(moved));
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('conflict');
    });

    it('confirms the status it wrote', async () => {
      await runWrite(moving, deps());
      expect(out.join('\n')).toContain('AC-1 progress.status is now "done"');
    });
  });

  describe('--remark', () => {
    const remarking: RemarkCommand = {
      kind: 'remark',
      audit: null,
      id: 'AC-1',
      mandate: MANDATE,
    };

    it('records the mandate as a note attributed to the human', async () => {
      const code = await runWrite(remarking, deps());
      expect(code).toBe(0);
      expect(await notesOf('AC-1')).toEqual([{ at: AT, by: 'human', text: RELAYED }]);
    });

    it('leaves the work where it was, having said something about it and nothing else', async () => {
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'in-progress' },
        deps()
      );
      await runWrite(remarking, deps());
      expect(await findingOf('AC-1')).toMatchObject({ progress: { status: 'in-progress' } });
    });

    it('leaves the agent’s last-reported stamp where the agent left it', async () => {
      const reportedAt = '2026-07-30';
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'in-progress' },
        { ...deps(), now: () => reportedAt }
      );
      await runWrite(remarking, deps());
      expect(await findingOf('AC-1')).toMatchObject({ progress: { updated: reportedAt } });
    });

    it('lands beside a note another writer added while it was being written', async () => {
      const others = findingFile('AC-1').replace(
        'notes: []',
        'notes:\n    - { at: "2026-07-31", by: "agent", text: "someone else was here" }'
      );
      const code = await runWrite(remarking, depsThatEditDuring(others));
      expect(code).toBe(0);
      expect(await notesOf('AC-1')).toMatchObject([
        { by: 'agent', text: 'someone else was here' },
        { by: 'human', text: RELAYED },
      ]);
    });

    it('confirms the note it appended', async () => {
      await runWrite(remarking, deps());
      expect(out.join('\n')).toContain('AC-1 progress note added (1 in all)');
    });
  });

  /**
   * The regression the wrapper exists to avoid: a transition that already puts
   * `progress.notes` in its patch has a note of its own, and a mandate note
   * composed from the finding alone would drop it.
   */
  describe('the note a mandate rides on', () => {
    it('keeps the note the write it rides already appended', async () => {
      await ruledAndBlocked();
      const wrapped = alsoNoting(unblockFinding({ note: 'the answer' }, AT), RELAYED, AT);

      const outcome = wrapped(await findingValue('AC-1'));

      if (!outcome.ok) throw new Error(outcome.error.message);
      expect(outcome.value.patch.progress?.notes).toMatchObject([
        { by: 'human', text: 'the answer' },
        { by: 'human', text: RELAYED },
      ]);
    });

    it('keeps the note a progress report already appended', async () => {
      const wrapped = alsoNoting(updateProgress({ note: 'reported' }, AT, 'agent'), RELAYED, AT);

      const outcome = wrapped(await findingValue('AC-1'));

      if (!outcome.ok) throw new Error(outcome.error.message);
      expect(outcome.value.patch.progress?.notes).toMatchObject([
        { by: 'agent', text: 'reported' },
        { by: 'human', text: RELAYED },
      ]);
    });

    it('leaves the writer the wrapped write named', async () => {
      const wrapped = alsoNoting(updateProgress({ note: 'reported' }, AT, 'agent'), RELAYED, AT);

      const outcome = wrapped(await findingValue('AC-1'));

      if (!outcome.ok) throw new Error(outcome.error.message);
      expect(outcome.value.writer).toBe('agent');
    });

    it('hands back a refusal rather than noting it', async () => {
      const wrapped = alsoNoting(unblockFinding({ note: 'the answer' }, AT), RELAYED, AT);

      expect(wrapped(await findingValue('AC-1')).ok).toBe(false);
    });
  });

  /**
   * The clock is read after the finding is loaded and before the write is
   * applied, so an edit made from it lands in exactly the window a guarded
   * write guards. Written synchronously because the plan does not await the
   * clock.
   */
  function depsThatEditDuring(replacement: string): CliDeps {
    return {
      ...deps(),
      now: () => {
        writeFileSync(path.join(fixture.findingsDir, 'AC-1.md'), replacement);
        return AT;
      },
    };
  }

  describe('a finding that changed since it was read', () => {
    const OTHERS_NOTE =
      'notes:\n    - { at: "2026-07-31", by: "human", text: "someone else was here" }';

    function twoQuestions(answers: { first?: string; second?: string } = {}): string {
      const question = (at: string, text: string, answer: string | undefined): string => {
        const given = answer === undefined ? 'null' : `"${answer}"`;
        const answeredAt = answer === undefined ? 'null' : '"2026-07-31"';
        return `  - { at: "${at}", text: "${text}", answer: ${given}, answered_at: ${answeredAt} }`;
      };
      return findingFile('AC-1').replace(
        'questions: []',
        [
          'questions:',
          question('2026-07-30', 'Which epoch?', answers.first),
          question('2026-07-30', 'Which limiter?', answers.second),
        ].join('\n')
      );
    }

    it('refuses a write that replaces a field the other writer moved', async () => {
      const other = findingFile('AC-1').replace('status: "not-started"', 'status: "done"');
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'in-progress' },
        depsThatEditDuring(other)
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('conflict');
    });

    it('tells the caller to read the finding again', async () => {
      const other = findingFile('AC-1').replace('status: "not-started"', 'status: "done"');
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'in-progress' },
        depsThatEditDuring(other)
      );
      expect(err.join('\n')).toContain('read AC-1 again');
    });

    it('leaves the replaced value as the other writer left it', async () => {
      const other = findingFile('AC-1').replace('status: "not-started"', 'status: "done"');
      await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'in-progress' },
        depsThatEditDuring(other)
      );
      const finding = await findingOf('AC-1');
      expect(finding['progress']).toMatchObject({ status: 'done' });
    });

    it('takes a replacing write to a field the other writer did not touch', async () => {
      const other = findingFile('AC-1').replace('area: "unknown"', 'area: "apps/api"');
      const code = await runWrite(
        { kind: 'set', audit: null, id: 'AC-1', field: 'progress.status', value: 'in-progress' },
        depsThatEditDuring(other)
      );
      expect(code).toBe(0);
    });

    it('lands a note beside the note the other writer added', async () => {
      const code = await runWrite(
        { kind: 'note', audit: null, id: 'AC-1', text: 'written from a stale read' },
        depsThatEditDuring(findingFile('AC-1').replace('notes: []', OTHERS_NOTE))
      );
      expect(code).toBe(0);
      const finding = await findingOf('AC-1');
      expect(finding['progress']).toMatchObject({
        notes: [
          { by: 'human', text: 'someone else was here' },
          { by: 'agent', text: 'written from a stale read' },
        ],
      });
    });

    it('takes two agents answering different questions of the same finding', async () => {
      await fs.writeFile(path.join(fixture.findingsDir, 'AC-1.md'), twoQuestions());

      const code = await runWrite(
        { kind: 'answer', audit: null, id: 'AC-1', text: 'the current one', index: 0 },
        depsThatEditDuring(twoQuestions({ second: 'the shared one' }))
      );

      expect(code).toBe(0);
      const finding = await findingOf('AC-1');
      expect(finding['questions']).toMatchObject([
        { answer: 'the current one' },
        { answer: 'the shared one' },
      ]);
    });

    /**
     * The guarantee that makes an unguarded answer safe: the store decides the
     * index against the file it re-reads, so a race on the same question is
     * refused on its own merits rather than by a version check.
     */
    it('refuses a second answer to the question the other writer just answered', async () => {
      await fs.writeFile(path.join(fixture.findingsDir, 'AC-1.md'), twoQuestions());

      const code = await runWrite(
        { kind: 'answer', audit: null, id: 'AC-1', text: 'the current one', index: 0 },
        depsThatEditDuring(twoQuestions({ first: 'answered first' }))
      );

      expect(code).toBe(1);
      expect(err.join('\n')).toContain('unknown-question');
      const finding = await findingOf('AC-1');
      expect(finding['questions']).toMatchObject([{ answer: 'answered first' }, { answer: null }]);
    });
  });

  it('reports an id that is not in the audit', async () => {
    const code = await runWrite({ kind: 'note', audit: null, id: 'NOPE-1', text: 'x' }, deps());
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('no finding "NOPE-1"');
  });

  it('writes into the audit the pin names', async () => {
    const code = await runWrite(
      { kind: 'note', audit: '2026-07-30', id: 'AC-1', text: 'pinned' },
      deps()
    );
    expect(code).toBe(0);
  });

  it('times its own writes when no clock is injected', async () => {
    const { repoRoot, out: write, err: fail } = deps();
    await runWrite(
      { kind: 'note', audit: null, id: 'AC-1', text: 'clockless' },
      { repoRoot, out: write, err: fail }
    );
    const finding = await findingOf('AC-1');
    const progress = finding['progress'] as { notes: { at: string }[] };
    expect(Date.parse(progress.notes[0]?.at ?? '')).toBeGreaterThan(0);
  });
  describe('the fields --set writes', () => {
    it('offers every field the store lets an agent write', () => {
      for (const field of SETTABLE_FIELDS) expect(AGENT_OWNED_FIELDS).toContain(field);
    });

    it('drops the fields it refuses', () => {
      expect(SETTABLE_FIELDS.length).toBeLessThan(AGENT_OWNED_FIELDS.length);
    });

    it('refuses a dropped field, saying what writes it instead', async () => {
      const dropped = AGENT_OWNED_FIELDS.filter((field) => !SETTABLE_FIELDS.includes(field));
      for (const field of dropped) {
        await runWrite({ kind: 'set', audit: null, id: 'AC-1', field, value: 'x' }, deps());
      }
      expect(err.join('\n')).toContain('is not written this way');
    });
  });
});
