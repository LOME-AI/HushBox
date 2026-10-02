import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { answerQuestion, applyWrite, askQuestion, formatQuestionsBrief } from '@hushbox/docket';
import { createAuditFixture } from '../test-utils/audit-fixture';
import { runQuestions } from './questions';
import type { CliDeps } from './deps';
import type { QuestionsCommand } from './parse-command';
import type { AuditFixture } from '../test-utils/audit-fixture';

const BASE: QuestionsCommand = {
  kind: 'questions',
  audit: null,
  id: null,
  state: null,
  section: null,
  area: null,
  severity: null,
  progress: null,
};

const AT = '2026-08-07';

describe('runQuestions', () => {
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
    };
  }

  async function ask(id: string, text: string): Promise<void> {
    const outcome = await applyWrite(
      path.join(fixture.findingsDir, `${id}.md`),
      askQuestion({ text }, AT, 'human')
    );
    expect(outcome.ok).toBe(true);
  }

  async function answer(id: string, index: number): Promise<void> {
    const outcome = await applyWrite(
      path.join(fixture.findingsDir, `${id}.md`),
      answerQuestion({ index, text: 'the pooled one' }, AT, 'agent')
    );
    expect(outcome.ok).toBe(true);
  }

  it('prints a question the finding is still waiting on', async () => {
    await ask('AC-1', 'which pool?');

    expect(await runQuestions(BASE, deps())).toBe(0);
    expect(out.join('\n')).toContain('which pool?');
  });

  it('prints the questions through the shared brief rather than a format of its own', async () => {
    await ask('AC-1', 'which pool?');
    await runQuestions(BASE, deps());

    const shared = formatQuestionsBrief([
      {
        id: 'AC-1',
        title: 'AC-1 needs a decision',
        questions: [{ at: AT, text: 'which pool?', answer: null, answered_at: null }],
      },
    ]);
    expect(out.join('\n')).toBe(shared);
  });

  it('leaves out a finding whose questions are all answered', async () => {
    await ask('AC-1', 'which pool?');
    await ask('AC-2', 'which zone?');
    await answer('AC-2', 0);

    await runQuestions(BASE, deps());

    expect(out.join('\n')).toContain('AC-1');
    expect(out.join('\n')).not.toContain('AC-2');
  });

  it('scopes the questions to the filters it is given', async () => {
    await ask('AC-1', 'which pool?');
    await ask('AC-2', 'which zone?');

    await runQuestions({ ...BASE, id: 'AC-1' }, deps());

    expect(out.join('\n')).not.toContain('which zone?');
  });

  describe('a dedicated finding', () => {
    beforeEach(async () => {
      await fixture.writeFinding('AC-1', { dedicated: true });
      await ask('AC-1', 'which pool?');
    });

    it('carries its question in a brief that named no section', async () => {
      await runQuestions(BASE, deps());
      expect(out.join('\n')).toContain('which pool?');
    });

    it('carries its question under its own section', async () => {
      await runQuestions({ ...BASE, section: 'dedicated' }, deps());
      expect(out.join('\n')).toContain('which pool?');
    });

    it('carries its question when it is named by its id', async () => {
      await runQuestions({ ...BASE, id: 'AC-1' }, deps());
      expect(out.join('\n')).toContain('which pool?');
    });

    it('stands beside an undedicated finding that is also owed an answer', async () => {
      await ask('AC-2', 'which zone?');
      await runQuestions(BASE, deps());
      expect(out.join('\n')).toContain('which zone?');
      expect(out.join('\n')).toContain('which pool?');
    });
  });

  it('says so when no question is waiting, without failing', async () => {
    expect(await runQuestions(BASE, deps())).toBe(0);
    expect(err.join('\n')).toContain('no question is waiting');
    expect(out).toEqual([]);
  });

  it('fails on an id no finding carries', async () => {
    expect(await runQuestions({ ...BASE, id: 'ZZ-9' }, deps())).toBe(1);
    expect(err.join('\n')).toContain('no finding "ZZ-9"');
  });

  it('reads the audit the pin names', async () => {
    await ask('AC-1', 'which pool?');

    expect(await runQuestions({ ...BASE, audit: '2026-07-30' }, deps())).toBe(0);
  });
});
