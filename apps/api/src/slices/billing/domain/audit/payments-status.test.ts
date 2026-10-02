import { describe, expect, it, vi } from 'vitest';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { okAsync } from '../../../../lib/result/index.js';
import { backoffSeconds } from '../../../../lib/jobs/backoff.js';
import { PAYMENT_VERIFY_DELAY_SECONDS, PAYMENT_VERIFY_MAX_FAILURES } from '../payments/payments.js';
import {
  PAYMENT_STATUS_AUDIT_GRACE_SECONDS,
  runPaymentsStatusAudit,
  unresolvedPaymentCutoff,
} from './payments-status.js';
import type { Database } from '@hushbox/db';
import type { BillingStores } from '../../ports/index.js';

const DB = {} as Database;
const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);

function fakeStores(count: number, spy: (olderThan: Date) => void): BillingStores {
  return {
    countUnresolvedPayments: (_db: Database, olderThan: Date) => {
      spy(olderThan);
      return okAsync(count);
    },
  } as unknown as BillingStores;
}

describe('unresolvedPaymentCutoff', () => {
  it('subtracts the verify delay, the whole retry ride-out, and the grace margin', () => {
    // Independent restatement of the derivation from the same two constants:
    // the budget is spent over one backoff per failure short of it, each taken
    // at its widest jitter.
    let rideOut = 0;
    for (let failures = 1; failures < PAYMENT_VERIFY_MAX_FAILURES; failures += 1) {
      rideOut += backoffSeconds(failures, () => 1);
    }
    const expected =
      NOW.getTime() -
      Math.round(
        (PAYMENT_VERIFY_DELAY_SECONDS + rideOut + PAYMENT_STATUS_AUDIT_GRACE_SECONDS) * 1000
      );

    expect(unresolvedPaymentCutoff(NOW).getTime()).toBe(expected);
  });

  it('moves with the retry budget rather than a written-down window', () => {
    // A budget-derived threshold must be strictly wider than one covering only
    // the first failure's backoff — the property a literal would silently lose
    // when the budget is raised.
    const oneFailureOnly =
      PAYMENT_VERIFY_DELAY_SECONDS +
      backoffSeconds(1, () => 1) +
      PAYMENT_STATUS_AUDIT_GRACE_SECONDS;

    expect(NOW.getTime() - unresolvedPaymentCutoff(NOW).getTime()).toBeGreaterThan(
      oneFailureOnly * 1000
    );
  });
});

describe('runPaymentsStatusAudit', () => {
  it('probes for rows left non-terminal past the derived cutoff', async () => {
    const spy = vi.fn();
    const result = await runPaymentsStatusAudit(fakeStores(0, spy), DB, NOW);

    expect(result.isOk()).toBe(true);
    const olderThan = spy.mock.calls[0]?.[0] as Date;
    expect(olderThan.getTime()).toBe(unresolvedPaymentCutoff(NOW).getTime());
  });

  it('reports how many rows the probe counted', async () => {
    const result = await runPaymentsStatusAudit(fakeStores(3, vi.fn()), DB, NOW);

    expect(result._unsafeUnwrap()).toEqual({ unresolvedCount: 3 });
  });

  it('reads only — the sole store method it can reach is the read probe', async () => {
    // The fake exposes no mutation method, so any write attempt would throw on
    // an undefined call; a green run is proof the probe never mutates.
    const result = await runPaymentsStatusAudit(fakeStores(0, vi.fn()), DB, NOW);

    expect(result.isOk()).toBe(true);
  });
});
