import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { readSource } from './source.ts';
import { DAY_MS, MINUTE_MS } from './durations.ts';

let root: string;
let outside: string;

const AUDIT_DATE = isoAt(TEST_DAY_START).slice(0, 10);

async function write(relative: string, content: string): Promise<string> {
  const full = path.join(root, relative);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
  return full;
}

function numberedLines(count: number): string {
  return Array.from({ length: count }, (_, index) => `line ${String(index + 1)}`).join('\n');
}

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'docket-source-')));
  outside = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'docket-outside-')));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

describe('readSource containment', () => {
  it('refuses a path escaping the root with ..', async () => {
    await fs.writeFile(path.join(outside, 'secret.txt'), 'private');
    const result = await readSource(root, {
      path: `../${path.basename(outside)}/secret.txt`,
      start: 1,
      auditDate: AUDIT_DATE,
    });
    expect(result).toEqual({ ok: false, error: 'outside-root' });
  });

  it('refuses a path escaping the root through an inner ..', async () => {
    const result = await readSource(root, {
      path: 'src/../../etc/passwd',
      start: 1,
      auditDate: AUDIT_DATE,
    });
    expect(result).toEqual({ ok: false, error: 'outside-root' });
  });

  it('refuses an absolute path', async () => {
    await write('src/inside.ts', 'const a = 1;');
    const result = await readSource(root, {
      path: path.join(root, 'src/inside.ts'),
      start: 1,
      auditDate: AUDIT_DATE,
    });
    expect(result).toEqual({ ok: false, error: 'outside-root' });
  });

  it('refuses a symlink whose target is outside the root', async () => {
    const target = path.join(outside, 'secret.txt');
    await fs.writeFile(target, 'private');
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    await fs.symlink(target, path.join(root, 'src/leak.ts'));

    const result = await readSource(root, {
      path: 'src/leak.ts',
      start: 1,
      auditDate: AUDIT_DATE,
    });
    expect(result).toEqual({ ok: false, error: 'outside-root' });
  });

  it('reads a symlink whose target is inside the root', async () => {
    await write('src/real.ts', 'const a = 1;');
    await fs.symlink(path.join(root, 'src/real.ts'), path.join(root, 'src/alias.ts'));

    const result = await readSource(root, {
      path: 'src/alias.ts',
      start: 1,
      auditDate: AUDIT_DATE,
    });
    if (!result.ok) throw new Error('expected the read to be allowed');
    expect(result.value.lines).toEqual(['const a = 1;']);
  });

  it('refuses a directory traversal that lands back inside only after a symlink hop', async () => {
    await fs.mkdir(path.join(outside, 'nested'), { recursive: true });
    await fs.writeFile(path.join(outside, 'nested/secret.txt'), 'private');
    await fs.symlink(path.join(outside, 'nested'), path.join(root, 'linked'));

    const result = await readSource(root, {
      path: 'linked/secret.txt',
      start: 1,
      auditDate: AUDIT_DATE,
    });
    expect(result).toEqual({ ok: false, error: 'outside-root' });
  });
});

