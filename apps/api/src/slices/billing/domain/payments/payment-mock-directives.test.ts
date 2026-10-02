import { describe, expect, it } from 'vitest';
import { createEnvUtilities } from '@hushbox/shared';
import { paymentMockDirectivesFor } from './payment-mock-directives.js';

const LOCAL_DEV = createEnvUtilities({ NODE_ENV: 'development' });

function headers(values: Record<string, string>): (name: string) => string | undefined {
  return (name) => values[name];
}

describe('paymentMockDirectivesFor', () => {
  it('directs a webhook hold where the local mock is the provider', () => {
    expect(
      paymentMockDirectivesFor(LOCAL_DEV, headers({ 'x-mock-hold-payment-webhook': 'true' }))
    ).toStrictEqual({ holdWebhook: true });
  });

  it('directs nothing when the hold header is absent', () => {
    expect(paymentMockDirectivesFor(LOCAL_DEV, headers({}))).toStrictEqual({});
  });

  it('directs nothing for a hold header that is not exactly true', () => {
    expect(
      paymentMockDirectivesFor(LOCAL_DEV, headers({ 'x-mock-hold-payment-webhook': 'yes' }))
    ).toStrictEqual({});
  });

  it('never reads the hold header in production', () => {
    const production = createEnvUtilities({ NODE_ENV: 'production' });
    expect(
      paymentMockDirectivesFor(production, headers({ 'x-mock-hold-payment-webhook': 'true' }))
    ).toStrictEqual({});
  });

  it('never reads the hold header in CI, where the real provider takes the charge', () => {
    const ci = createEnvUtilities({ NODE_ENV: 'development', CI: 'true' });
    expect(
      paymentMockDirectivesFor(ci, headers({ 'x-mock-hold-payment-webhook': 'true' }))
    ).toStrictEqual({});
  });
});
