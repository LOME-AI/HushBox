import { describe, it, expect } from 'vitest';

import {
  REHEARSAL_DATABASE_PREFIX,
  pairJournalWithSql,
  readMigrationChain,
  splitChainAt,
  withRehearsalDatabase,
} from './migration-rehearsal';
import { TEST_DATABASE_PREFIX } from './test-db';

describe('migration chain reader', () => {
  it('rejects a tag the chain does not contain', () => {
    expect(() => splitChainAt(readMigrationChain(), 'nope')).toThrow('no migration tagged "nope"');
  });

  it('rejects a journal entry that has no parsed SQL', () => {
    expect(() =>
      pairJournalWithSql(['0000_first', '0001_second'], [{ sql: ['select 1'] }])
    ).toThrow('no SQL parsed for "0001_second"');
  });
});

describe('rehearsal database', () => {
  it('refuses a connection string that is not local', async () => {
    await expect(
      withRehearsalDatabase('postgres://user:pass@db.prod.neon.tech/hushbox', () =>
        Promise.reject(new Error('the rehearsal body must never run'))
      )
    ).rejects.toThrow('does not point at a local database');
  });
});

describe('rehearsal database naming', () => {
  it('shares no prefix with the per-worker test databases the sweep drops by age', () => {
    expect(REHEARSAL_DATABASE_PREFIX.startsWith(TEST_DATABASE_PREFIX)).toBe(false);
    expect(TEST_DATABASE_PREFIX.startsWith(REHEARSAL_DATABASE_PREFIX)).toBe(false);
  });
});
