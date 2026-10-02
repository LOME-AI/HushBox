import { describe, expect, it } from 'vitest';
import { TEST_DAY_START, isoAt, testUuidV7 } from '../../testing/test-time.ts';

import {
  listTransactionsQuerySchema,
  getBalanceResponseSchema,
  getSpendableQuerySchema,
  getSpendableResponseSchema,
  ownerFundingLimitSchema,
  balanceTransactionResponseSchema,
  listTransactionsResponseSchema,
} from './billing.ts';

describe('listTransactionsQuerySchema', () => {
  it('defaults limit to 50 when omitted', () => {
    expect(listTransactionsQuerySchema.parse({}).limit).toBe(50);
  });

  it('coerces numeric query strings within bounds', () => {
    const parsed = listTransactionsQuerySchema.parse({
      limit: '25',
      offset: '10',
      type: 'deposit',
    });
    expect(parsed).toMatchObject({ limit: 25, offset: 10, type: 'deposit' });
  });

  it('rejects a limit above 100', () => {
    expect(listTransactionsQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('rejects an unknown ledger entry type', () => {
    expect(listTransactionsQuerySchema.safeParse({ type: 'not-a-type' }).success).toBe(false);
  });
});

describe('getBalanceResponseSchema', () => {
  it('accepts NanoUSD string balances plus the daily allowance block', () => {
    const value = {
      purchased: { balanceNanoUsd: '-5' },
      free: { balanceNanoUsd: '0' },
      allowance: {
        day: '2026-07-15',
        limitNanoUsd: '1000',
        spentNanoUsd: '250',
        remainingNanoUsd: '750',
      },
    };
    expect(getBalanceResponseSchema.parse(value)).toEqual(value);
  });

  it('rejects a missing allowance block', () => {
    expect(
      getBalanceResponseSchema.safeParse({
        purchased: { balanceNanoUsd: '0' },
        free: { balanceNanoUsd: '0' },
      }).success
    ).toBe(false);
  });
});

describe('balanceTransactionResponseSchema', () => {
  it('accepts a usage charge with model and character counts', () => {
    const value = {
      id: 'txn_1',
      amount: '-0.5',
      balanceAfter: '9.5',
      type: 'charge' as const,
      paymentId: null,
      model: 'openai/gpt-5',
      inputCharacters: 100,
      outputCharacters: 200,
      createdAt: isoAt(TEST_DAY_START),
    };
    expect(balanceTransactionResponseSchema.parse(value)).toEqual(value);
  });

  it('rejects a retired ledger kind value', () => {
    expect(
      balanceTransactionResponseSchema.safeParse({
        id: 'txn_3',
        amount: '-0.5',
        balanceAfter: '9.5',
        type: 'usage_charge',
        createdAt: isoAt(TEST_DAY_START),
      }).success
    ).toBe(false);
  });

  it('accepts a deposit with null usage fields', () => {
    const parsed = balanceTransactionResponseSchema.parse({
      id: 'txn_2',
      amount: '10',
      balanceAfter: '10',
      type: 'deposit',
      createdAt: isoAt(TEST_DAY_START),
    });
    expect(parsed.type).toBe('deposit');
  });
});

describe('listTransactionsResponseSchema', () => {
  it('accepts a transaction list with a nullable cursor', () => {
    const parsed = listTransactionsResponseSchema.parse({ transactions: [], nextCursor: null });
    expect(parsed.transactions).toEqual([]);
  });
});

describe('getSpendableResponseSchema', () => {
  it('accepts NanoUSD strings, negative spendable included', () => {
    const parsed = getSpendableResponseSchema.parse({
      spendableNanoUsd: '-100000000',
      heldNanoUsd: '250000000',
      payerTier: 'paid',
      payer: 'self',
      ownerFundingLimit: null,
    });
    expect(parsed).toEqual({
      spendableNanoUsd: '-100000000',
      heldNanoUsd: '250000000',
      payerTier: 'paid',
      payer: 'self',
      ownerFundingLimit: null,
    });
  });

  it('carries the two money fields, the payer identity that priced them, and the limit that binds', () => {
    expect(
      Object.keys(getSpendableResponseSchema.shape).toSorted((a, b) => a.localeCompare(b))
    ).toEqual(['heldNanoUsd', 'ownerFundingLimit', 'payer', 'payerTier', 'spendableNanoUsd']);
  });

  it('accepts the owner payer an owner-funded group turn serves, with its binding limit', () => {
    const parsed = getSpendableResponseSchema.parse({
      spendableNanoUsd: '1000',
      heldNanoUsd: '0',
      payerTier: 'paid',
      payer: 'owner',
      ownerFundingLimit: 'member_allocation',
    });
    expect(parsed.ownerFundingLimit).toBe('member_allocation');
  });

  it('rejects a self payer that names an owner-funding limit', () => {
    expect(
      getSpendableResponseSchema.safeParse({
        spendableNanoUsd: '1000',
        heldNanoUsd: '0',
        payerTier: 'paid',
        payer: 'self',
        ownerFundingLimit: 'owner_balance',
      }).success
    ).toBe(false);
  });

  it('rejects an owner payer that names no owner-funding limit', () => {
    expect(
      getSpendableResponseSchema.safeParse({
        spendableNanoUsd: '1000',
        heldNanoUsd: '0',
        payerTier: 'paid',
        payer: 'owner',
        ownerFundingLimit: null,
      }).success
    ).toBe(false);
  });

  it('rejects a payer outside self/owner', () => {
    expect(
      getSpendableResponseSchema.safeParse({
        spendableNanoUsd: '1000',
        heldNanoUsd: '0',
        payerTier: 'paid',
        payer: 'sender',
        ownerFundingLimit: null,
      }).success
    ).toBe(false);
  });

  it('rejects a payer tier outside the shared tier vocabulary', () => {
    expect(
      getSpendableResponseSchema.safeParse({
        spendableNanoUsd: '1000',
        heldNanoUsd: '0',
        payerTier: 'premium',
        payer: 'self',
        ownerFundingLimit: null,
      }).success
    ).toBe(false);
  });

  it('rejects a missing field', () => {
    expect(getSpendableResponseSchema.safeParse({ spendableNanoUsd: '0' }).success).toBe(false);
  });
});

describe('ownerFundingLimitSchema', () => {
  it('accepts each of the three group dimensions', () => {
    for (const limit of ['owner_balance', 'member_allocation', 'conversation_budget']) {
      expect(ownerFundingLimitSchema.parse(limit)).toBe(limit);
    }
  });

  it('rejects a name outside the three group dimensions', () => {
    expect(ownerFundingLimitSchema.safeParse('free_allowance').success).toBe(false);
  });
});

describe('getSpendableQuerySchema', () => {
  it('accepts a conversation id — the context that names the payer', () => {
    const parsed = getSpendableQuerySchema.parse({
      conversationId: testUuidV7(0),
    });
    expect(parsed.conversationId).toBe(testUuidV7(0));
  });

  it('accepts an absent conversation id — a solo composer serves its own numbers', () => {
    expect(getSpendableQuerySchema.parse({})).toEqual({});
  });

  it('rejects a conversation id that is not a uuid', () => {
    expect(getSpendableQuerySchema.safeParse({ conversationId: 'not-a-uuid' }).success).toBe(false);
  });
});
