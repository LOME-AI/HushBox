import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as atomicRename from '@hushbox/shared/atomic-rename';
import { appendLedger, createStatus, loadStatus, saveStatus, withStatusLock } from './store.js';

/**
 * Seals the directory the write is landing in and then fails. Sealing is what
 * makes the clean-up after a failed write genuinely unable to unlink, and no
 * filesystem state produces that on its own: the staging file is written while
 * the directory is still writable, and the only moment between that write and
 * the clean-up belongs to the rename.
 */
function sealTheDirectoryAndFail(): void {
  vi.spyOn(atomicRename, 'renameWithRetry').mockImplementationOnce((_from, to) => {
    chmodSync(path.dirname(to), 0o555);
    return Promise.reject(Object.assign(new Error('cross-device link'), { code: 'EXDEV' }));
  });
}

const EMPTY = `# Status — run\n\n📊 start\n\n| ✅ done | 🔧 in-flight | ⏸ blocked | ⬜ queued | ❓ open |\n| --- | --- | --- | --- | --- |\n| 0 | none | none | 0 | 0 (0 blocking) |\n\n## Open\n\n## Answered\n`;

const START = { stamp: 'start', done: '0', inFlight: 'none', blocked: 'none', queued: '0' };

let runDir: string;

beforeEach(() => {
  runDir = mkdtempSync(path.join(tmpdir(), 'cards-store-'));
  writeFileSync(path.join(runDir, 'status.md'), EMPTY);
  writeFileSync(path.join(runDir, 'ledger.md'), '# Ledger\n\n- opened\n');
});

afterEach(() => {
  rmSync(runDir, { recursive: true, force: true });
});

describe('loadStatus and saveStatus', () => {
  it('round-trips the file through the model', async () => {
    const file = await loadStatus(runDir);
    await saveStatus(runDir, { ...file, chart: { ...file.chart, stamp: 'after T01' } });
    expect(readFileSync(path.join(runDir, 'status.md'), 'utf8')).toContain('📊 after T01');
  });

  it('names the run directory when status.md is absent', async () => {
    rmSync(path.join(runDir, 'status.md'));
    await expect(loadStatus(runDir)).rejects.toThrow(/status\.md/);
  });

  it('passes through a read failure that is not absence', async () => {
    rmSync(path.join(runDir, 'status.md'));
    mkdirSync(path.join(runDir, 'status.md'));
    await expect(loadStatus(runDir)).rejects.toThrow(/EISDIR/);
  });

  it('clears its staging file away when the write cannot land', async () => {
    const file = await loadStatus(runDir);
    rmSync(path.join(runDir, 'status.md'));
    mkdirSync(path.join(runDir, 'status.md'));

    await expect(saveStatus(runDir, file)).rejects.toThrow();

    expect(readdirSync(runDir).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('names the failure that stopped the write rather than the one met clearing up', async () => {
    const file = await loadStatus(runDir);
    sealTheDirectoryAndFail();

    try {
      await expect(saveStatus(runDir, file)).rejects.toMatchObject({ cause: { code: 'EXDEV' } });
    } finally {
      chmodSync(runDir, 0o700);
    }
  });
});

describe('createStatus', () => {
  it('writes the model where no status file exists', async () => {
    rmSync(path.join(runDir, 'status.md'));
    const file = { title: 'fresh', chart: START, open: [], answered: [] };

    await createStatus(runDir, file);

    expect(readFileSync(path.join(runDir, 'status.md'), 'utf8')).toBe(
      EMPTY.replace('# Status — run', '# Status — fresh')
    );
  });

  it('passes through a write failure that is not an existing file', async () => {
    const file = { title: 'fresh', chart: START, open: [], answered: [] };

    await expect(createStatus(path.join(runDir, 'missing'), file)).rejects.toThrow(/ENOENT/);
  });

  it('refuses a run that already has one, naming the file it left alone', async () => {
    const file = { title: 'fresh', chart: START, open: [], answered: [] };

    await expect(createStatus(runDir, file)).rejects.toThrow(/status\.md/);

    expect(readFileSync(path.join(runDir, 'status.md'), 'utf8')).toBe(EMPTY);
  });
});

describe('appendLedger', () => {
  it('appends one line to ledger.md', async () => {
    await appendLedger(runDir, '- Q1 ruled: "yes" → Work: T01');
    expect(readFileSync(path.join(runDir, 'ledger.md'), 'utf8')).toBe(
      '# Ledger\n\n- opened\n- Q1 ruled: "yes" → Work: T01\n'
    );
  });

  it('refuses a run without a ledger rather than creating one', async () => {
    writeFileSync(path.join(runDir, 'ledger.md'), '');
    await appendLedger(runDir, '- first');
    expect(readFileSync(path.join(runDir, 'ledger.md'), 'utf8')).toBe('- first\n');
    writeFileSync(path.join(runDir, 'ledger.md'), '- no newline');
    await appendLedger(runDir, '- second');
    expect(readFileSync(path.join(runDir, 'ledger.md'), 'utf8')).toBe('- no newline\n- second\n');

    rmSync(path.join(runDir, 'ledger.md'));
    await expect(appendLedger(runDir, '- x')).rejects.toThrow(/ledger\.md/);
  });
});

describe('withStatusLock', () => {
  it('runs the action and releases the lock', async () => {
    const result = await withStatusLock(runDir, () => Promise.resolve(42));
    expect(result).toBe(42);
    await expect(withStatusLock(runDir, () => Promise.resolve('again'))).resolves.toBe('again');
  });

  it('releases the lock when the action throws', async () => {
    await expect(withStatusLock(runDir, () => Promise.reject(new Error('boom')))).rejects.toThrow(
      'boom'
    );
    await expect(withStatusLock(runDir, () => Promise.resolve('free'))).resolves.toBe('free');
  });

  it('waits for a held lock and then refuses, naming the lock file', async () => {
    await expect(
      withStatusLock(path.join(runDir, 'missing'), () => Promise.resolve(0))
    ).rejects.toThrow(/ENOENT/);

    writeFileSync(path.join(runDir, 'status.md.lock'), '');
    await expect(
      withStatusLock(runDir, () => Promise.resolve(0), { attempts: 2, waitMs: 1 })
    ).rejects.toThrow(/status\.md\.lock/);
  });
});
