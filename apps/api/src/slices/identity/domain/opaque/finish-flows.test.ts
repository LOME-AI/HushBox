import { describe, expect, it } from 'vitest';
import { Redis } from '@upstash/redis';
import { deriveOpaqueKek } from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { STEP_UP_GATES, createStepUpFinishFlow, verifyStepUp } from '../session/step-up.js';
import { createTotpVerifySetupFlow } from '../two-factor/totp.js';
import { createRecoveryResetFinishFlow } from '../recovery/recovery.js';
import { createDeleteAccountFinishFlow } from '../account/deletion.js';
import { createJobWakeCollector, grantJobWakes } from '../../../../lib/jobs/index.js';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type {
  AccountDeletedEmailPort,
  AccountDeletionPurge,
  IdentityUsersStore,
  PasswordResetEmailPort,
  TwoFactorEnabledEmailPort,
} from '../../ports/index.js';

// A never-touched Redis/store/port/logger: every flow below throws its
// execute-defect before any infra call, so these must never be reached.
const redis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });
const store = {} as IdentityUsersStore;
const emailPort = {} as PasswordResetEmailPort;
const enabledEmail = {} as TwoFactorEnabledEmailPort;
const logger = {} as Telemetry;
const secrets = {
  opaqueKek: deriveOpaqueKek(textEncoder.encode('finish-flows-kek-at-least-32-characters')),
  totpEncryptionSecret: textEncoder.encode('finish-flows-totp-at-least-32-characters'),
};

/**
 * `byEventId` runs `execute` only after `claim` resolved true (pending state
 * present). Calling `execute` directly leaves the closure's pending null, so
 * every finish flow must treat that as a defect — the same contract the login
 * and registration finish flows carry.
 */
describe('finish-flow execute defects', () => {
  it('throws when the step-up finish executes without a won claim', () => {
    const flow = createStepUpFinishFlow({
      redis,
      gate: STEP_UP_GATES.changePassword,
      userId: 'u',
      stepUpSessionId: crypto.randomUUID(),
      ke3: [1],
      onVerified: () => okAsync({ rotated: true as const }),
    });
    expect(() => flow.execute()).toThrow(/without a claimed handshake/);
  });

  it('throws when the TOTP verify-setup executes without a won claim', () => {
    const flow = createTotpVerifySetupFlow({
      redis,
      store,
      enabledEmail,
      userId: 'u',
      code: '000000',
      now: new Date(),
    });
    expect(() => flow.execute()).toThrow(/without a claimed pending setup/);
  });

  it('throws when the recovery reset executes without a won claim', () => {
    const flow = createRecoveryResetFinishFlow({
      redis,
      store,
      secrets,
      emailPort,
      logger,
      identifier: 'x@identity.test',
      newRegistrationRecord: [1],
      newPasswordWrappedPrivateKey: 'AQID',
      recoverySessionId: crypto.randomUUID(),
      resetProof: 'AQID',
      now: Date.now(),
    });
    expect(() => flow.execute()).toThrow(/without a claimed handshake/);
  });

  it('answers the duplicate path of the recovery reset with no-pending', async () => {
    const flow = createRecoveryResetFinishFlow({
      redis,
      store,
      secrets,
      emailPort,
      logger,
      identifier: 'x@identity.test',
      newRegistrationRecord: [1],
      newPasswordWrappedPrivateKey: 'AQID',
      recoverySessionId: crypto.randomUUID(),
      resetProof: 'AQID',
      now: Date.now(),
    });
    const outcome = await flow.onDuplicate();
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'no-pending' });
  });

  it('throws when the delete-account finish executes without a won claim', () => {
    const flow = createDeleteAccountFinishFlow({
      redis,
      store,
      db: grantJobWakes({} as Database, createJobWakeCollector()),
      purge: {} as AccountDeletionPurge,
      accountDeletedEmail: {} as AccountDeletedEmailPort,
      secrets,
      userId: 'u',
      ipAddress: null,
      userAgent: null,
      ke3: [1],
      deleteAccountSessionId: crypto.randomUUID(),
      confirmationPhrase: 'delete my account',
      totpCode: undefined,
      billingStores: {} as Parameters<typeof createDeleteAccountFinishFlow>[0]['billingStores'],
      acknowledgedForfeitNanoUsd: undefined,
      now: new Date(),
    });
    expect(() => flow.execute()).toThrow(/without a claimed handshake/);
  });
});

describe('verifyStepUp', () => {
  it('reports session-mismatch when the handshake is bound to another account', () => {
    expect(
      verifyStepUp({ userId: 'owner', expectedSerialized: [] }, 'someone-else', [1, 2, 3])
    ).toBe('session-mismatch');
  });

  it('reports bad-proof when the KE3 bytes are malformed', () => {
    expect(
      verifyStepUp({ userId: 'owner', expectedSerialized: [1, 2, 3] }, 'owner', [9, 9, 9])
    ).toBe('bad-proof');
  });
});
