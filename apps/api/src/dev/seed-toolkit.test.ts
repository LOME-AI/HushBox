import { describe, expect, it } from 'vitest';
import { expectExposes } from '@hushbox/shared/test-assertions';
import { E2E_KEYSPACE_CEILING } from './e2e-keyspace-ceiling.js';
import * as seedToolkit from './seed-toolkit.js';
import {
  createNoopSeedEmailPorts,
  createNoopSeedEmailPorts as reexportedFactory,
} from './seed-toolkit.js';

describe('createNoopSeedEmailPorts', () => {
  it('returns best-effort no-op welcome and verification email ports', () => {
    expectExposes(createNoopSeedEmailPorts().welcomeEmail, 'sendWelcomeEmail');
    expectExposes(createNoopSeedEmailPorts().verificationEmail, 'sendVerificationEmail');
  });

  it('resolves the welcome-email port to a success result', async () => {
    const ports = createNoopSeedEmailPorts();
    const result = await ports.welcomeEmail.sendWelcomeEmail({ to: 'seed@example.com' });
    expect(result.isOk()).toBe(true);
  });

  it('resolves the verification-email port to a success result', async () => {
    const ports = createNoopSeedEmailPorts();
    const result = await ports.verificationEmail.sendVerificationEmail({
      to: 'seed@example.com',
      token: 'tok-1',
      expiresInHours: 24,
    });
    expect(result.isOk()).toBe(true);
  });

  it('mints an independent port pair on each call', () => {
    expect(createNoopSeedEmailPorts()).not.toBe(reexportedFactory());
  });
});

describe('seed-toolkit barrel', () => {
  it('re-exports the DI-shaped seed and catalog surface consumed by scripts/seed.ts', () => {
    expectExposes(
      seedToolkit,
      'mintSeedUser',
      'refreshCatalog',
      'seedPaymentsHistory',
      'seedUsageHistory',
      'setWalletBalance',
      'usdToNanoUsd'
    );
  });

  it('re-exports the account-side growth seam the cohort seed composes', () => {
    expectExposes(seedToolkit, 'applySelfReport', 'setAccountCreatedAt');
  });

  it('re-exports the keyspace ceiling the end-to-end seed refuses above', () => {
    expect(seedToolkit.E2E_KEYSPACE_CEILING).toBe(E2E_KEYSPACE_CEILING);
  });
});
