import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  RESET_CHALLENGE_NONCE_BYTES,
  asWrappingPrivateKey,
  asWrappingPublicKey,
  generateKeyPair,
  generateRecoveryPhrase,
  recoverAccountFromMnemonic,
  sealResetChallenge,
} from '@hushbox/crypto';
import { fromBase64, toBase64 } from '@hushbox/shared';
import {
  createAuthServerFixture,
  expectAccountPrivateKey,
  resetAuthEnvironment,
} from '@/test-utils/auth-server-fixture';

vi.mock('@tanstack/react-router', () => ({ redirect: vi.fn((options) => options) }));

vi.mock('@/providers/query-provider', () => ({
  queryClient: {
    clear: vi.fn(),
    fetchQuery: vi.fn((options: { queryFn: () => unknown }) => options.queryFn()),
  },
  registerSessionRevocationClearer: vi.fn(),
}));

vi.mock('@/lib/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/api')>();
  return { ...actual, getApiUrl: () => 'http://localhost:8787' };
});

vi.mock('@/lib/notification-channel', () => ({
  notificationChannel: { unregister: vi.fn(() => Promise.resolve()) },
}));

import {
  useAuthStore,
  signIn,
  verifyRecoveryPhrase,
  resetPasswordViaRecovery,
  discardVerifiedRecoveryPhrase,
} from './auth';
import { RECOVERY_PHRASE_INVALID_MESSAGE, RECOVERY_PHRASE_MISMATCH_MESSAGE } from './validation';
import type { AuthServerFixture } from '@/test-utils/auth-server-fixture';
import type { ResetPasswordViaRecoveryResult, VerifiedRecoveryPhrase } from './auth';

const NEW_PASSWORD = 'a-brand-new-password';
const CHECKSUM_FAILING_PHRASE =
  'abandon ability able about above absent absorb abstract absurd abuse access accident';

