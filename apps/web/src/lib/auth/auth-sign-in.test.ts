import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { toBase64 } from '@hushbox/shared';
import { expectExposes } from '@hushbox/shared/test-assertions';
import {
  createAuthServerFixture,
  expectAccountPrivateKey,
  resetAuthEnvironment,
} from '@/test-utils/auth-server-fixture';

vi.mock('@tanstack/react-router', () => ({ redirect: vi.fn((options) => options) }));

vi.mock('@/providers/query-provider', () => ({
  queryClient: {
    clear: vi.fn(),
    // Delegates to the queryFn so every bootstrap read hits the fixture's server.
    // The retry policy itself is covered against a real QueryClient in client.test.ts.
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

import { useAuthStore, signIn } from './auth';
import { STORAGE_KEY } from './client.js';
import type { AuthServerFixture } from '@/test-utils/auth-server-fixture';

describe('signIn.email against a real OPAQUE server', () => {
  let fixture: AuthServerFixture;

  beforeAll(async () => {
    fixture = await createAuthServerFixture();
  });

  beforeEach(() => {
    resetAuthEnvironment(fixture);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function credentials(): { identifier: string; password: string } {
    return { identifier: fixture.identifier, password: fixture.password };
  }

  /** Waits for the instruction read that login fired beside the session to answer. */
  async function instructionsRead(): Promise<void> {
    await vi.waitFor(() => {
      expect(useAuthStore.getState().customInstructionsStatus).not.toBe('pending');
    });
  }

  it('completes the OPAQUE login and stores the account key the password unwraps', async () => {
    const result = await signIn.email(credentials());

    expect(result.error).toBeUndefined();
    expectAccountPrivateKey(fixture, useAuthStore.getState().privateKey);
    expect(useAuthStore.getState().user).toEqual(fixture.user);
  });

  it('refuses a password the registration record does not answer to', async () => {
    const result = await signIn.email({ ...credentials(), password: 'not-the-password' });

    expect(result.error).toEqual({
      message: 'Login failed. Please check your credentials and try again.',
    });
    expect(useAuthStore.getState().privateKey).toBeNull();
  });

  // The standing proof that this suite fails when a step of the real flow breaks.
  // The flipped byte is the last of the XChaCha20-Poly1305 tag, so what refuses the
  // blob is the real AEAD and no amount of correct protocol upstream rescues the
  // sign-in. The format-version byte at index 0 will not serve: `assertKnownVersion`
  // rejects it before the ECDH, so a tamper there stays green with the AEAD gone.
  it('fails the sign-in when the served wrapped key has been tampered with', async () => {
    const tagEnd = fixture.account.passwordWrappedPrivateKey.length - 1;
    fixture.passwordWrappedPrivateKey = fixture.account.passwordWrappedPrivateKey.map(
      (byte, index) => (index === tagEnd ? byte ^ 0xff : byte)
    );

    const result = await signIn.email(credentials());

    expect(result.error).toEqual({
      message: 'Login failed. Please check your credentials and try again.',
    });
    expect(useAuthStore.getState().privateKey).toBeNull();
    expect(useAuthStore.getState().user).toBeNull();
  });

  it('routes OPAQUE requests through the header shim, preserving the byte-array body', async () => {
    await signIn.email(credentials());

    const [initCall] = fixture.requestsTo('/auth/login/init');
    if (!initCall) throw new Error('Expected a login/init request');
    // The version gate + platform attribution headers ride only the shared
    // header-injecting fetch; a raw fetch would carry neither and could not
    // receive the 426 upgrade gate.
    const headers = new Headers(initCall.init?.headers);
    expect(headers.get('X-App-Version')).toBeTruthy();
    expect(headers.get('X-HushBox-Platform')).toBeTruthy();
    // The server deserialized this body into a KE1 and answered it, so the shim
    // passed the OPAQUE byte array through unchanged.
    expect(initCall.body['ke1']).toEqual(expect.arrayContaining([expect.any(Number)]));
  });

  it('seeds custom instructions from the account route on login', async () => {
    fixture.instructions = fixture.encryptInstructions('Be concise and direct');

    await signIn.email(credentials());
    await instructionsRead();

    expect(useAuthStore.getState().customInstructions).toBe('Be concise and direct');
  });

  it('leaves custom instructions null when the account has none stored', async () => {
    await signIn.email(credentials());
    await instructionsRead();

    expect(useAuthStore.getState().customInstructions).toBeNull();
    expect(useAuthStore.getState().customInstructionsStatus).toBe('absent');
  });

  it('completes the login while the instruction read is still open', async () => {
    fixture.serve('/account/instructions', () => new Promise<Response>(() => {}));

    const result = await signIn.email(credentials());

    expect(result.error).toBeUndefined();
    expect(useAuthStore.getState().user).toEqual(fixture.user);
    expect(useAuthStore.getState().isAuthenticated).toBe(true);
    expect(useAuthStore.getState().customInstructionsStatus).toBe('pending');
  });

  it('normalizes a username identifier before sending it to the API', async () => {
    await signIn.email({ identifier: 'John Smith', password: fixture.password });

    const [initCall] = fixture.requestsTo('/auth/login/init');
    const [finishCall] = fixture.requestsTo('/auth/login/finish');
    expect(initCall?.body['identifier']).toBe('john_smith');
    expect(finishCall?.body['identifier']).toBe('john_smith');
  });

  it('does not normalize email identifiers', async () => {
    await signIn.email({ identifier: 'User@Example.com', password: fixture.password });

    const [initCall] = fixture.requestsTo('/auth/login/init');
    expect(initCall?.body['identifier']).toBe('User@Example.com');
  });

  it('holds the sign-in marker in sessionStorage by default', async () => {
    await signIn.email(credentials());

    expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      userId: fixture.userId,
    });
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('holds the sign-in marker in localStorage when keepSignedIn is set', async () => {
    await signIn.email({ ...credentials(), keepSignedIn: true });

    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
      userId: fixture.userId,
    });
    expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('surfaces the code the server refused the login init with', async () => {
    fixture.serve('/auth/login/init', () =>
      Response.json({ code: 'AUTH_FAILED' }, { status: 401 })
    );

    const result = await signIn.email(credentials());

    expect(result.error).toEqual({
      message: 'Incorrect username, email, or password. Please try again.',
      code: 'AUTH_FAILED',
    });
  });

  it('surfaces the code the server refused the login finish with', async () => {
    fixture.serve('/auth/login/finish', () =>
      Response.json({ code: 'NO_PENDING_LOGIN' }, { status: 401 })
    );

    const result = await signIn.email(credentials());

    expect(result.error).toEqual({
      message: 'Your login attempt expired. Please try again.',
      code: 'NO_PENDING_LOGIN',
    });
  });

  it('reports missing account encryption when the server serves no wrapped key', async () => {
    fixture.serve('/auth/login/finish', () =>
      Response.json({ success: true, userId: fixture.userId })
    );

    const result = await signIn.email(credentials());

    expect(result.error).toEqual({
      message: 'Your account encryption is not configured. Please contact support.',
    });
  });

  it('returns a login failure when the network is down', async () => {
    fixture.serve('/auth/login/init', () => {
      throw new Error('Network error');
    });

    const result = await signIn.email(credentials());

    expect(result.error).toEqual({
      message: 'Login failed. Please check your credentials and try again.',
    });
  });

  it('fails the login and never fabricates account flags when the account read fails', async () => {
    fixture.serve('/auth/me', () => Response.json({ code: 'INTERNAL' }, { status: 500 }));

    const result = await signIn.email(credentials());

    // A transient /me failure must error the login, not silently downgrade real
    // account flags to a fabricated emailVerified/totpEnabled/hasAcknowledgedPhrase.
    expect(result.error).toBeDefined();
    expect(useAuthStore.getState().user).toBeNull();
  });

  describe('two-factor challenge', () => {
    beforeEach(() => {
      fixture.requires2FA = true;
    });

    it('hands back a verifier instead of a session when the account has two-factor on', async () => {
      const result = await signIn.email(credentials());

      expect(result.requires2FA).toBe(true);
      expectExposes(result, 'verifyTOTP');
      expect(useAuthStore.getState().privateKey).toBeNull();
    });

    it('completes the sign-in with a verified code, on the export key login produced', async () => {
      const result = await signIn.email(credentials());
      if (!result.verifyTOTP) throw new Error('Expected a verifyTOTP callback');

      const verified = await result.verifyTOTP(fixture.totpCode);

      expect(verified.success).toBe(true);
      expectAccountPrivateKey(fixture, useAuthStore.getState().privateKey);
      expect(JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null')).toEqual({
        userId: fixture.userId,
      });
    });

    it('reports an incorrect two-factor code', async () => {
      const result = await signIn.email(credentials());
      if (!result.verifyTOTP) throw new Error('Expected a verifyTOTP callback');

      const verified = await result.verifyTOTP('000000');

      expect(verified).toEqual({
        success: false,
        error: 'That code is incorrect or has expired. Please try again.',
      });
    });

    it('reports a network failure during two-factor verification', async () => {
      const result = await signIn.email(credentials());
      if (!result.verifyTOTP) throw new Error('Expected a verifyTOTP callback');
      fixture.serve('/auth/login/2fa/verify', () => {
        throw new Error('Network error');
      });

      const verified = await result.verifyTOTP(fixture.totpCode);

      expect(verified).toEqual({
        success: false,
        error: 'Two-factor verification failed. Please try again.',
      });
    });

    it('retries finalization without a second verify call when the account read fails once', async () => {
      const result = await signIn.email(credentials());
      if (!result.verifyTOTP) throw new Error('Expected a verifyTOTP callback');
      let meAttempts = 0;
      fixture.serve('/auth/me', () => {
        meAttempts += 1;
        if (meAttempts === 1) throw new Error('Account read failed');
        return Response.json({
          user: fixture.user,
          passwordWrappedPrivateKey: toBase64(fixture.passwordWrappedPrivateKey),
          publicKey: toBase64(fixture.account.publicKey),
        });
      });

      const verified = await result.verifyTOTP(fixture.totpCode);

      expect(verified.success).toBe(true);
      expect(meAttempts).toBe(2);
      expect(fixture.requestsTo('/auth/login/2fa/verify')).toHaveLength(1);
    });

    it('never blames the code when finalization keeps failing after a verified code', async () => {
      const result = await signIn.email(credentials());
      if (!result.verifyTOTP) throw new Error('Expected a verifyTOTP callback');
      fixture.serve('/auth/me', () => {
        throw new Error('Account read failed');
      });

      const verified = await result.verifyTOTP(fixture.totpCode);

      expect(verified).toEqual({
        success: false,
        error:
          'Your code was accepted, but signing in could not be completed. Reload the page and try again.',
      });
    });
  });
});