describe('readSource window', () => {
  it('returns six lines of context either side of a single line', async () => {
    await write('src/file.ts', numberedLines(40));
    const result = await readSource(root, {
      path: 'src/file.ts',
      start: 20,
      auditDate: AUDIT_DATE,
    });
    if (!result.ok) throw new Error('expected a window');
    expect(result.value.start).toBe(14);
    expect(result.value.end).toBe(26);
    expect(result.value.lines).toHaveLength(13);
    expect(result.value.lines[6]).toBe('line 20');
  });

  it('returns six lines of context either side of a range', async () => {
    await write('src/file.ts', numberedLines(80));
    const result = await readSource(root, {
      path: 'src/file.ts',
      start: 30,
      end: 34,
      auditDate: AUDIT_DATE,
    });
    if (!result.ok) throw new Error('expected a window');
    expect(result.value.start).toBe(24);
    expect(result.value.end).toBe(40);
  });

  it('clamps the context to the start of the file', async () => {
    await write('src/file.ts', numberedLines(40));
    const result = await readSource(root, { path: 'src/file.ts', start: 2, auditDate: AUDIT_DATE });
    if (!result.ok) throw new Error('expected a window');
    expect(result.value.start).toBe(1);
    expect(result.value.lines[0]).toBe('line 1');
  });

  it('caps the window at 200 lines', async () => {
    await write('src/file.ts', numberedLines(600));
    const result = await readSource(root, {
      path: 'src/file.ts',
      start: 10,
      end: 500,
      auditDate: AUDIT_DATE,
    });
    if (!result.ok) throw new Error('expected a window');
    expect(result.value.lines).toHaveLength(200);
    expect(result.value.start).toBe(4);
    expect(result.value.end).toBe(203);
  });

  it('returns the closest window when the line is past the end of the file', async () => {
    await write('src/file.ts', numberedLines(10));
    const result = await readSource(root, {
      path: 'src/file.ts',
      start: 900,
      auditDate: AUDIT_DATE,
    });
    if (!result.ok) throw new Error('expected a window');
    expect(result.value.start).toBe(4);
    expect(result.value.end).toBe(10);
    expect(result.value.lines.at(-1)).toBe('line 10');
  });

  it('reports the requested range alongside the window', async () => {
    await write('src/file.ts', numberedLines(10));
    const result = await readSource(root, {
      path: 'src/file.ts',
      start: 900,
      end: 950,
      auditDate: AUDIT_DATE,
    });
    if (!result.ok) throw new Error('expected a window');
    expect(result.value.requestedStart).toBe(900);
    expect(result.value.requestedEnd).toBe(950);
  });

  it('reads an empty file as an empty window', async () => {
    await write('src/empty.ts', '');
    const result = await readSource(root, {
      path: 'src/empty.ts',
      start: 1,
      auditDate: AUDIT_DATE,
    });
    if (!result.ok) throw new Error('expected a window');
    expect(result.value.lines).toEqual([]);
    expect(result.value.exists).toBe(true);
  });

  it('rejects a start line below one', async () => {
    await write('src/file.ts', numberedLines(10));
    const result = await readSource(root, { path: 'src/file.ts', start: 0, auditDate: AUDIT_DATE });
    expect(result).toEqual({ ok: false, error: 'invalid-range' });
  });

  it('rejects an end line before the start', async () => {
    await write('src/file.ts', numberedLines(10));
    const result = await readSource(root, {
      path: 'src/file.ts',
      start: 5,
      end: 4,
      auditDate: AUDIT_DATE,
    });
    expect(result).toEqual({ ok: false, error: 'invalid-range' });
  });
});

describe('readSource file state', () => {
  it('reports a missing file rather than failing', async () => {
    const result = await readSource(root, { path: 'src/gone.ts', start: 1, auditDate: AUDIT_DATE });
    if (!result.ok) throw new Error('a missing file is not an error');
    expect(result.value.exists).toBe(false);
    expect(result.value.lines).toEqual([]);
    expect(result.value.stale).toBe(false);
  });

  it('reports a directory as missing rather than reading it', async () => {
    await fs.mkdir(path.join(root, 'src'), { recursive: true });
    const result = await readSource(root, { path: 'src', start: 1, auditDate: AUDIT_DATE });
    if (!result.ok) throw new Error('a directory is not an error');
    expect(result.value.exists).toBe(false);
  });

  it('marks a file modified after the audit day as stale', async () => {
    const full = await write('src/file.ts', numberedLines(10));
    const afterTheAuditDay = new Date(TEST_DAY_START + 3 * DAY_MS);
    await fs.utimes(full, afterTheAuditDay, afterTheAuditDay);
    const result = await readSource(root, { path: 'src/file.ts', start: 1, auditDate: AUDIT_DATE });
    if (!result.ok) throw new Error('expected a window');
    expect(result.value.stale).toBe(true);
  });

  it('does not mark a file modified during the audit day as stale', async () => {
    const full = await write('src/file.ts', numberedLines(10));
    const lastMinute = new Date(TEST_DAY_START + DAY_MS - MINUTE_MS);
    await fs.utimes(full, lastMinute, lastMinute);
    const result = await readSource(root, { path: 'src/file.ts', start: 1, auditDate: AUDIT_DATE });
    if (!result.ok) throw new Error('expected a window');
    expect(result.value.stale).toBe(false);
  });

  it('does not call a file stale against an audit date it cannot read', async () => {
    await write('src/file.ts', numberedLines(10));
    const result = await readSource(root, { path: 'src/file.ts', start: 1, auditDate: 'unknown' });
    if (!result.ok) throw new Error('expected a window');
    expect(result.value.stale).toBe(false);
  });

  it('reports the repo-relative path it read', async () => {
    await write('src/file.ts', numberedLines(10));
    const result = await readSource(root, {
      path: './src/file.ts',
      start: 1,
      auditDate: AUDIT_DATE,
    });
    if (!result.ok) throw new Error('expected a window');
    expect(result.value.path).toBe('src/file.ts');
  });
});
