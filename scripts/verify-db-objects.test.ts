import { afterEach, describe, it, expect } from 'vitest';

import { SEED_REMOTE_REFUSAL_MESSAGE } from './lib/seed/preconditions.js';
import {
  formatDbObjects,
  isDrifted,
  parseFunctionRows,
  parseTriggerRows,
  resolveLocalDatabaseUrl,
} from './verify-db-objects.js';

describe('resolveLocalDatabaseUrl', () => {
  const original = process.env['DATABASE_URL'];

  afterEach(() => {
    if (original === undefined) {
      delete process.env['DATABASE_URL'];
      return;
    }
    process.env['DATABASE_URL'] = original;
  });

  it('refuses a remote (non-local) DATABASE_URL before any connection is opened', () => {
    process.env['DATABASE_URL'] = 'postgres://user:pass@db.prod.neon.tech/hushbox';

    expect(() => resolveLocalDatabaseUrl()).toThrow(SEED_REMOTE_REFUSAL_MESSAGE);
  });

  it('refuses an unparseable DATABASE_URL (fails closed)', () => {
    process.env['DATABASE_URL'] = 'not a valid url';

    expect(() => resolveLocalDatabaseUrl()).toThrow(SEED_REMOTE_REFUSAL_MESSAGE);
  });

  it('requires DATABASE_URL to be set at all', () => {
    delete process.env['DATABASE_URL'];

    expect(() => resolveLocalDatabaseUrl()).toThrow(/DATABASE_URL is required/);
  });

  it('returns a loopback DATABASE_URL unchanged', () => {
    process.env['DATABASE_URL'] = 'postgres://postgres:postgres@127.0.0.1:5432/hushbox';

    expect(resolveLocalDatabaseUrl()).toBe('postgres://postgres:postgres@127.0.0.1:5432/hushbox');
  });
});

describe('formatDbObjects', () => {
  it('places a function definition under a "-- function: <name>" header', () => {
    const output = formatDbObjects(
      [{ name: 'assert_ledger_transaction_balanced', definition: 'CREATE FUNCTION foo() ...' }],
      []
    );

    expect(output).toContain('-- function: assert_ledger_transaction_balanced');
    expect(output).toContain('CREATE FUNCTION foo() ...');
  });

  it('places a trigger definition under a "-- trigger: <table>.<name>" header', () => {
    const output = formatDbObjects(
      [],
      [
        {
          name: 'ledger_entries_zero_sum',
          table_name: 'ledger_entries',
          definition: 'CREATE CONSTRAINT TRIGGER ledger_entries_zero_sum ...',
        },
      ]
    );

    expect(output).toContain('-- trigger: ledger_entries.ledger_entries_zero_sum');
    expect(output).toContain('CREATE CONSTRAINT TRIGGER ledger_entries_zero_sum ...');
  });

  it('strips trailing whitespace from definition lines so the golden stays stable', () => {
    const output = formatDbObjects([{ name: 'f', definition: 'line one   \nline two\t' }], []);

    expect(output).toContain('line one\nline two');
    expect(output).not.toMatch(/line one +\n/);
  });

  it('ends with exactly one trailing newline', () => {
    const output = formatDbObjects([{ name: 'f', definition: 'body' }], []);

    expect(output.endsWith('\n')).toBe(true);
    expect(output.endsWith('\n\n')).toBe(false);
  });
});

describe('isDrifted', () => {
  it('reports no drift when the dump matches the golden exactly', () => {
    expect(isDrifted('same\n', 'same\n')).toBe(false);
  });

  it('reports drift when the dump differs from the golden', () => {
    expect(isDrifted('altered\n', 'original\n')).toBe(true);
  });
});

describe('parseFunctionRows', () => {
  it('reads the name and definition of every dumped function row', () => {
    const rows = parseFunctionRows([
      { name: 'assert_ledger_transaction_balanced', definition: 'CREATE FUNCTION ...' },
    ]);

    expect(rows).toEqual([
      { name: 'assert_ledger_transaction_balanced', definition: 'CREATE FUNCTION ...' },
    ]);
  });

  it('refuses a row the query contract says cannot happen', () => {
    expect(() => parseFunctionRows([{ name: 'orphan' }])).toThrow();
  });
});

describe('parseTriggerRows', () => {
  it('reads the name, table and definition of every dumped trigger row', () => {
    const rows = parseTriggerRows([
      {
        name: 'admin_audit_append_only',
        table_name: 'admin_audit',
        definition: 'CREATE TRIGGER ...',
      },
    ]);

    expect(rows).toEqual([
      {
        name: 'admin_audit_append_only',
        table_name: 'admin_audit',
        definition: 'CREATE TRIGGER ...',
      },
    ]);
  });

  it('refuses a row missing the table it fires on', () => {
    expect(() =>
      parseTriggerRows([{ name: 'orphan', definition: 'CREATE TRIGGER ...' }])
    ).toThrow();
  });
});
