import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAuditFixture, findingFile } from '../test-utils/audit-fixture';
import { runCensus } from './census';
import type { CliDeps } from './deps';
import type { CensusCommand } from './parse-command';
import type { AuditFixture } from '../test-utils/audit-fixture';

const BASE: CensusCommand = {
  kind: 'census',
  audit: null,
  id: null,
  state: null,
  section: null,
  area: null,
  severity: null,
  progress: null,
};

/** Three lines live at `src/inside.ts`, so line 99 is past the end of it. */
const PAST_END = `**What it is.** Something at \`src/inside.ts:99\`.

## Options

### A — Apply the proposed behavior as written
**Recommended**

And something at \`src/gone.ts:1\`.
`;

describe('runCensus', () => {
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

  async function write(id: string, contents: string): Promise<void> {
    await fs.writeFile(path.join(fixture.findingsDir, `${id}.md`), contents);
  }

  async function withDeadCitations(id = 'AC-1'): Promise<void> {
    await write(id, findingFile(id, { body: PAST_END }));
  }

  it('exits zero on a corpus whose citations all resolve', async () => {
    expect(await runCensus(BASE, deps())).toBe(0);
  });

  it('still reports the totals when nothing is dead', async () => {
    await runCensus(BASE, deps());
    expect(out.join('\n')).toContain('dead 0');
  });

  it('names the finding holding a dead citation', async () => {
    await withDeadCitations();
    await runCensus(BASE, deps());
    expect(out.join('\n')).toContain('AC-1');
  });

  it('puts the finding state beside its id', async () => {
    await withDeadCitations();
    await runCensus(BASE, deps());
    expect(out[0]).toMatch(/^AC-1 +open$/);
  });

  it('leaves out a finding whose citations all resolve', async () => {
    await withDeadCitations();
    await runCensus(BASE, deps());
    expect(out.join('\n')).not.toContain('AC-2');
  });

  it('writes the citation as the finding writes it', async () => {
    await withDeadCitations();
    await runCensus(BASE, deps());
    expect(out.join('\n')).toContain('src/inside.ts:99');
  });

  it('names the zone the citation sits in', async () => {
    await withDeadCitations();
    await runCensus(BASE, deps());
    expect(out.join('\n')).toContain('explainer');
  });

  it('names the option a cited option carries', async () => {
    await withDeadCitations();
    await runCensus(BASE, deps());
    expect(out.join('\n')).toContain('option A');
  });

  it('gives the reason the citation is dead', async () => {
    await withDeadCitations();
    await runCensus(BASE, deps());
    expect(out.join('\n')).toContain('past-end-of-file');
  });

  it('gives the file the citation resolved to', async () => {
    await withDeadCitations();
    await runCensus(BASE, deps());
    const past = out.find((line) => line.includes('past-end-of-file'));
    expect(past).toMatch(/src\/inside\.ts$/);
  });

  it('says so when a citation resolved to no file at all', async () => {
    await withDeadCitations();
    await runCensus(BASE, deps());
    const missing = out.find((line) => line.includes('src/gone.ts'));
    expect(missing).toContain('(unresolved)');
  });

  it('counts the dead citations in the totals', async () => {
    await withDeadCitations();
    await runCensus(BASE, deps());
    expect(out.join('\n')).toContain('dead 2');
  });

  describe('a dedicated finding', () => {
    beforeEach(async () => {
      await write('AC-1', findingFile('AC-1', { dedicated: true, body: PAST_END }));
    });

    it('is left out of a census that did not ask for it', async () => {
      await runCensus(BASE, deps());
      expect(out.join('\n')).not.toContain('src/inside.ts:99');
    });

    it('is censused under its own section', async () => {
      await runCensus({ ...BASE, section: 'dedicated' }, deps());
      expect(out.join('\n')).toContain('src/inside.ts:99');
    });

    it('is censused when it is named by its id', async () => {
      await runCensus({ ...BASE, id: 'AC-1' }, deps());
      expect(out.join('\n')).toContain('src/inside.ts:99');
    });

    it('leaves the citations of the finding beside it counted as before', async () => {
      await withDeadCitations('AC-2');
      await runCensus(BASE, deps());
      expect(out.join('\n')).toContain('AC-2');
      expect(out.join('\n')).toContain('findings 1');
    });
  });

  it('counts the findings holding them', async () => {
    await withDeadCitations();
    await withDeadCitations('AC-2');
    await runCensus(BASE, deps());
    expect(out.join('\n')).toContain('findings 2');
  });

  it('tallies the reasons', async () => {
    await withDeadCitations();
    await runCensus(BASE, deps());
    expect(out.join('\n')).toContain('past-end-of-file 1');
  });

  it('reports the clickable zones separately from every zone', async () => {
    await withDeadCitations();
    await runCensus(BASE, deps());
    expect(out.join('\n')).toContain('clickable');
  });

  it('scopes the census to one filter', async () => {
    await withDeadCitations();
    await withDeadCitations('AC-2');
    await runCensus({ ...BASE, id: 'AC-1' }, deps());
    expect(out.join('\n')).not.toContain('AC-2');
  });

  it('scopes the census by state', async () => {
    await withDeadCitations();
    await write('AC-2', findingFile('AC-2', { state: 'denied', body: PAST_END }));
    await runCensus({ ...BASE, state: 'denied' }, deps());
    expect(out.join('\n')).not.toContain('AC-1');
  });

  it('scopes the census to one of the console’s queues', async () => {
    await write('AC-1', findingFile('AC-1', { state: 'ruled', body: PAST_END }));
    await write('AC-2', findingFile('AC-2', { body: PAST_END }));
    await runCensus({ ...BASE, section: 'open' }, deps());
    expect(out.join('\n')).not.toContain('AC-1');
    expect(out.join('\n')).toContain('AC-2');
  });

  it('fails on an id no finding carries', async () => {
    expect(await runCensus({ ...BASE, id: 'ZZ-9' }, deps())).toBe(1);
    expect(err.join('\n')).toContain('no finding "ZZ-9"');
  });

  it('censuses the audit the pin names', async () => {
    expect(await runCensus({ ...BASE, audit: '2026-07-30' }, deps())).toBe(0);
  });
});
