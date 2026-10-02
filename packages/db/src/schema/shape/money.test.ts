import { describe, it, expect, expectTypeOf } from 'vitest';
import { getTableConfig, PgTable } from 'drizzle-orm/pg-core';
import { nanoUSD, serializeNanoUSD, parseNanoUSD } from '@hushbox/shared';

import { column } from '../__tests__/shape-helpers';
import * as schema from '../index';

/** Every nano-USD money column in the schema. */
const MONEY_COLUMNS: [PgTable, string][] = [
  [schema.wallets, 'balance_nano_usd'],
  [schema.ledgerEntries, 'amount_nano_usd'],
  [schema.ledgerEntries, 'balance_after_nano_usd'],
  [schema.usageRecords, 'cost_nano_usd'],
  [schema.contentItems, 'cost_nano_usd'],
  [schema.payments, 'amount_nano_usd'],
  [schema.memberBudgets, 'budget_nano_usd'],
  [schema.memberBudgets, 'spent_nano_usd'],
  [schema.conversationSpending, 'spent_nano_usd'],
  [schema.allowanceSpending, 'spent_nano_usd'],
  [schema.conversations, 'conversation_budget_nano_usd'],
];

/**
 * Every bigint column that is deliberately not money — monotonic sequence
 * counters, which share the type and nothing else.
 */
const NOT_MONEY_BIGINT_COLUMNS: [PgTable, string][] = [
  [schema.wallets, 'ledger_seq'],
  [schema.conversationMembers, 'last_read_seq'],
];

/** `<table>.<column>`, the identity the bigint sweep below is keyed by. */
function columnKey(table: PgTable, columnName: string): string {
  return `${getTableConfig(table).name}.${columnName}`;
}

const bigintColumnKeys = (Object.values(schema) as unknown[])
  .filter((v): v is PgTable => v instanceof PgTable)
  .flatMap((table) =>
    getTableConfig(table)
      .columns.filter((c) => c.getSQLType() === 'bigint')
      .map((c) => columnKey(table, c.name))
  )
  .toSorted((a, b) => a.localeCompare(b));

const classifiedBigintColumns = new Set(
  [...MONEY_COLUMNS, ...NOT_MONEY_BIGINT_COLUMNS].map(([t, c]) => columnKey(t, c))
);

describe('bigint column classification', () => {
  it('classifies every bigint column in the schema barrel', () => {
    const unclassified = bigintColumnKeys.filter((key) => !classifiedBigintColumns.has(key));
    expect(unclassified).toEqual([]);
  });

  it('classifies no column the schema barrel does not declare bigint', () => {
    const known = new Set(bigintColumnKeys);
    const stale = [...classifiedBigintColumns]
      .filter((key) => !known.has(key))
      .toSorted((a, b) => a.localeCompare(b));
    expect(stale).toEqual([]);
  });
});

describe('nano-USD money columns', () => {
  it.each(MONEY_COLUMNS.map(([t, c]) => [getTableConfig(t).name, c, t] as const))(
    '%s.%s is a bigint-mode column',
    (_tableName, columnName, table) => {
      const c = column(table, columnName);
      expect(c.getSQLType()).toBe('bigint');
      expect(c.dataType).toBe('bigint');
    }
  );

  it('uses no numeric or floating-point column anywhere in the schema', () => {
    const tables = (Object.values(schema) as unknown[]).filter(
      (v): v is PgTable => v instanceof PgTable
    );
    expect(tables.length).toBeGreaterThan(0);
    for (const table of tables) {
      for (const c of getTableConfig(table).columns) {
        expect(c.getSQLType()).not.toMatch(/numeric|decimal|real|double/);
      }
    }
  });
});

describe('NanoUSD boundary serialization', () => {
  it('accepts a branded NanoUSD bigint in a money insert', () => {
    type LedgerInsert = typeof schema.ledgerEntries.$inferInsert;
    expectTypeOf<LedgerInsert['amountNanoUsd']>().toEqualTypeOf<bigint>();
    expectTypeOf(nanoUSD(5n)).toExtend<LedgerInsert['amountNanoUsd']>();
  });

  it('selects money columns as bigint', () => {
    type WalletRow = typeof schema.wallets.$inferSelect;
    expectTypeOf<WalletRow['balanceNanoUsd']>().toEqualTypeOf<bigint>();
  });

  it('round-trips a stored bigint through the canonical wire string', () => {
    const stored = nanoUSD(123_456_789n);
    expect(parseNanoUSD(serializeNanoUSD(stored))).toBe(stored);
  });
});
