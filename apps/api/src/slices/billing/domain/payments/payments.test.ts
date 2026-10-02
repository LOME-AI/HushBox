import { describe, expect, it } from 'vitest';
import { HOUR_MS, TEST_DAY_START, testUuidV7 } from '@hushbox/shared/test-time';
import { BACKOFF_CAP_SECONDS, backoffSeconds } from '../../../../lib/jobs/backoff.js';
import {
  PAYMENT_VERIFY_DELAY_SECONDS,
  PAYMENT_VERIFY_MAX_FAILURES,
  inFlightPaymentCutoff,
  paymentReference,
} from './payments.js';

const PAYMENT_ID = testUuidV7(1);
const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);
const EXPECTED_REFERENCE = PAYMENT_ID.replaceAll('-', '');

describe('paymentReference', () => {
  it('renders the payment uuid as 32 hyphen-free lowercase hex digits', () => {
    const reference = paymentReference(PAYMENT_ID);
    expect(reference).toBe(EXPECTED_REFERENCE);
    expect(reference).toHaveLength(32);
    expect(reference).toMatch(/^[0-9a-f]{32}$/);
  });

  it('lowercases an upstream uppercase uuid so the reference is deterministic', () => {
    expect(paymentReference(PAYMENT_ID.toUpperCase())).toBe(EXPECTED_REFERENCE);
  });

  it('re-derives the identical reference for the same payment id', () => {
    const paymentId = crypto.randomUUID();
    expect(paymentReference(paymentId)).toBe(paymentReference(paymentId));
  });

  it('throws when the payment id is not a 32-hex-digit uuid', () => {
    expect(() => paymentReference('not-a-uuid')).toThrow('32-hex');
  });
});

describe('inFlightPaymentCutoff', () => {
  it('subtracts the verify delay, the whole retry ride-out, and the claim margin', () => {
    // Independent restatement of the derivation from the same constants: the
    // budget is spent over one backoff per failure short of it, each taken at
    // its widest jitter.
    let rideOut = 0;
    for (let failures = 1; failures < PAYMENT_VERIFY_MAX_FAILURES; failures += 1) {
      rideOut += backoffSeconds(failures, () => 1);
    }
    const expected =
      NOW.getTime() -
      Math.round((PAYMENT_VERIFY_DELAY_SECONDS + rideOut + BACKOFF_CAP_SECONDS) * 1000);
    expect(inFlightPaymentCutoff(NOW).getTime()).toBe(expected);
  });

  it('holds an unresolved deposit for longer than a day', () => {
    // The reconciler rides a provider outage out for about a day, so a guard
    // narrower than that would release while the first charge is still live.
    expect(NOW.getTime() - inFlightPaymentCutoff(NOW).getTime()).toBeGreaterThan(24 * HOUR_MS);
  });
});
