import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { parseFinding } from '@hushbox/docket';
import { SECTIONS } from '../components/shell/logic/sections';
import { createAuditFixture, findingFile } from '../test-utils/audit-fixture';
import { runList } from './list';
import type { ListCommand } from './parse-command';
import type { AuditFixture } from '../test-utils/audit-fixture';

const BASE: ListCommand = {
  kind: 'list',
  audit: null,
  brief: false,
  contest: false,
  id: null,
  state: null,
  section: null,
  area: null,
  severity: null,
  progress: null,
};

const RULING =
  'ruling:\n  option: "A"\n  text: "Do it the narrow way."\n  note: null\n  at: "2026-07-30"';

function ruled(id: string, status: string): string {
  return findingFile(id, { state: 'ruled' })
    .replace('ruling: null', RULING)
    .replace('status: "not-started"', `status: "${status}"`);
}

describe('runList', () => {
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

  function deps(): { repoRoot: string; out: (line: string) => void; err: (line: string) => void } {
    return {
      repoRoot: fixture.root,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    };
  }

  async function write(id: string, contents: string): Promise<void> {
    await fs.writeFile(path.join(fixture.findingsDir, `${id}.md`), contents);
  }

  it('exits zero', async () => {
    expect(await runList(BASE, deps())).toBe(0);
  });

  it('prints one line per finding', async () => {
    await runList(BASE, deps());
    expect(out).toHaveLength(2);
  });

  it('puts the id, state, severity, area and title on the line', async () => {
    await runList(BASE, deps());
    expect(out[0]).toMatch(/^AC-1 +open +medium +unknown +AC-1 needs a decision$/);
  });

  it('keeps a long title whole rather than truncating it', async () => {
    const title = 'x'.repeat(738);
    await write('AC-1', findingFile('AC-1', { title }));
    await runList(BASE, deps());
    expect(out[0]).toContain(title);
  });

  describe('a dedicated finding', () => {
    beforeEach(async () => {
      await write('AC-1', findingFile('AC-1', { dedicated: true }));
    });

    it('is left out of a listing that did not ask for it', async () => {
      expect(await runList(BASE, deps())).toBe(0);
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-2');
    });

    it('is listed under its own section', async () => {
      await runList({ ...BASE, section: 'dedicated' }, deps());
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-1');
    });

    it('is listed when it is named by its id', async () => {
      await runList({ ...BASE, id: 'AC-1' }, deps());
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-1');
    });

    it('is left out of an intake queue, which is where its own predicate excludes it', async () => {
      await runList({ ...BASE, section: 'open' }, deps());
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-2');
    });

    /**
     * A named section answers through that section's own predicate and nothing
     * else, so the CLI and the console hold the same findings under the same tab
     * by construction. A second rule here is how the two drift, and the help
     * text promises the blocked case by name.
     */
    it('is listed under --section=blocked when it is blocked', async () => {
      await write('AC-1', ruled('AC-1', 'blocked').replace('dedicated: false', 'dedicated: true'));
      await runList({ ...BASE, section: 'blocked' }, deps());
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-1');
    });

    it('is listed under --section=questions when a question is waiting on it', async () => {
      await write(
        'AC-1',
        findingFile('AC-1', { dedicated: true }).replace(
          'questions: []',
          'questions:\n  - { at: "2026-07-30", text: "Which epoch?", answer: null, answered_at: null }'
        )
      );
      await runList({ ...BASE, section: 'questions' }, deps());
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-1');
    });

    it('is listed under --section=progress once it carries a ruling', async () => {
      await write(
        'AC-1',
        ruled('AC-1', 'in-progress').replace('dedicated: false', 'dedicated: true')
      );
      await runList({ ...BASE, section: 'progress' }, deps());
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-1');
    });

    it('answers every named section exactly as the console predicate does', async () => {
      const contents = ruled('AC-1', 'blocked').replace('dedicated: false', 'dedicated: true');
      await write('AC-1', contents);
      const parsed = parseFinding(contents, 'AC-1.md');
      if (!parsed.ok) throw new Error('the fixture finding no longer parses');

      for (const section of SECTIONS.filter((candidate) => !candidate.wholeAudit)) {
        out.length = 0;
        await runList({ ...BASE, section: section.id }, deps());
        expect([section.id, out.some((line) => line.startsWith('AC-1'))]).toEqual([
          section.id,
          section.holds(parsed.value),
        ]);
      }
    });

    it('leaves the findings around it listed as before', async () => {
      await runList({ ...BASE, section: 'dedicated' }, deps());
      out.length = 0;
      await runList(BASE, deps());
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-2');
    });
  });

  it('filters by state', async () => {
    await write(
      'AC-1',
      findingFile('AC-1', { state: 'denied' }).replace(
        'denial: null',
        'denial:\n  by: "audit"\n  reason: null\n  at: "2026-07-30"'
      )
    );
    await runList({ ...BASE, state: 'denied' }, deps());
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('AC-1');
  });

  it('filters by area', async () => {
    await write('AC-1', findingFile('AC-1').replace('area: "unknown"', 'area: "apps/api"'));
    await runList({ ...BASE, area: 'apps/api' }, deps());
    expect(out).toHaveLength(1);
  });

  it('filters by area under the same family names the console offers', async () => {
    await write(
      'AC-1',
      findingFile('AC-1').replace('area: "unknown"', 'area: "`apps/api` conversations slice"')
    );
    await runList({ ...BASE, area: 'apps/api' }, deps());
    expect(out).toHaveLength(1);
  });

  it('keeps one package out of another under the same directory', async () => {
    await write(
      'AC-1',
      findingFile('AC-1').replace('area: "unknown"', 'area: "apps/web lib auth"')
    );
    expect(await runList({ ...BASE, area: 'apps/api' }, deps())).toBe(0);
    expect(out).toHaveLength(0);
  });

  it('filters by severity', async () => {
    await write('AC-1', findingFile('AC-1').replace('severity: "medium"', 'severity: "critical"'));
    await runList({ ...BASE, severity: 'critical' }, deps());
    expect(out).toHaveLength(1);
  });

  it('filters by progress status', async () => {
    await write('AC-1', findingFile('AC-1').replace('status: "not-started"', 'status: "done"'));
    await runList({ ...BASE, progress: 'done' }, deps());
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('AC-1');
  });

  describe('--section', () => {
    it('reads the blocked queue', async () => {
      await write('AC-1', ruled('AC-1', 'blocked'));
      await write('AC-2', ruled('AC-2', 'in-progress'));
      await runList({ ...BASE, section: 'blocked' }, deps());
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-1');
    });

    it('leaves a blocked finding out of the ruled queue, as the console does', async () => {
      await write('AC-1', ruled('AC-1', 'blocked'));
      await write('AC-2', ruled('AC-2', 'in-progress'));
      await runList({ ...BASE, section: 'ruled' }, deps());
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-2');
    });

    it('keeps a blocked finding on the progress board, which is a different queue', async () => {
      await write('AC-1', ruled('AC-1', 'blocked'));
      await write('AC-2', ruled('AC-2', 'in-progress'));
      await runList({ ...BASE, section: 'progress' }, deps());
      expect(out).toHaveLength(2);
    });

    it('reads the questions queue by the answer still owed, not by a state', async () => {
      await write(
        'AC-1',
        findingFile('AC-1').replace(
          'questions: []',
          'questions:\n  - { at: "2026-07-30", text: "Which epoch?", answer: null, answered_at: null }'
        )
      );
      await runList({ ...BASE, section: 'questions' }, deps());
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-1');
    });

    it('takes a finding with an unanswered question out of the open queue', async () => {
      await write(
        'AC-1',
        findingFile('AC-1').replace(
          'questions: []',
          'questions:\n  - { at: "2026-07-30", text: "Which epoch?", answer: null, answered_at: null }'
        )
      );
      await runList({ ...BASE, section: 'open' }, deps());
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-2');
    });

    it('composes with the other filters', async () => {
      await write('AC-1', ruled('AC-1', 'blocked'));
      await write(
        'AC-2',
        ruled('AC-2', 'blocked').replace('severity: "medium"', 'severity: "critical"')
      );
      await runList({ ...BASE, section: 'blocked', severity: 'critical' }, deps());
      expect(out).toHaveLength(1);
      expect(out[0]).toContain('AC-2');
    });

    it('composes with the brief', async () => {
      await write('AC-1', ruled('AC-1', 'blocked'));
      await runList({ ...BASE, section: 'blocked', brief: true }, deps());
      expect(out[0]).toContain('Ruling: option A');
    });
  });

  it('selects one finding by its id', async () => {
    expect(await runList({ ...BASE, id: 'AC-2' }, deps())).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('AC-2');
  });

  it('fails on an id no finding carries', async () => {
    expect(await runList({ ...BASE, id: 'ZZ-9' }, deps())).toBe(1);
    expect(out).toHaveLength(0);
    expect(err.join('\n')).toContain('no finding "ZZ-9"');
  });

  it('lists the ruled findings that have not been started', async () => {
    await write('AC-1', ruled('AC-1', 'not-started'));
    await write('AC-3', ruled('AC-3', 'done'));
    await runList({ ...BASE, brief: true, state: 'ruled', progress: 'not-started' }, deps());
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('AC-1');
  });

  it('applies every filter at once', async () => {
    await write('AC-1', findingFile('AC-1').replace('area: "unknown"', 'area: "apps/api"'));
    await runList({ ...BASE, area: 'apps/api', severity: 'medium', state: 'open' }, deps());
    expect(out).toHaveLength(1);
  });

  it('says so when nothing matches', async () => {
    expect(await runList({ ...BASE, area: 'apps/web' }, deps())).toBe(0);
    expect(out).toHaveLength(0);
    expect(err.join('\n')).toContain('no findings match');
  });

  it('emits the implementation brief under --brief', async () => {
    await runList({ ...BASE, brief: true }, deps());
    expect(out[0]).toContain('Option A: Apply the proposed behavior as written');
  });

  it('carries the ruling text and note into the brief', async () => {
    await write(
      'AC-1',
      findingFile('AC-1', { state: 'ruled' }).replace(
        'ruling: null',
        'ruling:\n  option: "A"\n  text: "Do it the narrow way."\n  note: "Sequence it after the epoch work."\n  at: "2026-07-30"'
      )
    );
    await runList({ ...BASE, brief: true, state: 'ruled' }, deps());
    expect(out[0]).toContain('Do it the narrow way.');
    expect(out[0]).toContain('Note: Sequence it after the epoch work.');
  });

  it('separates one brief from the next', async () => {
    await runList({ ...BASE, brief: true }, deps());
    expect(out).toHaveLength(3);
    expect(out[1]).toBe('---');
  });

  describe('--contest', () => {
    beforeEach(async () => {
      await write(
        'AC-1',
        ruled('AC-1', 'blocked').replace(
          '### A — Apply the proposed behavior as written',
          '### B — Leave it alone\n\nDo nothing.\n\n### A — Apply the proposed behavior as written'
        )
      );
    });

    it('carries the option the ruling passed over', async () => {
      await runList({ ...BASE, contest: true, id: 'AC-1' }, deps());
      expect(out[0]).toContain('Option B: Leave it alone');
    });

    it('marks the option that was ruled', async () => {
      await runList({ ...BASE, contest: true, id: 'AC-1' }, deps());
      expect(out[0]).toContain('Option A: [ruled]');
    });

    it('still leads with the ruling', async () => {
      await runList({ ...BASE, contest: true, id: 'AC-1' }, deps());
      const contested = out[0] ?? '';
      expect(contested.indexOf('Ruling: option A')).toBeLessThan(contested.indexOf('Option A:'));
    });

    it('separates one contested finding from the next, as the brief does', async () => {
      await write('AC-2', ruled('AC-2', 'blocked'));
      await runList({ ...BASE, contest: true }, deps());
      expect(out).toHaveLength(3);
      expect(out[1]).toBe('---');
    });

    it('leaves the plain brief showing only the chosen option', async () => {
      await runList({ ...BASE, brief: true, id: 'AC-1' }, deps());
      expect(out[0]).not.toContain('Leave it alone');
      expect(out[0]).not.toContain('[ruled]');
    });
  });

  it('lists the audit the pin names', async () => {
    expect(await runList({ ...BASE, audit: '2026-07-30' }, deps())).toBe(0);
    expect(out).toHaveLength(2);
  });
});
