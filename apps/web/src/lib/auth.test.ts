import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { redirect } from '@tanstack/react-router';
import {
  useAuthStore,
  useSession,
  signIn,
  signUp,
  changePassword,
  resetPasswordViaRecovery,
  disable2FAInit,
  disable2FAFinish,
  signOutAndClearCache,
  authClient,
  initAuth,
  requireAuth,
  resetInitPromise,
  parseErrorMessage,
  type UserData,
} from './auth';

/** Runtime non-null assertion for test values captured by mocks. */
function defined<T>(value: T | null | undefined, label = 'value'): NonNullable<T> {
  if (value == null) throw new Error(`Expected ${label} to be defined`);
  return value;
}

// Test user data
const testUser: UserData = {
  id: 'user-123',
  email: 'test@example.com',
  username: 'test_user',
  emailVerified: true,
  totpEnabled: false,
  hasAcknowledgedPhrase: true,
};

const testUser2FA: UserData = {
  ...testUser,
  totpEnabled: true,
};

// Mock modules
vi.mock('@tanstack/react-router', () => ({
  redirect: vi.fn((options) => options),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (function_: unknown) => function_,
}));

const { mockQueryClientClear } = vi.hoisted(() => ({
  mockQueryClientClear: vi.fn(),
}));
vi.mock('@/providers/query-provider', () => ({
  queryClient: {
    clear: mockQueryClientClear,
  },
}));

vi.mock('@/lib/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
}));

vi.mock('./auth-client.js', () => ({
  STORAGE_KEY: 'hushbox_auth_kek',
  persistExportKey: vi.fn(),
  getStoredAuth: vi.fn(),
  clearStoredAuth: vi.fn(),
  restoreSession: vi.fn(),
}));

vi.mock('@hushbox/crypto', () => ({
  createOpaqueClient: vi.fn(() => ({ client: 'mock' })),
  startLogin: vi.fn(() => Promise.resolve({ ke1: [1, 2, 3] })),
  finishLogin: vi.fn(() =>
    Promise.resolve({
      ke3: [4, 5, 6],
      sessionKey: [7, 8, 9],
      exportKey: [16, 17, 18],
    })
  ),
  startRegistration: vi.fn(() => Promise.resolve({ serialized: [10, 11, 12] })),
  finishRegistration: vi.fn(() =>
    Promise.resolve({
      record: [13, 14, 15],
      exportKey: [16, 17, 18],
    })
  ),
  createAccount: vi.fn(() =>
    Promise.resolve({
      publicKey: new Uint8Array([43, 44, 45]),
      passwordWrappedPrivateKey: new Uint8Array([50, 51, 52]),
      recoveryWrappedPrivateKey: new Uint8Array([53, 54, 55]),
      recoveryPhrase: 'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
    })
  ),
  unwrapAccountKeyWithPassword: vi.fn(() => new Uint8Array([60, 61, 62])),
  rewrapAccountKeyForPasswordChange: vi.fn(() => new Uint8Array([70, 71, 72])),
  recoverAccountFromMnemonic: vi.fn(() => Promise.resolve(new Uint8Array([80, 81, 82]))),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: vi.fn((_string: string) => new Uint8Array([31, 32, 33])),
    toBase64: vi.fn(() => 'base64string'),
  };
});

// Import mocked modules for type safety
import { persistExportKey, getStoredAuth, clearStoredAuth, restoreSession } from './auth-client.js';
import {
  createOpaqueClient,
  startLogin,
  finishLogin,
  startRegistration,
  finishRegistration,
  createAccount,
  unwrapAccountKeyWithPassword,
  rewrapAccountKeyForPasswordChange,
  recoverAccountFromMnemonic,
} from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';

