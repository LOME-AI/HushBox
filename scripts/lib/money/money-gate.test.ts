import { beforeEach, describe, expect, it } from 'vitest';
import {
  compareBalanceDelta,
  compareChargeAttribution,
  compareDelegatedBudget,
  compareExactCharge,
  compareHoldCoverage,
  compareMoneyState,
  compareNoMoneyMoved,
  compareNoWalletMovement,
  asReading,
} from './money.js';
import {
  moneyGateFailure,
  noteMoneyRead,
  resetMoneyLedger,
  takeMoneyLedger,
} from './money-gate.js';
import type {
  DerivedNanoUsd,
  MemberDelegation,
  MoneyState,
  ObservedNanoUsd,
  ServedAttributionRow,
} from './money.js';

const observed = (amount: bigint): ObservedNanoUsd => amount as ObservedNanoUsd;
const derived = (amount: bigint): DerivedNanoUsd => amount as DerivedNanoUsd;

const readState = (purchased = 0n): MoneyState =>
  asReading({
    purchasedNanoUsd: observed(purchased),
    freeNanoUsd: observed(0n),
    allowanceRemainingNanoUsd: observed(0n),
  });

const readDelegation = (cap: bigint, remaining: bigint): MemberDelegation =>
  asReading({
    capNanoUsd: observed(cap),
    effectiveRemainingNanoUsd: observed(remaining),
  });

const ATTRIBUTION_ROW = asReading({
  messageId: 'm1',
  payerId: 'owner',
  senderUserId: 'bob',
  senderLinkId: null,
} as ServedAttributionRow);

const PASSING = {
  title: 'a money-touching test',
  file: 'e2e/billing/wallet.spec.ts',
  failed: false,
};

beforeEach(() => {
  resetMoneyLedger();
});

describe('the ledger records what a test did with money', () => {
  it('starts empty', () => {
    expect(takeMoneyLedger()).toEqual({ reads: [], comparisons: [] });
  });

  it('records each read by the name of the read that fetched it', () => {
    noteMoneyRead('readMoneyState');
    noteMoneyRead('readSettledCharge');

    expect(takeMoneyLedger().reads).toEqual(['readMoneyState', 'readSettledCharge']);
  });

  it('records a repeated read once, so a polled assertion reads as one touch', () => {
    noteMoneyRead('readMoneyState');
    noteMoneyRead('readMoneyState');

    expect(takeMoneyLedger().reads).toEqual(['readMoneyState']);
  });

  it('drains on being taken, so one test cannot inherit the previous one s money', () => {
    noteMoneyRead('readMoneyState');
    takeMoneyLedger();

    expect(takeMoneyLedger()).toEqual({ reads: [], comparisons: [] });
  });

  it('clears on reset, so a read outside any test cannot be attributed to one', () => {
    noteMoneyRead('readMoneyState');
    resetMoneyLedger();

    expect(takeMoneyLedger()).toEqual({ reads: [], comparisons: [] });
  });
});