describe('recovery against a real OPAQUE server and real Argon2id', () => {
  let fixture: AuthServerFixture;
  let strangerPhrase: string;
  /** Recovered once: the 64 MiB Argon2id behind it is the file's dominant cost. */
  let recovered: { accountPrivateKey: Uint8Array; recoveryPrivateKey: Uint8Array };

  beforeAll(async () => {
    fixture = await createAuthServerFixture();
    strangerPhrase = generateRecoveryPhrase();
    recovered = await recoverAccountFromMnemonic(
      fixture.account.recoveryPhrase,
      fixture.account.recoveryWrappedPrivateKey
    );
  });

  beforeEach(() => {
    resetAuthEnvironment(fixture);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /**
   * A fresh handle over copies of the once-recovered material — the same value a
   * verification produces, without paying Argon2id again. A successful reset
   * zeroes the handle it is given, so every test needs its own.
   */
  function verifiedHandle(identifier = fixture.identifier): VerifiedRecoveryPhrase {
    return {
      identifier,
      accountPrivateKey: new Uint8Array(recovered.accountPrivateKey),
      recoveryPrivateKey: asWrappingPrivateKey(new Uint8Array(recovered.recoveryPrivateKey)),
    };
  }

  /** The two-step flow the reset UI drives: verify the phrase, then reset. */
  async function verifyThenReset(
    identifier: string,
    phrase: string,
    newPassword: string
  ): Promise<ResetPasswordViaRecoveryResult> {
    const verification = await verifyRecoveryPhrase(identifier, phrase);
    if (!verification.success) return verification;
    return await resetPasswordViaRecovery(verification.verified, newPassword);
  }

  describe('verifyRecoveryPhrase', () => {
    it('returns the account key the phrase recovered', async () => {
      const result = await verifyRecoveryPhrase(fixture.identifier, fixture.account.recoveryPhrase);

      if (!result.success) throw new Error(result.error);
      expect(result.verified.identifier).toBe(fixture.identifier);
      expectAccountPrivateKey(fixture, result.verified.accountPrivateKey);
    });

    it('rejects a phrase that fails the BIP-39 checksum without calling the server', async () => {
      const result = await verifyRecoveryPhrase(fixture.identifier, CHECKSUM_FAILING_PHRASE);

      expect(result).toEqual({ success: false, error: RECOVERY_PHRASE_INVALID_MESSAGE });
      expect(fixture.requests).toHaveLength(0);
    });

    it('refuses a phrase that does not open the account blob before any password is chosen', async () => {
      const result = await verifyRecoveryPhrase(fixture.identifier, strangerPhrase);

      expect(result).toEqual({ success: false, error: RECOVERY_PHRASE_MISMATCH_MESSAGE });
      expect(fixture.requestsTo('/auth/recovery/reset/finish')).toHaveLength(0);
    });

    // The standing proof that this suite fails when the recovery path's cryptography
    // breaks. It is the recovery-side twin of the sign-in suite's tamper and cannot be
    // inferred from it: this key comes from Argon2id over a mnemonic, that one from
    // scrypt over a password, so the two unwraps share no derivation. The flipped byte
    // is the last of the XChaCha20-Poly1305 tag, so what refuses the blob is the real
    // AEAD. The format-version byte at index 0 will not serve: `assertKnownVersion`
    // rejects it before the ECDH, so a tamper there stays green with the AEAD gone.
    it('refuses a served recovery blob whose AEAD tag has been tampered with', async () => {
      const stockBlobRead = fixture.stockRoute('/auth/recovery/get-wrapped-key');
      fixture.serve('/auth/recovery/get-wrapped-key', async (request) => {
        const response = await stockBlobRead(request);
        const body = (await response.json()) as { recoveryWrappedPrivateKey: string };
        const blob = fromBase64(body.recoveryWrappedPrivateKey);
        const tagEnd = blob.length - 1;
        const tampered = blob.map((byte, index) => (index === tagEnd ? byte ^ 0xff : byte));
        return Response.json({ recoveryWrappedPrivateKey: toBase64(tampered) });
      });

      const result = await verifyRecoveryPhrase(fixture.identifier, fixture.account.recoveryPhrase);

      expect(result).toEqual({ success: false, error: RECOVERY_PHRASE_MISMATCH_MESSAGE });
    });

    it('answers a wrong phrase and an unknown identifier with the same result', async () => {
      const wrongPhrase = await verifyRecoveryPhrase(fixture.identifier, strangerPhrase);
      const unknownIdentifier = await verifyRecoveryPhrase(
        'nobody@example.com',
        fixture.account.recoveryPhrase
      );

      expect(unknownIdentifier).toEqual(wrongPhrase);
    });

    it('surfaces the code the server refused the blob read with', async () => {
      fixture.serve('/auth/recovery/get-wrapped-key', () =>
        Response.json({ code: 'NOT_FOUND' }, { status: 404 })
      );

      const result = await verifyRecoveryPhrase(fixture.identifier, fixture.account.recoveryPhrase);

      expect(result).toEqual({
        success: false,
        error: "The item you're looking for doesn't exist.",
      });
    });

    it('returns a retryable error when the request itself throws', async () => {
      fixture.serve('/auth/recovery/get-wrapped-key', () => {
        throw new Error('offline');
      });

      const result = await verifyRecoveryPhrase(fixture.identifier, fixture.account.recoveryPhrase);

      expect(result).toEqual({
        success: false,
        error: 'Something went wrong. Please try again later.',
      });
    });

    it('sends an email identifier unchanged', async () => {
      await verifyRecoveryPhrase('user@example.com', strangerPhrase);

      const [request] = fixture.requestsTo('/auth/recovery/get-wrapped-key');
      expect(request?.body['identifier']).toBe('user@example.com');
    });

    it('normalizes a username identifier', async () => {
      await verifyRecoveryPhrase('Test User', strangerPhrase);

      const [request] = fixture.requestsTo('/auth/recovery/get-wrapped-key');
      expect(request?.body['identifier']).toBe('test_user');
    });

    // `verifyRecoveryPhrase` derives the phrase key immediately after this fetch and
    // is the only caller of `recoverAccountFromMnemonic` under `apps/web/src`, so the
    // request count bounds the 64 MiB derivation count: a third request would mean
    // the reset step re-derived what the verification step already held.
    it('fetches the account blob once per phrase attempt, not once per step', async () => {
      await verifyRecoveryPhrase(fixture.identifier, strangerPhrase);
      const result = await verifyThenReset(
        fixture.identifier,
        fixture.account.recoveryPhrase,
        NEW_PASSWORD
      );

      expect(result).toEqual({ success: true });
      expect(fixture.requestsTo('/auth/recovery/get-wrapped-key')).toHaveLength(2);
    });
  });

  describe('resetPasswordViaRecovery', () => {
    it('derives a proof the server accepts for a mixed-case email identifier', async () => {
      const result = await resetPasswordViaRecovery(
        verifiedHandle('Test@Example.COM'),
        NEW_PASSWORD
      );

      expect(result).toEqual({ success: true });
      expect(fixture.requestsTo('/auth/recovery/reset/finish')).toHaveLength(1);
    });

    it('sends the proof field without canonicalizing the identifier on the wire', async () => {
      await resetPasswordViaRecovery(verifiedHandle('Test@Example.COM'), NEW_PASSWORD);

      const [request] = fixture.requestsTo('/auth/recovery/reset/finish');
      expect(request?.body['resetProof']).toEqual(expect.any(String));
      expect(request?.body['identifier']).toBe('Test@Example.COM');
    });

    it('replaces the password so a later sign-in opens the same account key', async () => {
      await resetPasswordViaRecovery(verifiedHandle(), NEW_PASSWORD);

      await signIn.email({ identifier: fixture.identifier, password: NEW_PASSWORD });

      expectAccountPrivateKey(fixture, useAuthStore.getState().privateKey);
    });

    it('zeroes the verified key material once the reset lands', async () => {
      const verified = verifiedHandle();

      await resetPasswordViaRecovery(verified, NEW_PASSWORD);

      expect([...verified.accountPrivateKey]).toEqual(
        Array.from<number>({ length: verified.accountPrivateKey.length }).fill(0)
      );
      expect([...verified.recoveryPrivateKey]).toEqual(
        Array.from<number>({ length: verified.recoveryPrivateKey.length }).fill(0)
      );
    });

    it('keeps the verified key material when the reset fails, so a retry can reuse it', async () => {
      fixture.serve('/auth/recovery/reset/finish', () =>
        Response.json({ code: 'NO_PENDING_RECOVERY' }, { status: 401 })
      );
      const verified = verifiedHandle();

      await resetPasswordViaRecovery(verified, NEW_PASSWORD);

      expect([...verified.accountPrivateKey]).toEqual([...recovered.accountPrivateKey]);
    });

    it('wraps the real account key when the handle is zeroed mid-flight', async () => {
      const verified = verifiedHandle();
      // The zeroing lands inside the OPAQUE span, which is where a "Back to
      // recovery" click during a reset puts it.
      const stockResetInit = fixture.stockRoute('/auth/recovery/reset/init');
      fixture.serve('/auth/recovery/reset/init', async (request) => {
        discardVerifiedRecoveryPhrase(verified);
        return await stockResetInit(request);
      });

      await resetPasswordViaRecovery(verified, NEW_PASSWORD);
      await signIn.email({ identifier: fixture.identifier, password: NEW_PASSWORD });

      // A zeroed handle would have wrapped 32 zero bytes, which the server accepts
      // and no later login can detect — except by unwrapping it, as this does.
      expectAccountPrivateKey(fixture, useAuthStore.getState().privateKey);
    });

    it('wraps the real account key in a second reset that overlaps the first', async () => {
      const verified = verifiedHandle();
      let releaseSecondReset = (): void => {};
      const secondResetMayProceed = new Promise<void>((resolve) => {
        releaseSecondReset = resolve;
      });
      const stockResetInit = fixture.stockRoute('/auth/recovery/reset/init');
      let started = 0;
      fixture.serve('/auth/recovery/reset/init', async (request) => {
        started += 1;
        if (started === 2) await secondResetMayProceed;
        return await stockResetInit(request);
      });

      const firstReset = resetPasswordViaRecovery(verified, 'first-new-password');
      const secondReset = resetPasswordViaRecovery(verified, NEW_PASSWORD);
      // The first reset succeeds and zeroes the shared handle while the second is
      // parked in its OPAQUE span.
      expect(await firstReset).toEqual({ success: true });
      releaseSecondReset();
      expect(await secondReset).toEqual({ success: true });

      await signIn.email({ identifier: fixture.identifier, password: NEW_PASSWORD });
      expectAccountPrivateKey(fixture, useAuthStore.getState().privateKey);
    });

    it('reports a failure when the sealed challenge was sealed to another key', async () => {
      const stranger = generateKeyPair();
      const stockResetInit = fixture.stockRoute('/auth/recovery/reset/init');
      fixture.serve('/auth/recovery/reset/init', async (request) => {
        const response = await stockResetInit(request);
        const body = (await response.json()) as Record<string, unknown>;
        return Response.json({
          ...body,
          sealedChallenge: toBase64(
            sealResetChallenge(
              asWrappingPublicKey(stranger.publicKey),
              crypto.getRandomValues(new Uint8Array(RESET_CHALLENGE_NONCE_BYTES))
            )
          ),
        });
      });

      const result = await resetPasswordViaRecovery(verifiedHandle(), NEW_PASSWORD);

      expect(result).toEqual({
        success: false,
        error: 'Password change failed. Please try again.',
      });
    });

    it('surfaces the code the server refused the reset init with', async () => {
      fixture.serve('/auth/recovery/reset/init', () =>
        Response.json({ code: 'REGISTRATION_FAILED' }, { status: 400 })
      );

      const result = await resetPasswordViaRecovery(verifiedHandle(), NEW_PASSWORD);

      expect(result).toEqual({
        success: false,
        error: 'Registration failed. Please try again.',
      });
    });

    it('surfaces the code the server refused the reset finish with', async () => {
      fixture.serve('/auth/recovery/reset/finish', () =>
        Response.json({ code: 'NO_PENDING_RECOVERY' }, { status: 401 })
      );

      const result = await resetPasswordViaRecovery(verifiedHandle(), NEW_PASSWORD);

      expect(result).toEqual({
        success: false,
        error: 'Your recovery attempt expired. Please try again.',
      });
    });
  });
});