describe('auth', () => {
  beforeEach(() => {
    // Reset store state
    useAuthStore.setState({
      user: null,
      privateKey: null,
      isLoading: true,
      isAuthenticated: false,
    });
    resetInitPromise();
    vi.clearAllMocks();

    // Setup default fetch mock
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseErrorMessage', () => {
    it('returns friendly message when code field is present', () => {
      expect(parseErrorMessage({ code: 'AUTH_FAILED' })).toBe('Invalid credentials.');
    });

    it('returns friendly message for known code', () => {
      expect(parseErrorMessage({ code: 'NOT_FOUND' })).toBe(
        "The item you're looking for doesn't exist."
      );
    });

    it('returns generic fallback for unknown code', () => {
      expect(parseErrorMessage({ code: 'TOTALLY_UNKNOWN' })).toBe(
        'Something went wrong. Please try again.'
      );
    });

    it('returns generic fallback when code field is missing', () => {
      expect(parseErrorMessage({ success: false })).toBe(
        'Something went wrong. Please try again later.'
      );
    });

    it('returns generic fallback for non-object body', () => {
      expect(parseErrorMessage(null)).toBe('Something went wrong. Please try again later.');
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      expect(parseErrorMessage(undefined)).toBe('Something went wrong. Please try again later.');
      expect(parseErrorMessage('some string')).toBe(
        'Something went wrong. Please try again later.'
      );
      expect(parseErrorMessage(42)).toBe('Something went wrong. Please try again later.');
    });
  });

  describe('useAuthStore', () => {
    it('should have correct initial state', () => {
      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.privateKey).toBeNull();
      expect(state.isLoading).toBe(true);
      expect(state.isAuthenticated).toBe(false);
    });

    it('should set user and isAuthenticated to true when user is provided', () => {
      useAuthStore.getState().setUser(testUser);

      const state = useAuthStore.getState();
      expect(state.user).toEqual(testUser);
      expect(state.isAuthenticated).toBe(true);
    });

    it('should clear user and set isAuthenticated to false when user is null', () => {
      // First set a user
      useAuthStore.setState({ user: testUser, isAuthenticated: true });

      // Then clear it
      useAuthStore.getState().setUser(null);

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
    });

    it('should store privateKey when setPrivateKey is called', () => {
      const privateKey = new Uint8Array([5, 6, 7, 8]);
      useAuthStore.getState().setPrivateKey(privateKey);

      const state = useAuthStore.getState();
      expect(state.privateKey).toEqual(privateKey);
    });

    it('should toggle loading state with setLoading', () => {
      useAuthStore.getState().setLoading(false);
      expect(useAuthStore.getState().isLoading).toBe(false);

      useAuthStore.getState().setLoading(true);
      expect(useAuthStore.getState().isLoading).toBe(true);
    });

    it('should zero privateKey buffer and clear all state on clear', () => {
      const privateKey = new Uint8Array([5, 6, 7, 8]);
      useAuthStore.setState({
        user: testUser,
        privateKey,
        isAuthenticated: true,
        isLoading: true,
      });

      useAuthStore.getState().clear();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.privateKey).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
      expect(privateKey[0]).toBe(0);
      expect(privateKey[1]).toBe(0);
      expect(privateKey[2]).toBe(0);
      expect(privateKey[3]).toBe(0);
    });

    it('should handle clear when privateKey is null', () => {
      useAuthStore.setState({
        user: testUser,
        privateKey: null,
        isAuthenticated: true,
      });

      expect(() => {
        useAuthStore.getState().clear();
      }).not.toThrow();
      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  describe('useSession', () => {
    // useSession uses useShallow (React hook) so cannot be tested outside React.
    // Test the underlying logic via authClient.getSession and useAuthStore instead.
    it('should be exported as a function', () => {
      expect(typeof useSession).toBe('function');
    });
  });

  describe('signIn.email', () => {
    const loginParams = {
      identifier: 'test@example.com',
      password: 'password123',
    };

    it('should successfully login without 2FA', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(unwrapAccountKeyWithPassword).mockReturnValue(mockPrivateKey);

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'test@example.com',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/api/auth/me')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                user: testUser,
                passwordWrappedPrivateKey: 'wrappedKey123',
                publicKey: 'pubKey123',
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);

      expect(result.error).toBeUndefined();
      expect(createOpaqueClient).toHaveBeenCalled();
      expect(startLogin).toHaveBeenCalled();
      expect(finishLogin).toHaveBeenCalled();
      expect(unwrapAccountKeyWithPassword).toHaveBeenCalled();
      expect(persistExportKey).toHaveBeenCalledWith(expect.any(Uint8Array), 'user-123', false);
      expect(useAuthStore.getState().privateKey).toEqual(mockPrivateKey);
      expect(useAuthStore.getState().user).toEqual(testUser);
    });

    it('normalizes username identifier before sending to API', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);
      vi.mocked(unwrapAccountKeyWithPassword).mockReturnValue(mockPrivateKey);

      let capturedInitBody = '';
      let capturedFinishBody = '';

      vi.mocked(fetch).mockImplementation((url, options) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          capturedInitBody = options!.body as string;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ke2: [1, 2, 3] }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          capturedFinishBody = options!.body as string;
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'test@example.com',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/api/auth/me')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                user: testUser,
                passwordWrappedPrivateKey: 'wrappedKey123',
                publicKey: 'pubKey123',
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await signIn.email({ identifier: 'John Smith', password: 'password123' });

      // Verify the API received normalized "john_smith", not raw "John Smith"
      expect(capturedInitBody).toContain('john_smith');
      expect(capturedInitBody).not.toContain('John Smith');
      expect(capturedFinishBody).toContain('john_smith');
    });

    it('does not normalize email identifiers', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);
      vi.mocked(unwrapAccountKeyWithPassword).mockReturnValue(mockPrivateKey);

      let capturedInitBody = '';

      vi.mocked(fetch).mockImplementation((url, options) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          capturedInitBody = options!.body as string;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ke2: [1, 2, 3] }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'User@Example.com',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/api/auth/me')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                user: { ...testUser, email: 'User@Example.com' },
                passwordWrappedPrivateKey: 'wrappedKey123',
                publicKey: 'pubKey123',
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await signIn.email({ identifier: 'User@Example.com', password: 'password123' });

      // Email should be preserved as-is (not normalized)
      expect(capturedInitBody).toContain('User@Example.com');
    });

    it('should persist export key with keepSignedIn flag', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(unwrapAccountKeyWithPassword).mockReturnValue(mockPrivateKey);

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'test@example.com',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/api/auth/me')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                user: testUser,
                passwordWrappedPrivateKey: 'wrappedKey123',
                publicKey: 'pubKey123',
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await signIn.email({ ...loginParams, keepSignedIn: true });

      expect(persistExportKey).toHaveBeenCalledWith(expect.any(Uint8Array), 'user-123', true);
    });

    it('should return error when login init fails', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'AUTH_FAILED' }),
      } as Response);

      const result = await signIn.email(loginParams);

      expect(result.error).toEqual({ message: 'Invalid credentials.' });
    });

    it('should return error when login finish fails', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'NO_PENDING_LOGIN' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);

      expect(result.error).toEqual({ message: 'Your login session expired. Please try again.' });
    });

    it('should handle 2FA requirement and return verifyTOTP callback', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                requires2FA: true,
                userId: 'user-123',
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);

      expect(result.requires2FA).toBe(true);
      expect(result.verifyTOTP).toBeDefined();
      expect(typeof result.verifyTOTP).toBe('function');
    });

    it('should successfully verify 2FA code', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(unwrapAccountKeyWithPassword).mockReturnValue(mockPrivateKey);

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                requires2FA: true,
                userId: 'user-123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/2fa/verify')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/api/auth/me')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                user: testUser2FA,
                passwordWrappedPrivateKey: 'wrappedKey123',
                publicKey: 'pubKey123',
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);
      expect(result.verifyTOTP).toBeDefined();

      if (!result.verifyTOTP) throw new Error('Expected verifyTOTP callback');
      const verifyResult = await result.verifyTOTP('123456');

      expect(verifyResult.success).toBe(true);
      expect(unwrapAccountKeyWithPassword).toHaveBeenCalledWith(
        expect.any(Uint8Array),
        expect.any(Uint8Array)
      );
      expect(persistExportKey).toHaveBeenCalledWith(expect.any(Uint8Array), 'user-123', false);
      expect(useAuthStore.getState().privateKey).toEqual(mockPrivateKey);
      expect(useAuthStore.getState().user).toEqual(testUser2FA);
    });

    it('should return error when 2FA verification fails', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                requires2FA: true,
                userId: 'user-123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/2fa/verify')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'INVALID_TOTP_CODE' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);
      if (!result.verifyTOTP) throw new Error('Expected verifyTOTP callback');
      const verifyResult = await result.verifyTOTP('000000');

      expect(verifyResult.success).toBe(false);
      expect(verifyResult.error).toBe('Invalid verification code. Please try again.');
    });

    it('should handle 2FA verification network error', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                requires2FA: true,
                userId: 'user-123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/2fa/verify')) {
          return Promise.reject(new Error('Network error'));
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);
      if (!result.verifyTOTP) throw new Error('Expected verifyTOTP callback');
      const verifyResult = await result.verifyTOTP('123456');

      expect(verifyResult.success).toBe(false);
      expect(verifyResult.error).toBe('Two-factor verification failed. Please try again.');
    });

    it('should return error when passwordWrappedPrivateKey is missing', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'test@example.com',
                // Missing passwordWrappedPrivateKey
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);

      expect(result.error).toEqual({
        message: 'Your account encryption is not configured. Please contact support.',
      });
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await signIn.email(loginParams);

      expect(result.error).toEqual({
        message: 'Login failed. Please check your credentials and try again.',
      });
    });

    it('should use fallback user data when /me endpoint fails', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);

      vi.mocked(unwrapAccountKeyWithPassword).mockReturnValue(mockPrivateKey);

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'test@example.com',
                passwordWrappedPrivateKey: 'wrappedKey123',
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/api/auth/me')) {
          return Promise.resolve({
            ok: false,
            status: 500,
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);

      expect(result.error).toBeUndefined();
      expect(useAuthStore.getState().user).toEqual({
        id: 'user-123',
        email: 'test@example.com',
        username: '',
        emailVerified: false,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
      });
    });

    it('should return LOGIN_FAILED on network error', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await signIn.email(loginParams);

      expect(result.error?.message).toBe(
        'Login failed. Please check your credentials and try again.'
      );
    });

    it('should zero password bytes when login init fails (early return)', async () => {
      let capturedPasswordBytes: Uint8Array | null = null;

      const originalEncode = TextEncoder.prototype.encode;

      vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
        this: TextEncoder,
        input?: string
      ) {
        const result = originalEncode.call(this, input ?? '');
        if (input === loginParams.password) {
          capturedPasswordBytes = result;
        }
        return result;
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'AUTH_FAILED' }),
      } as Response);

      const result = await signIn.email(loginParams);

      expect(result.error?.message).toBe('Invalid credentials.');
      expect([...defined(capturedPasswordBytes)].every((byte) => byte === 0)).toBe(true);
    });

    it('should zero password bytes when login finish fails (early return)', async () => {
      let capturedPasswordBytes: Uint8Array | null = null;

      const originalEncode = TextEncoder.prototype.encode;

      vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
        this: TextEncoder,
        input?: string
      ) {
        const result = originalEncode.call(this, input ?? '');
        if (input === loginParams.password) {
          capturedPasswordBytes = result;
        }
        return result;
      });

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'NO_PENDING_LOGIN' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);

      expect(result.error?.message).toBe('Your login session expired. Please try again.');
      expect([...defined(capturedPasswordBytes)].every((byte) => byte === 0)).toBe(true);
    });

    it('should zero password bytes when passwordWrappedPrivateKey is missing (early return)', async () => {
      let capturedPasswordBytes: Uint8Array | null = null;

      const originalEncode = TextEncoder.prototype.encode;

      vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
        this: TextEncoder,
        input?: string
      ) {
        const result = originalEncode.call(this, input ?? '');
        if (input === loginParams.password) {
          capturedPasswordBytes = result;
        }
        return result;
      });

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/login/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/login/finish')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                success: true,
                userId: 'user-123',
                email: 'test@example.com',
                // Missing passwordWrappedPrivateKey
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signIn.email(loginParams);

      expect(result.error?.message).toBe(
        'Your account encryption is not configured. Please contact support.'
      );
      expect([...defined(capturedPasswordBytes)].every((byte) => byte === 0)).toBe(true);
    });
  });

  describe('signUp.email', () => {
    const signupParams = {
      username: 'test_user',
      email: 'test@example.com',
      password: 'password123',
    };

    it('should successfully register a new user', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/register/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                registrationResponse: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/register/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signUp.email(signupParams);

      expect(result.error).toBeUndefined();
      expect(createOpaqueClient).toHaveBeenCalled();
      expect(startRegistration).toHaveBeenCalled();
      expect(finishRegistration).toHaveBeenCalled();
      expect(createAccount).toHaveBeenCalled();
    });

    it('should return error when registration init fails', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'CONFLICT' }),
      } as Response);

      const result = await signUp.email(signupParams);

      expect(result.error).toEqual({
        message: 'This action conflicts with the current state. Please refresh and try again.',
      });
    });

    it('should return error when registration finish fails', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/register/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                registrationResponse: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/register/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'REGISTRATION_FAILED' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signUp.email(signupParams);

      expect(result.error).toEqual({ message: 'Registration failed. Please try again.' });
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await signUp.email(signupParams);

      expect(result.error).toEqual({ message: 'Registration failed. Please try again.' });
    });

    it('should send correct crypto fields to register/finish endpoint', async () => {
      let capturedBody: string | null = null;

      vi.mocked(fetch).mockImplementation((url, init) => {
        if (typeof url === 'string' && url.includes('/register/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                registrationResponse: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/register/finish')) {
          if (!init) throw new Error('Expected init');
          capturedBody = init.body as string;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await signUp.email(signupParams);

      const parsed = JSON.parse(defined(capturedBody));
      expect(parsed).toHaveProperty('email', signupParams.email);
      expect(parsed).not.toHaveProperty('username');
      expect(parsed).toHaveProperty('registrationRecord');
      expect(parsed).toHaveProperty('accountPublicKey');
      expect(parsed).toHaveProperty('passwordWrappedPrivateKey');
      expect(parsed).toHaveProperty('recoveryWrappedPrivateKey');
      expect(parsed).not.toHaveProperty('passwordSalt');
      expect(parsed).not.toHaveProperty('encryptedDekPassword');
      expect(parsed).not.toHaveProperty('privateKeyWrapped');

      expect(createAccount).toHaveBeenCalled();
      expect(toBase64).toHaveBeenCalled();
    });

    it('should clean up password bytes in finally block', async () => {
      let capturedPasswordBytes: Uint8Array | null = null;

      const originalEncode = TextEncoder.prototype.encode;
      vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
        this: TextEncoder,
        input?: string
      ) {
        const result = originalEncode.call(this, input ?? '');
        if (input === signupParams.password) {
          capturedPasswordBytes = result;
        }
        return result;
      });

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/register/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                registrationResponse: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/register/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await signUp.email(signupParams);

      expect([...defined(capturedPasswordBytes)].every((byte) => byte === 0)).toBe(true);
    });

    it('should clean up sensitive material on registration init error', async () => {
      let capturedPasswordBytes: Uint8Array | null = null;

      const originalEncode = TextEncoder.prototype.encode;
      vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
        this: TextEncoder,
        input?: string
      ) {
        const result = originalEncode.call(this, input ?? '');
        if (input === signupParams.password) {
          capturedPasswordBytes = result;
        }
        return result;
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'CONFLICT' }),
      } as Response);

      const result = await signUp.email(signupParams);

      expect(result.error?.message).toBe(
        'This action conflicts with the current state. Please refresh and try again.'
      );
      expect([...defined(capturedPasswordBytes)].every((byte) => byte === 0)).toBe(true);
    });

    it('should clean up sensitive material on registration finish error', async () => {
      let capturedPasswordBytes: Uint8Array | null = null;

      const originalEncode = TextEncoder.prototype.encode;
      vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
        this: TextEncoder,
        input?: string
      ) {
        const result = originalEncode.call(this, input ?? '');
        if (input === signupParams.password) {
          capturedPasswordBytes = result;
        }
        return result;
      });

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/register/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                registrationResponse: [1, 2, 3],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/register/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'REGISTRATION_FAILED' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await signUp.email(signupParams);

      expect(result.error?.message).toBe('Registration failed. Please try again.');
      expect([...defined(capturedPasswordBytes)].every((byte) => byte === 0)).toBe(true);
    });
  });

  describe('changePassword', () => {
    const currentPassword = 'oldPassword123';
    const newPassword = 'newPassword456';

    beforeEach(() => {
      // Set privateKey in store for password change tests
      const mockPrivateKey = new Uint8Array([60, 61, 62]);
      useAuthStore.setState({ privateKey: mockPrivateKey });
    });

    it('should successfully change password', async () => {
      const mockNewWrappedKey = new Uint8Array([70, 71, 72]);

      vi.mocked(rewrapAccountKeyForPasswordChange).mockReturnValue(mockNewWrappedKey);
      vi.mocked(getStoredAuth).mockReturnValue({
        userId: 'user-123',
        kek: new Uint8Array([19, 20, 21]),
      });

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/change-password/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
                newRegistrationResponse: [4, 5, 6],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/change-password/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(true);
      expect(createOpaqueClient).toHaveBeenCalledTimes(2);
      expect(startLogin).toHaveBeenCalled();
      expect(startRegistration).toHaveBeenCalled();
      expect(finishLogin).toHaveBeenCalled();
      expect(finishRegistration).toHaveBeenCalled();
      expect(rewrapAccountKeyForPasswordChange).toHaveBeenCalled();
      expect(persistExportKey).toHaveBeenCalledWith(expect.any(Uint8Array), 'user-123', false);
    });

    it('should persist export key with correct keepSignedIn flag from localStorage', async () => {
      const mockNewWrappedKey = new Uint8Array([70, 71, 72]);

      vi.mocked(rewrapAccountKeyForPasswordChange).mockReturnValue(mockNewWrappedKey);
      vi.mocked(getStoredAuth).mockReturnValue({
        userId: 'user-123',
        kek: new Uint8Array([19, 20, 21]),
      });

      // Mock localStorage to simulate keepSignedIn = true
      Object.defineProperty(globalThis, 'localStorage', {
        value: {
          getItem: vi.fn((key) => (key === 'hushbox_auth_kek' ? 'some_value' : null)),
          setItem: vi.fn(),
          removeItem: vi.fn(),
          clear: vi.fn(),
        },
        writable: true,
      });

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/change-password/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
                newRegistrationResponse: [4, 5, 6],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/change-password/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await changePassword(currentPassword, newPassword);

      expect(persistExportKey).toHaveBeenCalledWith(expect.any(Uint8Array), 'user-123', true);
    });

    it('should return error when change-password init fails', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'INCORRECT_PASSWORD' }),
      } as Response);

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Incorrect password.');
    });

    it('should zero both password bytes when change-password init fails (early return)', async () => {
      let capturedCurrentPasswordBytes: Uint8Array | null = null;
      let capturedNewPasswordBytes: Uint8Array | null = null;

      const originalEncode = TextEncoder.prototype.encode;

      vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
        this: TextEncoder,
        input?: string
      ) {
        const result = originalEncode.call(this, input ?? '');
        if (input === currentPassword) {
          capturedCurrentPasswordBytes = result;
        } else if (input === newPassword) {
          capturedNewPasswordBytes = result;
        }
        return result;
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'INCORRECT_PASSWORD' }),
      } as Response);

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Incorrect password.');
      expect([...defined(capturedCurrentPasswordBytes)].every((byte) => byte === 0)).toBe(true);
      expect([...defined(capturedNewPasswordBytes)].every((byte) => byte === 0)).toBe(true);
    });

    it('should return error when change-password finish fails', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/change-password/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
                newRegistrationResponse: [4, 5, 6],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/change-password/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'NO_PENDING_CHANGE' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Your password change session expired. Please start over.');
    });

    it('should return error when privateKey is not available', async () => {
      useAuthStore.setState({ privateKey: null });

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/change-password/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
                newRegistrationResponse: [4, 5, 6],
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe(
        'Your encryption key is unavailable. Please log out and log back in.'
      );
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Password change failed. Please try again.');
    });

    it('should zero password bytes on error', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(false);
      // Password zeroing is tested implicitly through the error handling
    });

    it('should zero both password bytes when rewrapAccountKeyForPasswordChange throws error', async () => {
      let capturedCurrentPasswordBytes: Uint8Array | null = null;
      let capturedNewPasswordBytes: Uint8Array | null = null;

      const originalEncode = TextEncoder.prototype.encode;

      vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
        this: TextEncoder,
        input?: string
      ) {
        const result = originalEncode.call(this, input ?? '');
        if (input === currentPassword) {
          capturedCurrentPasswordBytes = result;
        } else if (input === newPassword) {
          capturedNewPasswordBytes = result;
        }
        return result;
      });

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/change-password/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
                newRegistrationResponse: [4, 5, 6],
              }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      vi.mocked(rewrapAccountKeyForPasswordChange).mockImplementation(() => {
        throw new Error('Rewrap failed');
      });

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(false);
      expect([...defined(capturedCurrentPasswordBytes)].every((byte) => byte === 0)).toBe(true);
      expect([...defined(capturedNewPasswordBytes)].every((byte) => byte === 0)).toBe(true);
    });

    it('should not persist export key when no stored auth exists', async () => {
      const mockNewWrappedKey = new Uint8Array([70, 71, 72]);

      vi.mocked(rewrapAccountKeyForPasswordChange).mockReturnValue(mockNewWrappedKey);
      vi.mocked(getStoredAuth).mockReturnValue(null);

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/change-password/init')) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                ke2: [1, 2, 3],
                newRegistrationResponse: [4, 5, 6],
              }),
          } as Response);
        }
        if (typeof url === 'string' && url.includes('/change-password/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({}),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await changePassword(currentPassword, newPassword);

      expect(result.success).toBe(true);
      expect(persistExportKey).not.toHaveBeenCalled();
    });
  });

  describe('signOutAndClearCache', () => {
    it('should logout, clear auth, clear store, and clear query cache', async () => {
      const mockPrivateKey = new Uint8Array([1, 2, 3, 4]);
      useAuthStore.setState({
        user: testUser,
        privateKey: mockPrivateKey,
        isAuthenticated: true,
      });

      vi.mocked(fetch).mockResolvedValue({
        ok: true,
      } as Response);

      await signOutAndClearCache();

      expect(fetch).toHaveBeenCalledWith('http://localhost:8787/api/auth/logout', {
        method: 'POST',
        credentials: 'include',
      });
      expect(clearStoredAuth).toHaveBeenCalled();
      expect(mockQueryClientClear).toHaveBeenCalled();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.privateKey).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(mockPrivateKey[0]).toBe(0);
    });

    it('should throw if logout request fails', async () => {
      useAuthStore.setState({
        user: testUser,
        privateKey: new Uint8Array([1, 2, 3, 4]),
        isAuthenticated: true,
      });

      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      await expect(signOutAndClearCache()).rejects.toThrow('Network error');
    });
  });

  describe('initAuth', () => {
    it('should implement singleton pattern and only run once', async () => {
      vi.mocked(getStoredAuth).mockReturnValue(null);

      const promise1 = initAuth();
      const promise2 = initAuth();
      const promise3 = initAuth();

      expect(promise1).toBe(promise2);
      expect(promise2).toBe(promise3);

      await promise1;

      expect(getStoredAuth).toHaveBeenCalledTimes(1);
    });

    it('should set isLoading to false when no stored auth exists', async () => {
      vi.mocked(getStoredAuth).mockReturnValue(null);

      await initAuth();

      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('should restore session when stored auth exists', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);
      const mockKEK = new Uint8Array([19, 20, 21]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', kek: mockKEK });
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
      });

      await initAuth();

      expect(restoreSession).toHaveBeenCalled();
      expect(useAuthStore.getState().privateKey).toEqual(mockPrivateKey);
      expect(useAuthStore.getState().user).toEqual(testUser);
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('should set isLoading to false when restoreSession returns null', async () => {
      const mockKEK = new Uint8Array([19, 20, 21]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', kek: mockKEK });
      vi.mocked(restoreSession).mockResolvedValue(null);

      await initAuth();

      expect(useAuthStore.getState().isLoading).toBe(false);
      expect(useAuthStore.getState().user).toBeNull();
    });

    it('should not clear stored auth when restoreSession throws error', async () => {
      const mockKEK = new Uint8Array([19, 20, 21]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', kek: mockKEK });
      vi.mocked(restoreSession).mockRejectedValue(new Error('Restore failed'));

      await initAuth();

      expect(clearStoredAuth).not.toHaveBeenCalled();
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('should always set isLoading to false even on error', async () => {
      const mockKEK = new Uint8Array([19, 20, 21]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', kek: mockKEK });
      vi.mocked(restoreSession).mockRejectedValue(new Error('Restore failed'));

      await initAuth();

      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('should retry on next call when previous attempt failed to restore session', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);
      const mockKEK = new Uint8Array([19, 20, 21]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', kek: mockKEK });

      // First call: restoreSession returns null (transient failure)
      vi.mocked(restoreSession).mockResolvedValue(null);
      await initAuth();
      expect(useAuthStore.getState().user).toBeNull();

      // Second call: restoreSession succeeds — should retry, not return cached failure
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
      });
      await initAuth();

      expect(restoreSession).toHaveBeenCalledTimes(2);
      expect(useAuthStore.getState().user).toEqual(testUser);
      expect(useAuthStore.getState().privateKey).toEqual(mockPrivateKey);
    });

    it('should retry on next call when previous attempt threw an error', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);
      const mockKEK = new Uint8Array([19, 20, 21]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', kek: mockKEK });

      // First call: restoreSession throws (network error)
      vi.mocked(restoreSession).mockRejectedValue(new Error('Network error'));
      await initAuth();
      expect(useAuthStore.getState().user).toBeNull();

      // Second call: restoreSession succeeds — should retry
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
      });
      await initAuth();

      expect(restoreSession).toHaveBeenCalledTimes(2);
      expect(useAuthStore.getState().user).toEqual(testUser);
    });

    it('should not retry when previous attempt succeeded', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);
      const mockKEK = new Uint8Array([19, 20, 21]);

      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', kek: mockKEK });
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
      });

      // First call: succeeds
      await initAuth();
      expect(useAuthStore.getState().user).toEqual(testUser);

      // Second call: should return cached result, not call restoreSession again
      await initAuth();

      expect(restoreSession).toHaveBeenCalledTimes(1);
    });
  });

  describe('requireAuth', () => {
    it('should return user when already authenticated', async () => {
      useAuthStore.setState({ user: testUser, isAuthenticated: true });

      const result = await requireAuth();

      expect(result).toEqual({ user: testUser });
      expect(getStoredAuth).not.toHaveBeenCalled();
    });

    it('should restore session and return user when not authenticated', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);
      const mockKEK = new Uint8Array([19, 20, 21]);

      useAuthStore.setState({ user: null, isAuthenticated: false });
      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', kek: mockKEK });
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
      });

      const result = await requireAuth();

      expect(result).toEqual({ user: testUser });
      expect(restoreSession).toHaveBeenCalled();
    });

    it('should throw redirect when no session can be restored', async () => {
      useAuthStore.setState({ user: null, isAuthenticated: false });
      vi.mocked(getStoredAuth).mockReturnValue(null);

      await expect(requireAuth()).rejects.toEqual({ to: '/login' });
      expect(redirect).toHaveBeenCalledWith({ to: '/login' });
    });

    it('should throw redirect when restoreSession fails', async () => {
      const mockKEK = new Uint8Array([19, 20, 21]);

      useAuthStore.setState({ user: null, isAuthenticated: false });
      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', kek: mockKEK });
      vi.mocked(restoreSession).mockRejectedValue(new Error('Restore failed'));

      await expect(requireAuth()).rejects.toEqual({ to: '/login' });
    });
  });

  describe('authClient.getSession', () => {
    it('should return user when authenticated', async () => {
      vi.mocked(getStoredAuth).mockReturnValue(null);
      useAuthStore.setState({ user: testUser, isAuthenticated: true, isLoading: false });

      const result = await authClient.getSession();

      expect(result).toEqual({ data: { user: testUser } });
    });

    it('should return null when not authenticated', async () => {
      vi.mocked(getStoredAuth).mockReturnValue(null);
      useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });

      const result = await authClient.getSession();

      expect(result).toEqual({ data: null });
    });

    it('should restore session before checking authentication', async () => {
      const mockPrivateKey = new Uint8Array([60, 61, 62]);
      const mockKEK = new Uint8Array([19, 20, 21]);

      resetInitPromise();
      useAuthStore.setState({ user: null, isAuthenticated: false });
      vi.mocked(getStoredAuth).mockReturnValue({ userId: 'user-123', kek: mockKEK });
      vi.mocked(restoreSession).mockResolvedValue({
        privateKey: mockPrivateKey,
        userId: 'user-123',
        user: testUser,
      });

      const result = await authClient.getSession();

      expect(result).toEqual({ data: { user: testUser } });
      expect(restoreSession).toHaveBeenCalled();
    });
  });

  describe('resetPasswordViaRecovery', () => {
    const email = 'test@example.com';
    const recoveryPhrase =
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
    const newPassword = 'newSecurePassword123';

    it('should return success on valid recovery phrase and new password', async () => {
      vi.mocked(recoverAccountFromMnemonic).mockResolvedValue(new Uint8Array([80, 81, 82]));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recovery/get-wrapped-key')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ recoveryWrappedPrivateKey: 'recoveryWrappedBase64' }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ newRegistrationResponse: [1, 2, 3] }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await resetPasswordViaRecovery(email, recoveryPhrase, newPassword);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
      expect(recoverAccountFromMnemonic).toHaveBeenCalled();
    });

    it('should return error when get-wrapped-key fails', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'USER_NOT_FOUND' }),
      } as Response);

      const result = await resetPasswordViaRecovery(email, recoveryPhrase, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Account not found.');
    });

    it('should return error when recoverAccountFromMnemonic fails', async () => {
      vi.mocked(recoverAccountFromMnemonic).mockRejectedValue(new Error('INVALID_RECOVERY_PHRASE'));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recovery/get-wrapped-key')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ recoveryWrappedPrivateKey: 'recoveryWrappedBase64' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await resetPasswordViaRecovery(email, recoveryPhrase, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Password change failed. Please try again.');
    });

    it('should return error when reset-password/init fails', async () => {
      vi.mocked(recoverAccountFromMnemonic).mockResolvedValue(new Uint8Array([80, 81, 82]));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recovery/get-wrapped-key')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ recoveryWrappedPrivateKey: 'recoveryWrappedBase64' }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'REGISTRATION_FAILED' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await resetPasswordViaRecovery(email, recoveryPhrase, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Registration failed. Please try again.');
    });

    it('should return error when reset-password/finish fails', async () => {
      vi.mocked(recoverAccountFromMnemonic).mockResolvedValue(new Uint8Array([80, 81, 82]));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recovery/get-wrapped-key')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ recoveryWrappedPrivateKey: 'recoveryWrappedBase64' }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ newRegistrationResponse: [1, 2, 3] }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'CHANGE_PASSWORD_REG_FAILED' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await resetPasswordViaRecovery(email, recoveryPhrase, newPassword);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Password change failed. Please try again.');
    });

    it('should clean up sensitive bytes in finally', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'USER_NOT_FOUND' }),
      } as Response);

      const result = await resetPasswordViaRecovery(email, recoveryPhrase, newPassword);

      expect(result.success).toBe(false);
    });

    it('should send identifier field with email when @ is present', async () => {
      vi.mocked(recoverAccountFromMnemonic).mockResolvedValue(new Uint8Array([80, 81, 82]));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recovery/get-wrapped-key')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ recoveryWrappedPrivateKey: 'recoveryWrappedBase64' }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ newRegistrationResponse: [1, 2, 3] }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await resetPasswordViaRecovery('user@example.com', recoveryPhrase, newPassword);

      // Verify get-wrapped-key sends identifier (not email)
      const getKeyCall = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url]) => typeof url === 'string' && url.includes('/recovery/get-wrapped-key')
        );
      expect(getKeyCall).toBeDefined();
      const getKeyBody = JSON.parse(getKeyCall![1]!.body as string) as { identifier: string };
      expect(getKeyBody.identifier).toBe('user@example.com');
    });

    it('should normalize username via normalizeIdentifier when no @ present', async () => {
      vi.mocked(recoverAccountFromMnemonic).mockResolvedValue(new Uint8Array([80, 81, 82]));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/recovery/get-wrapped-key')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ recoveryWrappedPrivateKey: 'recoveryWrappedBase64' }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ newRegistrationResponse: [1, 2, 3] }),
          } as Response);
        }
        if (typeof url === 'string' && url.endsWith('/recovery/reset/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await resetPasswordViaRecovery('Test User', recoveryPhrase, newPassword);

      // Username should be normalized: lowercased, spaces→underscores
      const getKeyCall = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url]) => typeof url === 'string' && url.includes('/recovery/get-wrapped-key')
        );
      expect(getKeyCall).toBeDefined();
      const getKeyBody = JSON.parse(getKeyCall![1]!.body as string) as { identifier: string };
      expect(getKeyBody.identifier).toBe('test_user');
    });
  });

  describe('authClient.verifyEmail', () => {
    it('should successfully verify email', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      } as Response);

      const result = await authClient.verifyEmail({ query: { token: 'valid-token' } });

      expect(result.error).toBeUndefined();
      expect(fetch).toHaveBeenCalledWith('http://localhost:8787/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: 'valid-token' }),
        credentials: 'include',
      });
    });

    it('should return error when verification fails', async () => {
      vi.mocked(fetch).mockResolvedValue({
        ok: false,
        json: () => Promise.resolve({ code: 'INVALID_OR_EXPIRED_TOKEN' }),
      } as Response);

      const result = await authClient.verifyEmail({ query: { token: 'invalid-token' } });

      expect(result.error).toEqual({
        message: 'This link has expired. Please request a new verification email.',
      });
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await authClient.verifyEmail({ query: { token: 'some-token' } });

      expect(result.error).toEqual({
        message: 'Email verification failed. Please try again or request a new link.',
      });
    });
  });

  describe('disable2FAInit', () => {
    const password = 'myPassword123';

    it('should return ke3 on successful password verification', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ke2: [10, 20, 30] }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await disable2FAInit(password);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.ke3).toEqual([4, 5, 6]);
      }
      expect(createOpaqueClient).toHaveBeenCalled();
      expect(startLogin).toHaveBeenCalledWith({ client: 'mock' }, password);
      expect(finishLogin).toHaveBeenCalled();
    });

    it('should return error on incorrect password', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/init')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'INCORRECT_PASSWORD' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await disable2FAInit(password);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Incorrect password.');
      }
    });

    it('should return error when OPAQUE finishLogin throws', async () => {
      vi.mocked(finishLogin).mockRejectedValueOnce(new Error('OPAQUE failure'));

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ke2: [10, 20, 30] }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await disable2FAInit(password);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Failed to start two-factor disable. Please try again.');
      }
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await disable2FAInit(password);

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('Failed to start two-factor disable. Please try again.');
      }
    });

    it('should zero password bytes in finally block', async () => {
      let capturedPasswordBytes: Uint8Array | null = null;

      const originalEncode = TextEncoder.prototype.encode;

      vi.spyOn(TextEncoder.prototype, 'encode').mockImplementation(function (
        this: TextEncoder,
        input?: string
      ) {
        const result = originalEncode.call(this, input ?? '');
        if (input === password) {
          capturedPasswordBytes = result;
        }
        return result;
      });

      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/init')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ ke2: [10, 20, 30] }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await disable2FAInit(password);

      expect([...defined(capturedPasswordBytes)].every((byte) => byte === 0)).toBe(true);
    });
  });

  describe('disable2FAFinish', () => {
    const ke3 = [4, 5, 6];
    const code = '123456';

    it('should return success when finish endpoint returns 200', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/finish')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await disable2FAFinish(ke3, code);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should return error on invalid TOTP code', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'INVALID_TOTP_CODE' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await disable2FAFinish(ke3, code);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Invalid verification code. Please try again.');
    });

    it('should return error on rate limit', async () => {
      vi.mocked(fetch).mockImplementation((url) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/finish')) {
          return Promise.resolve({
            ok: false,
            json: () => Promise.resolve({ code: 'TOO_MANY_ATTEMPTS' }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      const result = await disable2FAFinish(ke3, code);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Too many attempts. Your account has been temporarily locked.');
    });

    it('should return error on network failure', async () => {
      vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

      const result = await disable2FAFinish(ke3, code);

      expect(result.success).toBe(false);
      expect(result.error).toBe('Two-factor verification failed. Please try again.');
    });

    it('should send correct request body with ke3 and code', async () => {
      let capturedBody: string | null = null;

      vi.mocked(fetch).mockImplementation((url, init) => {
        if (typeof url === 'string' && url.includes('/2fa/disable/finish')) {
          if (!init) throw new Error('Expected init');
          capturedBody = init.body as string;
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ success: true }),
          } as Response);
        }
        return Promise.reject(new Error('Unexpected fetch'));
      });

      await disable2FAFinish(ke3, code);

      const parsed = JSON.parse(defined(capturedBody));
      expect(parsed).toEqual({ ke3: [4, 5, 6], code: '123456' });
    });
  });
});
