/* eslint-disable @typescript-eslint/require-await -- fake executor methods intentionally async to satisfy SqlExecutor's Promise contract */
import { describe, it, expect, vi } from 'vitest';
import {
  buildInstallStatements,
  installDevOnlyTracking,
  readMeta,
  markClean,
  type SqlExecutor,
  type StackMeta,
} from './stack-meta.js';

function fakeExecutor(): { executor: SqlExecutor; execCalls: string[]; queryCalls: string[] } {
  const execCalls: string[] = [];
  const queryCalls: string[] = [];
  let queryResult: unknown[] = [];
  return {
    execCalls,
    queryCalls,
    executor: {
      async exec(sql) {
        execCalls.push(sql);
      },
      async query<T>(sql: string): Promise<T[]> {
        queryCalls.push(sql);
        return queryResult as T[];
      },
      // Test hooks (not part of SqlExecutor, exposed for tests via cast)

      __setQueryResult(rows: unknown[]) {
        queryResult = rows;
      },
    } as SqlExecutor & { __setQueryResult: (r: unknown[]) => void },
  };
}

describe('buildInstallStatements', () => {
  it('emits CREATE TABLE IF NOT EXISTS __stack_meta first', () => {
    const stmts = buildInstallStatements(['users']);
    expect(stmts[0]).toMatch(/CREATE TABLE IF NOT EXISTS\s+"?__stack_meta"?/);
  });

  it('emits an idempotent insert of the singleton row', () => {
    const stmts = buildInstallStatements(['users']);
    expect(
      stmts.some((s) => /INSERT INTO\s+"?__stack_meta"?[\s\S]+ON CONFLICT DO NOTHING/.test(s))
    ).toBe(true);
  });

  it('emits CREATE OR REPLACE FUNCTION __stack_mark_dirty', () => {
    const stmts = buildInstallStatements(['users']);
    expect(stmts.some((s) => /CREATE OR REPLACE FUNCTION\s+"?__stack_mark_dirty"?\(/.test(s))).toBe(
      true
    );
  });

  it('emits AFTER INSERT OR UPDATE OR DELETE FOR EACH STATEMENT triggers per table', () => {
    const stmts = buildInstallStatements(['users', 'messages']);
    const usersTrigger = stmts.find((s) => s.includes('users') && s.includes('CREATE TRIGGER'));
    expect(usersTrigger).toBeDefined();
    expect(usersTrigger).toMatch(/AFTER INSERT OR UPDATE OR DELETE/);
    expect(usersTrigger).toMatch(/FOR EACH STATEMENT/);
    expect(stmts.find((s) => s.includes('messages') && s.includes('CREATE TRIGGER'))).toBeDefined();
  });

  it('emits a DROP TRIGGER IF EXISTS before each CREATE TRIGGER (idempotency)', () => {
    const stmts = buildInstallStatements(['users']);
    const dropIndex = stmts.findIndex(
      (s) => s.includes('DROP TRIGGER IF EXISTS') && s.includes('users')
    );
    const createIndex = stmts.findIndex(
      (s) => s.includes('CREATE TRIGGER') && s.includes('users') && !s.includes('DROP')
    );
    expect(dropIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(dropIndex);
  });

  it('rejects table names that are not strict snake_case identifiers', () => {
    expect(() => buildInstallStatements(['users; DROP TABLE'])).toThrow(/identifier/i);
    expect(() => buildInstallStatements(['Users'])).toThrow(/identifier/i);
    expect(() => buildInstallStatements([''])).toThrow(/identifier/i);
    expect(() => buildInstallStatements(['1users'])).toThrow(/identifier/i);
    expect(() => buildInstallStatements(['users--'])).toThrow(/identifier/i);
  });

  it('accepts an empty table list (only the meta table + function get installed)', () => {
    const stmts = buildInstallStatements([]);
    expect(stmts.some((s) => /CREATE TABLE IF NOT EXISTS\s+"?__stack_meta"?/.test(s))).toBe(true);
    expect(stmts.some((s) => s.includes('CREATE TRIGGER'))).toBe(false);
  });
});

describe('installDevOnlyTracking', () => {
  it('runs every statement returned by buildInstallStatements', async () => {
    const { executor, execCalls } = fakeExecutor();
    await installDevOnlyTracking(executor, ['users']);
    const expected = buildInstallStatements(['users']);
    expect(execCalls).toEqual(expected);
  });

  it('propagates an executor failure (no swallow)', async () => {
    const executor: SqlExecutor = {
      exec: vi.fn().mockRejectedValueOnce(new Error('permission denied')),
      query: vi.fn(),
    };
    await expect(installDevOnlyTracking(executor, ['users'])).rejects.toThrow('permission denied');
  });
});

describe('readMeta', () => {
  it('SELECTs the singleton row and decodes it into a StackMeta', async () => {
    const { executor, queryCalls } = fakeExecutor();
    const seededAtIso = '2026-05-29T01:00:00.000Z';
    (executor as SqlExecutor & { __setQueryResult: (r: unknown[]) => void }).__setQueryResult([
      { seed_hash: 'abc', seeded_at: seededAtIso, dirty: false },
    ]);
    const meta = await readMeta(executor);
    expect(queryCalls[0]).toMatch(/SELECT[\s\S]+__stack_meta/);
    const expected: StackMeta = {
      seedHash: 'abc',
      seededAt: new Date(seededAtIso),
      dirty: false,
    };
    expect(meta).toEqual(expected);
  });

  it('returns a defaulted dirty=true meta when the table is empty', async () => {
    const { executor } = fakeExecutor();
    const meta = await readMeta(executor);
    expect(meta).toEqual({ seedHash: '', seededAt: null, dirty: true });
  });

  it('handles a null seeded_at column', async () => {
    const { executor } = fakeExecutor();
    (executor as SqlExecutor & { __setQueryResult: (r: unknown[]) => void }).__setQueryResult([
      { seed_hash: '', seeded_at: null, dirty: true },
    ]);
    const meta = await readMeta(executor);
    expect(meta.seededAt).toBeNull();
  });
});

describe('markClean', () => {
  it('UPDATEs the meta row with seed_hash, seeded_at=now(), dirty=false', async () => {
    const { executor, execCalls } = fakeExecutor();
    await markClean(executor, 'fingerprint123');
    expect(execCalls).toHaveLength(1);
    const update = execCalls[0] ?? '';
    expect(update).toMatch(/UPDATE\s+"?__stack_meta"?/);
    expect(update).toMatch(/seed_hash\s*=\s*'fingerprint123'/);
    expect(update).toMatch(/dirty\s*=\s*false/);
    expect(update).toMatch(/seeded_at\s*=\s*NOW\(\)/i);
  });

  it('escapes single quotes in the seed_hash literal to prevent injection', async () => {
    const { executor, execCalls } = fakeExecutor();
    await markClean(executor, "a'b'c");
    const update = execCalls[0] ?? '';
    // SQL standard: '' represents a literal single quote inside a string literal.
    expect(update).toMatch(/seed_hash\s*=\s*'a''b''c'/);
  });
});