describe('a comparator records the assertion it performed, so one added to the money module earns a case here', () => {
  it('records the exact-charge comparison', () => {
    compareExactCharge(observed(1150n), derived(1150n));

    expect(takeMoneyLedger().comparisons).toEqual(['compareExactCharge']);
  });

  it('records the hold-coverage comparison', () => {
    compareHoldCoverage(observed(2000n), observed(1150n));

    expect(takeMoneyLedger().comparisons).toEqual(['compareHoldCoverage']);
  });

  it('records the money-state comparison', () => {
    compareMoneyState(readState(1150n), { purchased: derived(1150n) });

    expect(takeMoneyLedger().comparisons).toEqual(['compareMoneyState']);
  });

  it('records the balance-delta comparison', () => {
    compareBalanceDelta(readState(1150n), readState(0n), { purchased: derived(-1150n) });

    expect(takeMoneyLedger().comparisons).toContain('compareBalanceDelta');
  });

  it('records the nothing-moved comparison', () => {
    compareNoMoneyMoved(readState(), readState(), observed(0n));

    expect(takeMoneyLedger().comparisons).toEqual(['compareNoMoneyMoved']);
  });

  it('records the no-wallet-movement comparison', () => {
    compareNoWalletMovement(readState(), readState());

    expect(takeMoneyLedger().comparisons).toEqual(['compareNoWalletMovement']);
  });

  it('records the delegated-budget comparison', () => {
    compareDelegatedBudget(readDelegation(5000n, 5000n));

    expect(takeMoneyLedger().comparisons).toEqual(['compareDelegatedBudget']);
  });

  it('records the attribution comparison', () => {
    compareChargeAttribution([ATTRIBUTION_ROW], { payerId: 'owner' });

    expect(takeMoneyLedger().comparisons).toEqual(['compareChargeAttribution']);
  });

  it('records a comparison that DIVERGED, so a red assertion is still an assertion', () => {
    compareExactCharge(observed(1n), derived(2n));

    expect(takeMoneyLedger().comparisons).toEqual(['compareExactCharge']);
  });
});

describe('the gate verdict', () => {
  it('passes a test that never read money', () => {
    expect(moneyGateFailure(takeMoneyLedger(), PASSING)).toBeNull();
  });

  it('passes a test that read money and compared it', () => {
    noteMoneyRead('readMoneyState');
    compareNoWalletMovement(readState(), readState());

    expect(moneyGateFailure(takeMoneyLedger(), PASSING)).toBeNull();
  });

  it('fails a test that read money and compared nothing', () => {
    noteMoneyRead('readMoneyState');

    expect(moneyGateFailure(takeMoneyLedger(), PASSING)).not.toBeNull();
  });

  it('names the test and its file, so the failure is actionable without a search', () => {
    noteMoneyRead('readMoneyState');

    const message = moneyGateFailure(takeMoneyLedger(), PASSING) ?? '';
    expect(message).toContain('a money-touching test');
    expect(message).toContain('e2e/billing/wallet.spec.ts');
  });

  it('names the reads it saw and states that no assertion was made', () => {
    noteMoneyRead('readMoneyState');
    noteMoneyRead('readSettledCharge');

    const message = moneyGateFailure(takeMoneyLedger(), PASSING) ?? '';
    expect(message).toContain('readMoneyState, readSettledCharge');
    expect(message).toContain('exact-money assertions: none');
  });

  it('points at the module the assertions live in rather than listing them', () => {
    noteMoneyRead('readMoneyState');

    expect(moneyGateFailure(takeMoneyLedger(), PASSING) ?? '').toContain(
      'e2e/helpers/exact-money.ts'
    );
  });

  it('names the unbranded precondition path, which is the only way past it', () => {
    noteMoneyRead('seedWalletBalance');

    const message = moneyGateFailure(takeMoneyLedger(), PASSING) ?? '';
    expect(message).toContain('setWalletBalance');
    expect(message).toContain('budget.ts');
  });

  it('stays silent when the test already failed, so it never masks the real failure', () => {
    noteMoneyRead('readMoneyState');

    expect(moneyGateFailure(takeMoneyLedger(), { ...PASSING, failed: true })).toBeNull();
  });
});

describe('the gate fires on a money-touching test that asserts nothing, and not once it does', () => {
  // The mutation proof, at the layer that holds the decision: the same read, the
  // same real comparator, one run without the assertion and one with it.
  it('fires when the assertion is removed', () => {
    noteMoneyRead('readSettledCharge');

    expect(moneyGateFailure(takeMoneyLedger(), PASSING)).toContain('asserted nothing exact');
  });

  it('passes when the assertion is put back', () => {
    noteMoneyRead('readSettledCharge');
    compareExactCharge(observed(1150n), derived(1150n));

    expect(moneyGateFailure(takeMoneyLedger(), PASSING)).toBeNull();
  });
});
