import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { unwrapAccountKeyWithPassword } from '@hushbox/crypto';
import { TERMS_OF_SERVICE_REVISION, fromBase64 } from '@hushbox/shared';
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
  signUp,
  changePassword,
  disable2FAInit,
  disable2FAFinish,
  saveRecoveryMaterial,
} from './auth';
import { persistExportKey, STORAGE_KEY } from './client.js';
import { loadExportKeyProtected } from '../device-key-store.js';
import type { AuthServerFixture, AuthTestEnvironment } from '@/test-utils/auth-server-fixture';

const NEW_PASSWORD = 'a-brand-new-password';

describe('credential flows against a real OPAQUE server', () => {
  let fixture: AuthServerFixture;
  let environment: AuthTestEnvironment;

  beforeAll(async () => {
    fixture = await createAuthServerFixture();
  });

  beforeEach(() => {
    environment = resetAuthEnvironment(fixture);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function bodyField(path: string, name: string): string {
    const [request] = fixture.requestsTo(path);
    if (!request) throw new Error(`Expected a request to ${path}`);
    const value = request.body[name];
    if (typeof value !== 'string') throw new TypeError(`${name} is not a string`);
    return value;
  }

  describe('signUp.email', () => {
    const signupParams = {
      username: 'test_user',
      email: 'new@example.com',
      password: NEW_PASSWORD,
    };

    it('registers an account whose password later opens the key the registration wrapped', async () => {
      const registration = await signUp.email(signupParams);
      expect(registration.error).toBeUndefined();
      const registeredPublicKey = fromBase64(
        bodyField('/auth/register/finish', 'accountPublicKey')
      );

      await signIn.email({ identifier: signupParams.email, password: NEW_PASSWORD });

      expectAccountPrivateKey(fixture, useAuthStore.getState().privateKey, registeredPublicKey);
    });

    it('sends the account blobs to register/finish and no credential material', async () => {
      await signUp.email(signupParams);

      const [request] = fixture.requestsTo('/auth/register/finish');
      expect(request?.body).toEqual({
        email: signupParams.email,
        registrationRecord: expect.arrayContaining([expect.any(Number)]),
        registerSessionId: expect.any(String),
        accountPublicKey: expect.any(String),
        passwordWrappedPrivateKey: expect.any(String),
        recoveryWrappedPrivateKey: expect.any(String),
        recoveryPublicKey: expect.any(String),
        acquisition: { platform: 'web' },
        acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
      });
      expect(fromBase64(bodyField('/auth/register/finish', 'accountPublicKey'))).toHaveLength(32);
    });

    it('sends the current Terms revision as the one the user accepted', async () => {
      await signUp.email(signupParams);

      const [finish] = fixture.requestsTo('/auth/register/finish');
      expect(finish?.body['acceptedTermsRevision']).toBe(TERMS_OF_SERVICE_REVISION);
    });

    it('sends the campaign tag the signup link carried with both rounds', async () => {
      await signUp.email({ ...signupParams, campaign: 'spring-podcast' });

      const [init] = fixture.requestsTo('/auth/register/init');
      expect(init?.body['c']).toBe('spring-podcast');
      const [finish] = fixture.requestsTo('/auth/register/finish');
      expect(finish?.body['acquisition']).toEqual({
        campaign: 'spring-podcast',
        platform: 'web',
      });
    });

    it('sends no campaign field at all when the link carried no tag', async () => {
      await signUp.email(signupParams);

      const [init] = fixture.requestsTo('/auth/register/init');
      expect(init?.body).not.toHaveProperty('c');
      const [finish] = fixture.requestsTo('/auth/register/finish');
      expect(finish?.body['acquisition']).toEqual({ platform: 'web' });
    });

    it('normalizes the username before sending it to the API', async () => {
      await signUp.email({ ...signupParams, username: 'John Smith' });

      expect(bodyField('/auth/register/init', 'username')).toBe('john_smith');
    });

    it('surfaces the code the server refused the registration init with', async () => {
      fixture.serve('/auth/register/init', () =>
        Response.json({ code: 'CONFLICT' }, { status: 409 })
      );

      const result = await signUp.email(signupParams);

      expect(result.error).toEqual({
        message: 'This action conflicts with the current state. Please refresh and try again.',
      });
    });

    it('surfaces the code the server refused the registration finish with', async () => {
      fixture.serve('/auth/register/finish', () =>
        Response.json({ code: 'REGISTRATION_FAILED' }, { status: 400 })
      );

      const result = await signUp.email(signupParams);

      expect(result.error).toEqual({ message: 'Registration failed. Please try again.' });
    });

    it('returns a registration failure when the network is down', async () => {
      fixture.serve('/auth/register/init', () => {
        throw new Error('Network error');
      });

      const result = await signUp.email(signupParams);

      expect(result.error).toEqual({ message: 'Registration failed. Please try again.' });
    });
  });

  describe('changePassword', () => {
    beforeEach(() => {
      // A copy: `useAuthStore.clear()` zeroes the buffer it holds, and zeroing the
      // fixture's own account key would corrupt every later test in this file.
      useAuthStore.setState({ privateKey: new Uint8Array(fixture.accountPrivateKey) });
    });

    it('replaces the password so a later sign-in opens the same account key', async () => {
      const result = await changePassword(fixture.password, NEW_PASSWORD);
      expect(result).toEqual({ success: true });

      useAuthStore.getState().clear();
      await signIn.email({ identifier: fixture.identifier, password: NEW_PASSWORD });

      expectAccountPrivateKey(fixture, useAuthStore.getState().privateKey);
    });

    it('saves an export key on this device that opens the newly wrapped account key', async () => {
      await persistExportKey(fixture.exportKey, fixture.userId, true);

      await changePassword(fixture.password, NEW_PASSWORD);

      const stored = await loadExportKeyProtected();
      if (!stored) throw new Error('Expected a stored export key');
      expectAccountPrivateKey(
        fixture,
        unwrapAccountKeyWithPassword(stored.exportKey, fixture.passwordWrappedPrivateKey)
      );
    });

    it('keeps the marker in the storage area the stored session put it in', async () => {
      await persistExportKey(fixture.exportKey, fixture.userId, true);

      await changePassword(fixture.password, NEW_PASSWORD);

      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('writes no device key when no sign-in marker exists', async () => {
      const result = await changePassword(fixture.password, NEW_PASSWORD);

      expect(result).toEqual({ success: true });
      expect(await loadExportKeyProtected()).toBeNull();
    });

    it('tells the user the password changed when the device key write fails after the server commits', async () => {
      await persistExportKey(fixture.exportKey, fixture.userId, false);
      environment.indexedDb.failOpen = true;

      const result = await changePassword(fixture.password, NEW_PASSWORD);

      expect(result).toEqual({
        success: false,
        error:
          'Your password was changed. This device could not save the new key, so sign in again with your new password.',
      });
    });

    it('reports the account key as unavailable when the store holds none', async () => {
      useAuthStore.setState({ privateKey: null });

      const result = await changePassword(fixture.password, NEW_PASSWORD);

      expect(result).toEqual({
        success: false,
        error: 'Your encryption key is unavailable. Please log out and log back in.',
      });
    });

    it('surfaces the code the server refused the change-password init with', async () => {
      fixture.serve('/auth/change-password/init', () =>
        Response.json({ code: 'AUTH_FAILED' }, { status: 401 })
      );

      const result = await changePassword(fixture.password, NEW_PASSWORD);

      expect(result).toEqual({
        success: false,
        error: 'Incorrect username, email, or password. Please try again.',
      });
    });

    it('surfaces the code the server refused the change-password finish with', async () => {
      fixture.serve('/auth/change-password/finish', () =>
        Response.json({ code: 'NO_PENDING_STEP_UP' }, { status: 401 })
      );

      const result = await changePassword(fixture.password, NEW_PASSWORD);

      expect(result).toEqual({
        success: false,
        error: 'Your confirmation expired. Please try again.',
      });
    });

    it('returns a change failure when the network is down', async () => {
      fixture.serve('/auth/change-password/init', () => {
        throw new Error('Network error');
      });

      const result = await changePassword(fixture.password, NEW_PASSWORD);

      expect(result).toEqual({
        success: false,
        error: 'Password change failed. Please try again.',
      });
    });
  });

  describe('disable2FA', () => {
    const sessionId = '00000000-0000-4000-8000-deadbeefdead';

    it('returns a ke3 the server accepts as proof of the password', async () => {
      const initiated = await disable2FAInit(fixture.password);
      if (!initiated.success) throw new Error('Expected the step-up to start');

      const finished = await disable2FAFinish(
        initiated.ke3,
        fixture.totpCode,
        initiated.disable2FASessionId
      );

      expect(finished).toEqual({ success: true });
    });

    it('reports an incorrect password without sending a proof', async () => {
      const result = await disable2FAInit('not-the-password');

      expect(result).toEqual({
        success: false,
        error: 'Failed to start two-factor disable. Please try again.',
      });
      expect(fixture.requestsTo('/auth/2fa/disable/finish')).toHaveLength(0);
    });

    it('surfaces the code the server refused the init round with', async () => {
      fixture.serve('/auth/2fa/disable/init', () =>
        Response.json({ code: 'AUTH_FAILED' }, { status: 401 })
      );

      const result = await disable2FAInit(fixture.password);

      expect(result).toEqual({
        success: false,
        error: 'Incorrect username, email, or password. Please try again.',
      });
    });

    it('returns an init failure when the network is down', async () => {
      fixture.serve('/auth/2fa/disable/init', () => {
        throw new Error('Network error');
      });

      const result = await disable2FAInit(fixture.password);

      expect(result).toEqual({
        success: false,
        error: 'Failed to start two-factor disable. Please try again.',
      });
    });

    it('reports an invalid two-factor code from the finish round', async () => {
      const initiated = await disable2FAInit(fixture.password);
      if (!initiated.success) throw new Error('Expected the step-up to start');

      const result = await disable2FAFinish(initiated.ke3, '000000', initiated.disable2FASessionId);

      expect(result).toEqual({
        success: false,
        error: 'That code is incorrect or has expired. Please try again.',
      });
    });

    it('reports a rate limit from the finish round', async () => {
      fixture.serve('/auth/2fa/disable/finish', () =>
        Response.json({ code: 'TOO_MANY_ATTEMPTS' }, { status: 429 })
      );

      const result = await disable2FAFinish([4, 5, 6], fixture.totpCode, sessionId);

      expect(result).toEqual({
        success: false,
        error: 'Too many attempts. Try again in a moment.',
      });
    });

    it('returns a verification failure when the network is down', async () => {
      fixture.serve('/auth/2fa/disable/finish', () => {
        throw new Error('Network error');
      });

      const result = await disable2FAFinish([4, 5, 6], fixture.totpCode, sessionId);

      expect(result).toEqual({
        success: false,
        error: 'Two-factor verification failed. Please try again.',
      });
    });

    it('sends the proof, the code and the session id to the finish endpoint', async () => {
      await disable2FAFinish([4, 5, 6], fixture.totpCode, sessionId);

      const [request] = fixture.requestsTo('/auth/2fa/disable/finish');
      expect(request?.body).toEqual({
        ke3: [4, 5, 6],
        code: fixture.totpCode,
        disable2FASessionId: sessionId,
      });
    });
  });

  describe('saveRecoveryMaterial', () => {
    const material = {
      recoveryWrappedPrivateKey: 'wrapped-blob',
      recoveryPublicKey: 'public-half',
    };

    it('sends the material only on the round the proof gates', async () => {
      const result = await saveRecoveryMaterial(fixture.password, material);

      expect(result).toEqual({ success: true });
      const [init] = fixture.requestsTo('/auth/recovery/save/init');
      const [finish] = fixture.requestsTo('/auth/recovery/save/finish');
      // The init round carries the challenge and nothing else: the material rides
      // the call the proof gates, so an unproven request never carries it.
      expect(Object.keys(init?.body ?? {})).toEqual(['ke1']);
      expect(finish?.body).toEqual({
        ke3: expect.arrayContaining([expect.any(Number)]),
        recoverySaveSessionId: expect.any(String),
        ...material,
      });
    });

    it('reports an incorrect password without sending the material', async () => {
      // OPAQUE is constant-time: `/init` answers every password identically and a
      // wrong one fails in the client's own MAC check, never on the wire.
      const result = await saveRecoveryMaterial('not-the-password', material);

      expect(result).toEqual({ success: false, error: 'Incorrect password.' });
      expect(fixture.requestsTo('/auth/recovery/save/finish')).toHaveLength(0);
    });

    it('surfaces a refused proof from the finish round', async () => {
      fixture.serve('/auth/recovery/save/finish', () =>
        Response.json({ code: 'AUTH_FAILED' }, { status: 401 })
      );

      const result = await saveRecoveryMaterial(fixture.password, material);

      expect(result).toEqual({
        success: false,
        error: 'Incorrect username, email, or password. Please try again.',
      });
    });

    it('surfaces an expired handshake from the finish round', async () => {
      fixture.serve('/auth/recovery/save/finish', () =>
        Response.json({ code: 'NO_PENDING_STEP_UP' }, { status: 401 })
      );

      const result = await saveRecoveryMaterial(fixture.password, material);

      expect(result).toEqual({
        success: false,
        error: 'Your confirmation expired. Please try again.',
      });
    });

    it('surfaces a refused init round', async () => {
      fixture.serve('/auth/recovery/save/init', () =>
        Response.json({ code: 'AUTH_FAILED' }, { status: 401 })
      );

      const result = await saveRecoveryMaterial(fixture.password, material);

      expect(result).toEqual({
        success: false,
        error: 'Incorrect username, email, or password. Please try again.',
      });
      expect(fixture.requestsTo('/auth/recovery/save/finish')).toHaveLength(0);
    });

    it('returns a mapped failure when the network is down', async () => {
      fixture.serve('/auth/recovery/save/init', () => {
        throw new Error('Network error');
      });

      const result = await saveRecoveryMaterial(fixture.password, material);

      expect(result).toEqual({
        success: false,
        error: 'Failed to save recovery material. Please try again.',
      });
    });
  });
});
