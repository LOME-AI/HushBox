import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseFinding, splitFrontmatter, validateFinding } from '@hushbox/docket';
import { createAuditFixture } from '../test-utils/audit-fixture';
import { runDocket } from './run';
import type { DocketDeps } from './run';
import type { AuditFixture } from '../test-utils/audit-fixture';
import type { Finding } from '@hushbox/docket';

const AT = '2026-07-31';
const MANDATE = 'take option A, the narrow one';
const RELAYED =
  'take option A, the narrow one — relayed from the human by the implementation agent';

/**
 * The whole command, against a throwaway audit directory: the CLI reads the
 * files, writes them, and the assertions come from re-reading the bytes rather
 * than from anything the command returned. The live corpus is never touched.
 */
describe('a mandated action against an audit on disk', () => {
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

  function deps(): DocketDeps {
    return {
      repoRoot: fixture.root,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      now: () => AT,
      // Every argv here names an action, so reaching the console would mean the
      // action was not recognized rather than that the console was wanted.
      startConsole: () => Promise.reject(new Error('the console is not this path')),
    };
  }

  async function fileText(): Promise<string> {
    return fs.readFile(path.join(fixture.findingsDir, 'AC-1.md'), 'utf8');
  }

  /**
   * An empty body is refused here rather than compared: the comparisons below
   * would pass on two of them while proving nothing about bytes no program may
   * write.
   */
  function parts(text: string): { yaml: string; body: string } {
    const split = splitFrontmatter(text);
    if (split === null || split.body === '') throw new Error('the finding lost its body');
    return split;
  }

  function findingIn(text: string): Finding {
    const parsed = parseFinding(text, 'AC-1.md');
    if (!parsed.ok) throw new Error(parsed.issues.map((issue) => issue.message).join('; '));
    return parsed.value;
  }

  async function block(): Promise<void> {
    await runDocket(['--rule', 'AC-1', 'A', '--mandate=the block was raised on this'], deps());
    await runDocket(['--set', 'AC-1', 'progress.status=blocked'], deps());
    await runDocket(['--note', 'AC-1', 'the schema change has not landed'], deps());
  }

  describe('--rule', () => {
    it('writes the ruling the command named', async () => {
      expect(await runDocket(['--rule', 'AC-1', 'A', `--mandate=${MANDATE}`], deps())).toBe(0);

      const finding = findingIn(await fileText());
      expect(finding.state).toBe('ruled');
      expect(finding.ruling).toMatchObject({ option: 'A', at: AT });
    });

    it('records the mandate in the ruling note', async () => {
      await runDocket(['--rule', 'AC-1', 'A', `--mandate=${MANDATE}`], deps());

      expect(findingIn(await fileText()).ruling?.note).toBe(RELAYED);
    });

    it('leaves the body bytes exactly as they were', async () => {
      const before = parts(await fileText()).body;

      await runDocket(['--rule', 'AC-1', 'A', `--mandate=${MANDATE}`], deps());

      expect(parts(await fileText()).body).toBe(before);
    });

    it('leaves a finding that still validates', async () => {
      await runDocket(['--rule', 'AC-1', 'A', `--mandate=${MANDATE}`], deps());

      expect(validateFinding(findingIn(await fileText()), 'structural')).toEqual([]);
    });
  });

  describe('--deny', () => {
    it('writes the denial as the human', async () => {
      expect(await runDocket(['--deny', 'AC-1', `--mandate=${MANDATE}`], deps())).toBe(0);

      const finding = findingIn(await fileText());
      expect(finding.state).toBe('denied');
      expect(finding.denial).toMatchObject({ by: 'human', at: AT });
    });

    it('records the mandate as the reason', async () => {
      await runDocket(['--deny', 'AC-1', `--mandate=${MANDATE}`], deps());

      expect(findingIn(await fileText()).denial?.reason).toBe(RELAYED);
    });

    it('leaves the body bytes exactly as they were', async () => {
      const before = parts(await fileText()).body;

      await runDocket(['--deny', 'AC-1', `--mandate=${MANDATE}`], deps());

      expect(parts(await fileText()).body).toBe(before);
    });

    it('leaves a finding that still validates', async () => {
      await runDocket(['--deny', 'AC-1', `--mandate=${MANDATE}`], deps());

      expect(validateFinding(findingIn(await fileText()), 'structural')).toEqual([]);
    });
  });

  describe('--unblock', () => {
    it('hands the work back with the answer attributed to the human', async () => {
      await block();

      expect(await runDocket(['--unblock', 'AC-1', `--mandate=${MANDATE}`], deps())).toBe(0);

      const finding = findingIn(await fileText());
      expect(finding.progress.status).toBe('not-started');
      expect(finding.progress.notes.at(-1)).toEqual({ at: AT, by: 'human', text: RELAYED });
    });

    it('keeps the note the block was raised in', async () => {
      await block();

      await runDocket(['--unblock', 'AC-1', `--mandate=${MANDATE}`], deps());

      expect(findingIn(await fileText()).progress.notes).toMatchObject([
        { by: 'agent', text: 'the schema change has not landed' },
        { by: 'human', text: RELAYED },
      ]);
    });

    it('leaves the body bytes exactly as they were', async () => {
      await block();
      const before = parts(await fileText()).body;

      await runDocket(['--unblock', 'AC-1', `--mandate=${MANDATE}`], deps());

      expect(parts(await fileText()).body).toBe(before);
    });

    it('leaves a finding that still validates', async () => {
      await block();

      await runDocket(['--unblock', 'AC-1', `--mandate=${MANDATE}`], deps());

      expect(validateFinding(findingIn(await fileText()), 'structural')).toEqual([]);
    });
  });

  it('reports a refusal and writes nothing', async () => {
    const before = await fileText();

    const code = await runDocket(['--unblock', 'AC-1', `--mandate=${MANDATE}`], deps());

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('invalid-transition');
    expect(await fileText()).toBe(before);
  });
});
