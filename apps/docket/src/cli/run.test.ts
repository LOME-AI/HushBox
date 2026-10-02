import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAuditFixture } from '../test-utils/audit-fixture';
import { runDocket } from './run';
import type { DocketDeps } from './run';
import type { AuditFixture } from '../test-utils/audit-fixture';

describe('runDocket', () => {
  let fixture: AuditFixture;
  let out: string[];
  let err: string[];
  let started: readonly string[][];

  beforeEach(async () => {
    fixture = await createAuditFixture();
    out = [];
    err = [];
    started = [];
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  function deps(overrides: Partial<DocketDeps> = {}): DocketDeps {
    return {
      repoRoot: fixture.root,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      startConsole: (argv) => {
        started = [...started, [...argv]];
        return Promise.resolve();
      },
      ...overrides,
    };
  }

  it('starts the console when no action flag is given', async () => {
    expect(await runDocket([], deps())).toBe(0);
    expect(started).toEqual([[]]);
  });

  it('hands the console its own flags untouched', async () => {
    await runDocket(['--port', '9333', '--no-idle'], deps());
    expect(started).toEqual([['--port', '9333', '--no-idle']]);
  });

  it('exits non-zero on an unrecognized flag', async () => {
    expect(await runDocket(['--list', '--sevrity=high'], deps())).toBe(1);
  });

  it('names the flag it did not recognize', async () => {
    await runDocket(['--list', '--sevrity=high'], deps());
    expect(err.join('\n')).toContain('--sevrity');
  });

  it('points at the help rather than reprinting it', async () => {
    await runDocket(['--list', '--sevrity=high'], deps());
    expect(err.join('\n')).toContain('pnpm docket --help');
  });

  it('leaves the help out of a usage error', async () => {
    await runDocket(['--list', '--sevrity=high'], deps());
    expect(err.join('\n')).not.toContain('Queues');
  });

  it('reports the launcher refusing a console flag', async () => {
    const code = await runDocket(['--idel', '5'], {
      ...deps(),
      startConsole: () => Promise.reject(new Error('unknown option --idel')),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('unknown option --idel');
  });

  it('points at the help when the launcher refuses a console flag', async () => {
    await runDocket(['--idel', '5'], {
      ...deps(),
      startConsole: () => Promise.reject(new Error('unknown option --idel')),
    });
    expect(err.join('\n')).toContain('pnpm docket --help');
  });

  it('lists findings', async () => {
    expect(await runDocket(['--list'], deps())).toBe(0);
    expect(out).toHaveLength(2);
  });

  it('lists briefs', async () => {
    await runDocket(['--list', '--brief', '--state=open'], deps());
    expect(out.join('\n')).toContain('Ruling: none yet');
  });

  it('reads a queue by name', async () => {
    expect(await runDocket(['--list', '--section=open'], deps())).toBe(0);
    expect(out).toHaveLength(2);
  });

  it('refuses a section the console does not offer as a queue', async () => {
    expect(await runDocket(['--list', '--section=dashboard'], deps())).toBe(1);
    expect(err.join('\n')).toContain('--section must be one of');
  });

  it('refuses a section and a state together', async () => {
    expect(await runDocket(['--list', '--section=open', '--state=open'], deps())).toBe(1);
    expect(err.join('\n')).toContain('--section and --state');
  });

  it('contests a ruling with every option', async () => {
    expect(await runDocket(['--list', '--contest', '--id=AC-1'], deps())).toBe(0);
    expect(out.join('\n')).toContain('Option A');
  });

  it('censuses citations', async () => {
    expect(await runDocket(['--census'], deps())).toBe(0);
    expect(out.join('\n')).toContain('dead 0');
  });

  it('reads the outstanding questions', async () => {
    expect(await runDocket(['--questions'], deps())).toBe(0);
    expect(err.join('\n')).toContain('no question is waiting');
  });

  it('prints the help on stdout and exits zero', async () => {
    expect(await runDocket(['--help'], deps())).toBe(0);
    expect(out.join('\n')).toContain('pnpm docket --list');
  });

  it('never starts the console for help', async () => {
    await runDocket(['--help'], deps());
    expect(started).toEqual([]);
  });

  it('validates', async () => {
    expect(await runDocket(['--validate'], deps())).toBe(0);
  });

  it('writes progress', async () => {
    expect(await runDocket(['--set', 'AC-1', 'progress.status=done'], deps())).toBe(0);
    expect(out.join('\n')).toContain('progress.status is now "done"');
  });

  it('appends a note', async () => {
    expect(await runDocket(['--note', 'AC-1', 'index drafted'], deps())).toBe(0);
  });

  it('refuses an assignment with no value rather than reporting a write it did not make', async () => {
    const file = path.join(fixture.findingsDir, 'AC-1.md');
    const before = await fs.readFile(file, 'utf8');

    expect(await runDocket(['--set', 'AC-1', 'progress='], deps())).toBe(1);

    expect(out).toEqual([]);
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  describe('an action taken on a mandate', () => {
    const MANDATE = '--mandate=the human decided this one';

    it('rules a finding', async () => {
      expect(await runDocket(['--rule', 'AC-1', 'A', MANDATE], deps())).toBe(0);
      expect(out.join('\n')).toContain('AC-1 is ruled "A"');
    });

    it('denies a finding', async () => {
      expect(await runDocket(['--deny', 'AC-1', MANDATE], deps())).toBe(0);
      expect(out.join('\n')).toContain('AC-1 is denied');
    });

    it('reopens a decided finding', async () => {
      await runDocket(['--rule', 'AC-1', 'A', MANDATE], deps());
      expect(await runDocket(['--reopen', 'AC-1', MANDATE], deps())).toBe(0);
      expect(out.join('\n')).toContain('AC-1 is open again');
    });

    it('answers a block', async () => {
      await runDocket(['--rule', 'AC-1', 'A', MANDATE], deps());
      await runDocket(['--set', 'AC-1', 'progress.status=blocked'], deps());
      expect(await runDocket(['--unblock', 'AC-1', MANDATE], deps())).toBe(0);
      expect(out.join('\n')).toContain('AC-1 is unblocked');
    });

    it('asks a question', async () => {
      expect(await runDocket(['--ask', 'AC-1', 'Which epoch?', MANDATE], deps())).toBe(0);
      expect(out.join('\n')).toContain('AC-1 asked, 1 unanswered');
    });

    it('withdraws a question', async () => {
      await runDocket(['--ask', 'AC-1', 'Which epoch?', MANDATE], deps());
      expect(await runDocket(['--withdraw', 'AC-1', '0', MANDATE], deps())).toBe(0);
      expect(out.join('\n')).toContain('AC-1 question 0 withdrawn');
    });

    it('marks a finding for a session of its own', async () => {
      expect(await runDocket(['--dedicate', 'AC-1', 'true', MANDATE], deps())).toBe(0);
      expect(out.join('\n')).toContain('AC-1 is now dedicated');
    });

    it('verifies the work', async () => {
      expect(await runDocket(['--verify', 'AC-1', 'true', MANDATE], deps())).toBe(0);
      expect(out.join('\n')).toContain('AC-1 progress is verified');
    });

    it('moves the work on', async () => {
      expect(await runDocket(['--move', 'AC-1', 'done', MANDATE], deps())).toBe(0);
      expect(out.join('\n')).toContain('AC-1 progress.status is now "done"');
    });

    it('remarks on the work', async () => {
      expect(await runDocket(['--remark', 'AC-1', MANDATE], deps())).toBe(0);
      expect(out.join('\n')).toContain('AC-1 progress note added');
    });
  });

  it('refuses a human-owned field as the agent writer', async () => {
    expect(await runDocket(['--set', 'AC-1', 'state=ruled'], deps())).toBe(1);
    expect(err.join('\n')).toContain('not-owned');
  });

  it('reports a missing audit directory rather than crashing', async () => {
    await fs.rm(path.join(fixture.root, 'docs'), { recursive: true, force: true });
    expect(await runDocket(['--validate'], deps())).toBe(1);
    expect(err.join('\n')).toContain('no audit directory');
  });

  it('answers a question', async () => {
    const file = path.join(fixture.findingsDir, 'AC-1.md');
    const open = await fs.readFile(file, 'utf8');
    await fs.writeFile(
      file,
      open.replace(
        'questions: []',
        'questions:\n  - { at: "2026-07-30", text: "Which epoch?", answer: null, answered_at: null }'
      )
    );
    expect(await runDocket(['--answer', 'AC-1', 'the current one'], deps())).toBe(0);
    expect(out.join('\n')).toContain('question 0 answered');
  });

  it('describes a failure that is not an error object', async () => {
    const code = await runDocket([], {
      ...deps(),
      // A defect deep in the launcher can throw anything; the CLI still has to
      // say something rather than crash on a missing `message`.
      startConsole: () => Promise.reject('a bare string' as unknown as Error),
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('a bare string');
  });
});
