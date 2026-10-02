import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAuditFixture, findingFile } from '../test-utils/audit-fixture';
import { runValidate } from './validate';
import type { AuditFixture } from '../test-utils/audit-fixture';

describe('runValidate', () => {
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

  async function corrupt(id: string, contents: string): Promise<void> {
    await fs.writeFile(path.join(fixture.findingsDir, `${id}.md`), contents);
  }

  it('exits zero on a clean audit', async () => {
    expect(await runValidate({ kind: 'validate', audit: null }, deps())).toBe(0);
  });

  it('reports how much it checked when the audit is clean', async () => {
    await runValidate({ kind: 'validate', audit: null }, deps());
    expect(out.join('\n')).toContain('2 findings');
  });

  it('exits non-zero when a finding breaks a structural invariant', async () => {
    await corrupt('AC-1', findingFile('AC-1', { state: 'ruled' }));
    expect(await runValidate({ kind: 'validate', audit: null }, deps())).toBe(1);
  });

  it('names the finding and the violated invariant', async () => {
    await corrupt('AC-1', findingFile('AC-1', { state: 'ruled' }));
    await runValidate({ kind: 'validate', audit: null }, deps());
    expect(err.join('\n')).toContain('AC-1: ruled-state-without-ruling');
  });

  it('lists every violation in one finding, not just the first', async () => {
    await corrupt(
      'AC-1',
      findingFile('AC-1', { state: 'ruled' }).replace('id: "AC-1"', 'id: "AC 1"')
    );
    await runValidate({ kind: 'validate', audit: null }, deps());
    expect(err.join('\n')).toContain('unsanitized-id');
    expect(err.join('\n')).toContain('ruled-state-without-ruling');
  });

  it('counts the violations it found', async () => {
    await corrupt('AC-1', findingFile('AC-1', { state: 'ruled' }));
    await corrupt('AC-2', findingFile('AC-2', { state: 'ruled' }));
    await runValidate({ kind: 'validate', audit: null }, deps());
    expect(err.join('\n')).toContain('2 violations');
  });

  it('reports a file it cannot parse at all', async () => {
    await corrupt('AC-1', 'no frontmatter here');
    expect(await runValidate({ kind: 'validate', audit: null }, deps())).toBe(1);
    expect(err.join('\n')).toContain('AC-1');
  });

  it('validates the audit the pin names', async () => {
    await corrupt('AC-1', findingFile('AC-1', { state: 'ruled' }));
    expect(await runValidate({ kind: 'validate', audit: '2026-07-30' }, deps())).toBe(1);
  });
});
