import { describe, expect, it, vi } from 'vitest';
import { Redis } from '@upstash/redis';
import { deriveOpaqueKek, opaqueKekFingerprint } from '@hushbox/crypto';
import { TERMS_OF_SERVICE_REVISION, textEncoder } from '@hushbox/shared';
import { HOUR_MS } from '@hushbox/shared/durations';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { EMAIL_VERIFY_TOKEN_TTL_MS } from '../account/email-verification.js';
import {
  completeRegistration,
  createRegisterFinishFlow,
  dispatchRegistrationSideEffects,
  generateUserId,
} from './registration.js';
import type { CompleteRegistrationArgs } from './registration.js';
import type { Database } from '@hushbox/db';
import type { BillingStores, WelcomeEmailPort } from '../../../billing/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type {
  IdentityUsersStore,
  IdentityVerificationStore,
  VerificationEmailPort,
} from '../../ports/index.js';

/** Neither the store nor Redis may be touched on the defect path. */
const untouchableStore: IdentityUsersStore = {
  findByEmail: () => {
    throw new Error('store must not be touched');
  },
  findByUsername: () => {
    throw new Error('store must not be touched');
  },
  findById: () => {
    throw new Error('store must not be touched');
  },
  insertRegisteredWithinTx: () => {
    throw new Error('store must not be touched');
  },
  insertAcquisitionWithinTx: () => {
    throw new Error('store must not be touched');
  },
  insertTermsAcceptanceWithinTx: () => {
    throw new Error('store must not be touched');
  },
  readAcquisitionSelfReport: () => {
    throw new Error('store must not be touched');
  },
  recordSelfReportedChannel: () => {
    throw new Error('store must not be touched');
  },
  recordSelfReportSkip: () => {
    throw new Error('store must not be touched');
  },
  enableTotp: () => {
    throw new Error('store must not be touched');
  },
  disableTotp: () => {
    throw new Error('store must not be touched');
  },
  rotatePassword: () => {
    throw new Error('store must not be touched');
  },
  readServerMaterialBatch: () => {
    throw new Error('store must not be touched');
  },
  resealServerMaterial: () => {
    throw new Error('store must not be touched');
  },
  resealTotpSecret: () => {
    throw new Error('store must not be touched');
  },
  liftStatementTimeoutWithinTx: () => {
    throw new Error('store must not be touched');
  },
  lockForDeletionWithinTx: () => {
    throw new Error('store must not be touched');
  },
  insertDeletionEventWithinTx: () => {
    throw new Error('store must not be touched');
  },
  deleteUserWithinTx: () => {
    throw new Error('store must not be touched');
  },
  saveRecoveryKey: () => {
    throw new Error('store must not be touched');
  },
  lockForChargebackWithinTx: () => {
    throw new Error('store must not be touched');
  },
  lockUserWithinTx: () => {
    throw new Error('store must not be touched');
  },
  unlockUserWithinTx: () => {
    throw new Error('store must not be touched');
  },
  disableStrandedTotpWithinTx: () => {
    throw new Error('store must not be touched');
  },
  restoreStrandedTotpWithinTx: () => {
    throw new Error('store must not be touched');
  },
  clearTotpWithinTx: () => {
    throw new Error('store must not be touched');
  },
  restoreTotpWithinTx: () => {
    throw new Error('store must not be touched');
  },
};

const untouchableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });
const KEK = deriveOpaqueKek(textEncoder.encode('kek-secret-at-least-32-characters-long!!'));
const OTHER_KEK = deriveOpaqueKek(textEncoder.encode('other-kek-at-least-32-characters-long!!!'));

// The provisioning/email deps are never reached: execute throws its
// pending-state defect and onDuplicate short-circuits before any settlement.
const untouchable: unknown = new Proxy(
  {},
  {
    get() {
      throw new Error('provisioning deps must not be touched');
    },
  }
);

function flowUnderTest(): ReturnType<typeof createRegisterFinishFlow> {
  return createRegisterFinishFlow({
    listActiveTags: () => okAsync<readonly string[]>([]),
    logger: { captureError: () => undefined } as unknown as Telemetry,
    store: untouchableStore,
    redis: untouchableRedis,
    secrets: { opaqueKek: KEK },
    db: untouchable as Database,
    billingStores: untouchable as BillingStores,
    verificationStore: untouchable as IdentityVerificationStore,
    welcomeEmail: untouchable as WelcomeEmailPort,
    verificationEmail: untouchable as VerificationEmailPort,
    email: 'someone@example.test',
    registerSessionId: crypto.randomUUID(),
    registrationRecord: [1, 2, 3],
    accountPublicKey: 'AQID',
    passwordWrappedPrivateKey: 'BAUG',
    recoveryWrappedPrivateKey: 'BwgJ',
    recoveryPublicKey: 'CgsM',
    now: Date.now(),
    acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
  });
}

