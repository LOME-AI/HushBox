import { describe, expect, it } from 'vitest';
import { expectExposes } from '@hushbox/shared/test-assertions';
import * as billing from './index.js';

describe('billing slice barrel', () => {
  it('exposes the payment seam factories and the webhook verifier', () => {
    expectExposes(billing, 'createPaymentProviderFromEnv', 'createWebhookVerifier');
  });

  it('exposes the money core: charge, admission, provisioning', () => {
    expectExposes(
      billing,
      'chargeWithinTx',
      'admitRun',
      'provisionWalletsWithinTx',
      'createBillingStores',
      'createBillingManifest'
    );
  });

  /** Admission is the only balance gate; this read shapes candidates for display. */
  it('publishes the wallet balance query', () => {
    expectExposes(billing, 'readBalance');
  });

  it('exposes the Pattern-D payment flow: charge, webhook application, verify job', () => {
    expectExposes(
      billing,
      'initiateCardPayment',
      'applyPaymentWebhookEvent',
      'createPaymentVerifyJobRegistration'
    );
  });

  it('publishes the anonymized public usage-stats builder and snapshot store', () => {
    expectExposes(
      billing,
      'buildPublicUsageStats',
      'savePublicStatsSnapshot',
      'readLatestPublicStatsSnapshot',
      'createPublicStatsStores'
    );
  });

  it('publishes the daily snapshot cron entry and its catalog meta resolver', () => {
    expectExposes(billing, 'createPublicStatsSnapshotEntry', 'createCatalogModelMetaResolver');
  });

  it('publishes the cost-circuit multiplier the circuit scales the hold by', () => {
    expect(billing.COST_CIRCUIT_MULTIPLIER).toBe(5n);
  });

  it('publishes the minimum card payment', () => {
    expect(billing.PAYMENT_MINIMUM_NANO_USD).toBe(5_000_000_000n);
  });

  it('publishes the verify job type the payment pre-claim reconciles through', () => {
    expect(billing.PAYMENT_VERIFY_JOB_TYPE).toBe('payment.verify.v1');
  });
});
