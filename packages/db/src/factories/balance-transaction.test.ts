import { describe, it, expect } from 'vitest';

import { balanceTransactionFactory } from './index';

describe('balanceTransactionFactory', () => {
  it('builds a complete balance transaction object', () => {
    const transaction = balanceTransactionFactory.build();

    expect(transaction.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(transaction.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(transaction.amount).toBeTruthy();
    expect(transaction.balanceAfter).toBeTruthy();
    expect(transaction.type).toBe('deposit');
    expect(transaction.description).toBeTruthy();
    expect(transaction.createdAt).toBeInstanceOf(Date);
  });

  it('allows field overrides', () => {
    const transaction = balanceTransactionFactory.build({ amount: '25.00000000' });
    expect(transaction.amount).toBe('25.00000000');
  });

  it('allows type override to usage', () => {
    const transaction = balanceTransactionFactory.build({ type: 'usage' });
    expect(transaction.type).toBe('usage');
  });

  it('allows type override to adjustment', () => {
    const transaction = balanceTransactionFactory.build({ type: 'adjustment' });
    expect(transaction.type).toBe('adjustment');
  });

  it('builds deposit with positive amount by default', () => {
    const transaction = balanceTransactionFactory.build();
    expect(parseFloat(transaction.amount)).toBeGreaterThan(0);
  });

  it('builds a list with unique IDs', () => {
    const transactionList = balanceTransactionFactory.buildList(3);
    expect(transactionList).toHaveLength(3);
    const ids = new Set(transactionList.map((t) => t.id));
    expect(ids.size).toBe(3);
  });
});