describe('generateUserId', () => {
  it('mints a version-7 uuid', () => {
    const id = generateUserId(Date.now());
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('orders ids lexicographically by their millisecond timestamp prefix', () => {
    const earlier = generateUserId(1000);
    const later = generateUserId(2000);
    expect(earlier < later).toBe(true);
  });
});

describe('createRegisterFinishFlow', () => {
  it('treats execute without a won claim as a defect', () => {
    // byEventId runs execute only after claim resolved true; calling it
    // while the consume still reads no-pending is an illegal state.
    expect(() => flowUnderTest().execute()).toThrow(/without a claimed pending state/);
  });

  it('answers the duplicate path with the no-pending outcome', async () => {
    const outcome = await flowUnderTest().onDuplicate();
    expect(outcome._unsafeUnwrap()).toEqual({ kind: 'no-pending' });
  });
});

describe('completeRegistration', () => {
  it('refuses with kek-rotated and inserts nothing when the pinned fingerprint is not the live KEK', async () => {
    const result = await completeRegistration({
      db: untouchable as Database,
      store: untouchableStore,
      billingStores: untouchable as BillingStores,
      verificationStore: untouchable as IdentityVerificationStore,
      welcomeEmail: untouchable as WelcomeEmailPort,
      verificationEmail: untouchable as VerificationEmailPort,
      opaqueKek: KEK,
      pending: {
        userId: crypto.randomUUID(),
        email: 'rotated@example.test',
        username: 'rotated',
        serverMaterial: new Uint8Array([1, 2, 3]),
        kekFingerprint: opaqueKekFingerprint(OTHER_KEK),
      },
      registrationRecord: [1, 2, 3],
      accountPublicKey: 'AQID',
      passwordWrappedPrivateKey: 'BAUG',
      recoveryWrappedPrivateKey: 'BwgJ',
      recoveryPublicKey: 'CgsM',
      now: Date.now(),
      acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
    });
    expect(result._unsafeUnwrap()).toEqual({ kind: 'kek-rotated' });
  });
});

describe('dispatchRegistrationSideEffects', () => {
  it('sends the welcome email unconditionally at registration', async () => {
    const sendWelcomeEmail = vi.fn(() => okAsync());
    const sendVerificationEmail = vi.fn(() => okAsync());
    const issueEmailVerification = vi.fn(() => okAsync());

    const args = {
      pending: { userId: crypto.randomUUID(), email: 'new@example.test', username: 'newbie' },
      welcomeEmail: { sendWelcomeEmail } as unknown as WelcomeEmailPort,
      verificationEmail: { sendVerificationEmail } as unknown as VerificationEmailPort,
      verificationStore: { issueEmailVerification } as unknown as IdentityVerificationStore,
      now: Date.now(),
    } as unknown as CompleteRegistrationArgs;

    const result = await dispatchRegistrationSideEffects(args);

    expect(result.isOk()).toBe(true);
    expect(sendWelcomeEmail).toHaveBeenCalledWith({
      to: 'new@example.test',
      userName: 'newbie',
    });
  });

  it('sends the issued token with the token lifetime in hours', async () => {
    const issuedTokens: string[] = [];
    const sent: Parameters<VerificationEmailPort['sendVerificationEmail']>[0][] = [];
    const welcomeEmail: WelcomeEmailPort = { sendWelcomeEmail: () => okAsync() };
    const verificationEmail: VerificationEmailPort = {
      sendVerificationEmail: (sendArgs) => {
        sent.push(sendArgs);
        return okAsync();
      },
    };
    const verificationStore: IdentityVerificationStore = {
      issueEmailVerification: (_userId, token) => {
        issuedTokens.push(token);
        return okAsync();
      },
      issueVerificationDecoy: () => errAsync(unavailableError('not under test')),
      consumeEmailVerification: () => errAsync(unavailableError('not under test')),
      findUnverifiedByEmail: () => errAsync(unavailableError('not under test')),
      findLatestVerificationToken: () => errAsync(unavailableError('not under test')),
    };
    const sideEffectArgs: Pick<
      CompleteRegistrationArgs,
      'pending' | 'welcomeEmail' | 'verificationEmail' | 'verificationStore' | 'now'
    > = {
      pending: {
        userId: crypto.randomUUID(),
        email: 'new@example.test',
        username: 'newbie',
        serverMaterial: new Uint8Array(),
        kekFingerprint: new Uint8Array(),
      },
      welcomeEmail,
      verificationEmail,
      verificationStore,
      now: TEST_DAY_START,
    };

    const result = await dispatchRegistrationSideEffects(
      // Narrowed on purpose: the side effects read only these five fields, and the rest of
      // the args (database, stores, KEK, key material) is registration machinery never reached.
      sideEffectArgs as CompleteRegistrationArgs
    );

    expect(result.isOk()).toBe(true);
    expect(issuedTokens).toHaveLength(1);
    expect(sent).toEqual([
      {
        to: 'new@example.test',
        token: issuedTokens[0],
        userName: 'newbie',
        expiresInHours: EMAIL_VERIFY_TOKEN_TTL_MS / HOUR_MS,
      },
    ]);
  });
});
