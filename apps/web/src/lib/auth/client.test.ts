import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import {
  createAccount,
  getPublicKeyFromPrivate,
  unwrapAccountKeyWithPassword,
} from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import { PENDING, settlementOf } from '@/test-utils/promise-settlement';
import { createInMemoryStorage, installFakeIndexedDB } from '@/test-utils/browser-storage-fake';

vi.mock('@/lib/api/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/api')>();
  return {
    ...actual,
    getApiUrl: () => 'http://localhost:8787',
  };
});

// restoreSession routes /me through the shared query client so it inherits the
// app-wide retry policy. Use a real QueryClient wired to the production retry
// predicate (zero delay to keep tests fast) so retry behavior is exercised for
// real rather than stubbed away.
vi.mock('@/providers/query-provider', async () => {
  const { QueryClient } = await import('@tanstack/react-query');
  const { shouldRetry } = await import('@/lib/api/retry');
  return {
    queryClient: new QueryClient({
      defaultOptions: {
        queries: { retry: shouldRetry, retryDelay: () => 0, staleTime: 0, gcTime: 0 },
      },
    }),
  };
});

import { queryClient } from '@/providers/query-provider';
import { setLinkGuestAuth, clearLinkGuestAuth } from './link-guest-auth.js';
import {
  persistExportKey,
  restoreSession,
  clearStoredAuth,
  getStoredAuth,
  hasStoredAuth,
  STORAGE_KEY,
} from './client.js';
import type { IndexedDbFakeControls } from '@/test-utils/browser-storage-fake';
import type { CreateAccountResult } from '@hushbox/crypto';

interface MeResponseInit {
  passwordWrappedPrivateKey?: Uint8Array;
}

function meOkResponse(init: MeResponseInit = {}): Response {
  const { passwordWrappedPrivateKey } = init;
  const body: Record<string, unknown> = {
    user: {
      id: 'user-123',
      email: 'test@example.com',
      username: 'test',
      emailVerified: true,
      totpEnabled: false,
      hasAcknowledgedPhrase: true,
    },
  };
  if (passwordWrappedPrivateKey) {
    body['passwordWrappedPrivateKey'] = toBase64(passwordWrappedPrivateKey);
    body['publicKey'] = toBase64(new Uint8Array([1, 2, 3]));
  }
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: vi.fn().mockResolvedValue(body),
  } as unknown as Response;
}

describe('auth/client', () => {
  const testExportKey = new Uint8Array([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26,
    27, 28, 29, 30, 31, 32,
  ]);
  const testUserId = 'user-123';

  let mockFetch: ReturnType<typeof vi.fn>;
  let idbData: Map<unknown, unknown>;
  let idbControls: IndexedDbFakeControls;
  // One real account, minted once: the wrapped key every restore test feeds the
  // server response is the genuine blob `unwrapAccountKeyWithPassword` opens.
  let account: CreateAccountResult;

  beforeAll(async () => {
    account = await createAccount(testExportKey);
  });

  /** The unwrap produced the account's own key iff its public half matches. */
  function expectAccountPrivateKey(privateKey: Uint8Array): void {
    expect([...getPublicKeyFromPrivate(privateKey)]).toEqual([...account.publicKey]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('localStorage', createInMemoryStorage());
    vi.stubGlobal('sessionStorage', createInMemoryStorage());
    ({ data: idbData, controls: idbControls } = installFakeIndexedDB());
    mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);
    queryClient.clear();
  });

  afterEach(() => {
    clearLinkGuestAuth();
    vi.unstubAllGlobals();
  });

  describe('STORAGE_KEY', () => {
    it('is hushbox_auth_kek', () => {
      expect(STORAGE_KEY).toBe('hushbox_auth_kek');
    });
  });

  describe('persistExportKey', () => {
    it('stores the marker in sessionStorage when keepSignedIn is false', async () => {
      await persistExportKey(testExportKey, testUserId, false);

      expect(sessionStorage.getItem(STORAGE_KEY)).not.toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('stores the marker in localStorage when keepSignedIn is true', async () => {
      await persistExportKey(testExportKey, testUserId, true);

      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('stores only the userId in the marker, never key bytes', async () => {
      await persistExportKey(testExportKey, testUserId, false);

      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (!stored) throw new Error('Expected stored value');
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      expect(parsed['userId']).toBe(testUserId);
      expect(parsed['kek']).toBeUndefined();
      expect(stored).not.toContain(toBase64(testExportKey));
    });

    it('never persists the raw export key in Web Storage or IndexedDB', async () => {
      await persistExportKey(testExportKey, testUserId, true);

      const rawBase64 = toBase64(testExportKey);
      expect(localStorage.getItem(STORAGE_KEY) ?? '').not.toContain(rawBase64);
      expect(sessionStorage.getItem(STORAGE_KEY) ?? '').not.toContain(rawBase64);

      const record = [...idbData.values()][0] as {
        iv: Uint8Array;
        ciphertext: Uint8Array;
        userId: string;
        deviceKey: CryptoKey;
      };
      expect(Object.keys(record).toSorted((a, b) => a.localeCompare(b))).toEqual([
        'ciphertext',
        'deviceKey',
        'iv',
        'userId',
      ]);
      expect([...record.ciphertext]).not.toEqual([...testExportKey]);
      expect(record.userId).toBe(testUserId);
      expect(record.deviceKey.extractable).toBe(false);
    });

    it('overwrites the marker userId on repeat', async () => {
      await persistExportKey(testExportKey, 'first-user', false);
      await persistExportKey(testExportKey, 'second-user', false);

      const stored = sessionStorage.getItem(STORAGE_KEY);
      if (!stored) throw new Error('Expected stored value');
      expect((JSON.parse(stored) as { userId: string }).userId).toBe('second-user');
    });
  });

  describe('clearStoredAuth', () => {
    it('clears localStorage', async () => {
      localStorage.setItem(STORAGE_KEY, 'test');

      await clearStoredAuth();

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears sessionStorage', async () => {
      sessionStorage.setItem(STORAGE_KEY, 'test');

      await clearStoredAuth();

      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears both storages at once', async () => {
      localStorage.setItem(STORAGE_KEY, 'test-local');
      sessionStorage.setItem(STORAGE_KEY, 'test-session');

      await clearStoredAuth();

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('purges the device key from IndexedDB', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      expect(idbData.size).toBe(1);

      await clearStoredAuth();

      expect(idbData.size).toBe(0);
    });

    it('settles only once the IndexedDB device-key delete has completed', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      // The delete parks until released, so a purge that settles before the
      // release settled with the wrapped key still on disk.
      idbControls.holdDelete = true;

      const purged = clearStoredAuth();

      expect(await settlementOf(purged)).toBe(PENDING);
      expect(idbData.size).toBe(1);

      idbControls.releaseDelete();
      await purged;

      expect(idbData.size).toBe(0);
    });

    it('ignores an IndexedDB failure while purging the device key', async () => {
      localStorage.setItem(STORAGE_KEY, 'marker');
      idbControls.failOpen = true;

      // Must not reject despite the device-key purge failing.
      await expect(clearStoredAuth()).resolves.toBeUndefined();

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('getStoredAuth', () => {
    it('returns null when no marker is stored', () => {
      expect(getStoredAuth()).toBeNull();
    });

    it('returns userId with keepSignedIn true from localStorage', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: testUserId }));

      const result = getStoredAuth();

      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe(testUserId);
      expect(result.keepSignedIn).toBe(true);
    });

    it('returns userId with keepSignedIn false from sessionStorage', () => {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: testUserId }));

      const result = getStoredAuth();

      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe(testUserId);
      expect(result.keepSignedIn).toBe(false);
    });

    it('prefers localStorage over sessionStorage when both exist', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'local-user' }));
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'session-user' }));

      const result = getStoredAuth();

      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe('local-user');
      expect(result.keepSignedIn).toBe(true);
    });

    it('returns null when the marker is malformed JSON', () => {
      localStorage.setItem(STORAGE_KEY, 'not-valid-json');

      expect(getStoredAuth()).toBeNull();
    });

    it('returns null when the marker is missing a userId', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ notUserId: 'x' }));

      expect(getStoredAuth()).toBeNull();
    });

    it('clears the corrupt marker from storage', () => {
      localStorage.setItem(STORAGE_KEY, 'not-valid-json');

      getStoredAuth();

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(sessionStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('restoreSession', () => {
    it('returns null when no marker is stored', async () => {
      const result = await restoreSession();

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('fetches the wrapped key from the server', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(
        meOkResponse({ passwordWrappedPrivateKey: account.passwordWrappedPrivateKey })
      );

      await restoreSession();

      const meCall = mockFetch.mock.calls.find(([input]) =>
        String(typeof input === 'object' && input ? (input as Request).url : input).includes(
          '/auth/me'
        )
      );
      expect(meCall).toBeDefined();
    });

    it('routes the /me request through the typed client (sends platform header)', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(
        meOkResponse({ passwordWrappedPrivateKey: account.passwordWrappedPrivateKey })
      );

      await restoreSession();

      const meCall = mockFetch.mock.calls.find(([input]) =>
        String(typeof input === 'object' && input ? (input as Request).url : input).includes(
          '/auth/me'
        )
      );
      if (!meCall) throw new Error('Expected /me request');
      const headers = new Headers(meCall[1]?.headers);
      expect(headers.get('X-HushBox-Platform')).not.toBeNull();
    });

    it('returns the account private key and userId on success', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(
        meOkResponse({ passwordWrappedPrivateKey: account.passwordWrappedPrivateKey })
      );

      // No argument: the production default unwraps, so this pins that the
      // default is the real account-key unwrap and not a stand-in.
      const result = await restoreSession();

      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe(testUserId);
      expectAccountPrivateKey(result.privateKey);
    });

    it('passes the IndexedDB export key and the fetched wrapped key to the injected unwrap', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(
        meOkResponse({ passwordWrappedPrivateKey: account.passwordWrappedPrivateKey })
      );
      const unwrap = vi.fn(unwrapAccountKeyWithPassword);

      const result = await restoreSession(unwrap);

      expect(unwrap).toHaveBeenCalledWith(testExportKey, account.passwordWrappedPrivateKey);
      if (!result) throw new Error('Expected result');
      expectAccountPrivateKey(result.privateKey);
    });

    it('clears storage and returns null on 401 auth rejection', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue({ ok: false, status: 401, headers: new Headers() } as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears storage and returns null on 403 forbidden', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue({ ok: false, status: 403, headers: new Headers() } as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('preserves storage on a 401 while link-guest mode is active', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue({ ok: false, status: 401, headers: new Headers() } as Response);
      setLinkGuestAuth('link-public-key');

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('preserves storage on a 403 while link-guest mode is active', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue({ ok: false, status: 403, headers: new Headers() } as Response);
      setLinkGuestAuth('link-public-key');

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('preserves storage on a keyless body while link-guest mode is active', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(meOkResponse());
      setLinkGuestAuth('link-public-key');

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('preserves storage on 500 server error', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue({ ok: false, status: 500, headers: new Headers() } as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('preserves storage on 503 service unavailable', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue({ ok: false, status: 503, headers: new Headers() } as Response);

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('retries a transient /me failure and restores the session', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      // First /me is dropped (navigation/network blip surfaces as a TypeError);
      // the app-wide retry policy re-attempts and the second call succeeds.
      mockFetch
        .mockRejectedValueOnce(new TypeError('Load failed'))
        .mockResolvedValueOnce(
          meOkResponse({ passwordWrappedPrivateKey: account.passwordWrappedPrivateKey })
        );

      const result = await restoreSession();

      if (!result) throw new Error('Expected result');
      expect(result.userId).toBe(testUserId);
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('clears storage and returns null when the wrapped key has been tampered with', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      // Flipping the trailing byte corrupts the AEAD tag, so the real unwrap
      // rejects it exactly as it would a wrong or mangled server blob.
      const lastIndex = account.passwordWrappedPrivateKey.length - 1;
      const tampered = account.passwordWrappedPrivateKey.map((byte, index) =>
        index === lastIndex ? byte ^ 0xff : byte
      );
      mockFetch.mockResolvedValue(meOkResponse({ passwordWrappedPrivateKey: tampered }));

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears storage and returns null when the device key cannot be loaded', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: testUserId }));
      mockFetch.mockResolvedValue(
        meOkResponse({ passwordWrappedPrivateKey: account.passwordWrappedPrivateKey })
      );
      // The device-key read fails (IndexedDB error, not a missing record).
      idbControls.failOpen = true;

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('clears storage and returns null when the device key is missing from IndexedDB', async () => {
      // Marker present but no IndexedDB record — e.g. a stale marker.
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: testUserId }));
      mockFetch.mockResolvedValue(
        meOkResponse({ passwordWrappedPrivateKey: account.passwordWrappedPrivateKey })
      );

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('returns null but preserves storage when fetch throws', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockRejectedValue(new Error('Network error'));

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
    });

    it('clears storage and returns null when passwordWrappedPrivateKey is missing', async () => {
      await persistExportKey(testExportKey, testUserId, true);
      mockFetch.mockResolvedValue(meOkResponse());

      const result = await restoreSession();

      expect(result).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('session lifetime', () => {
    it('keep-signed-in survives a browser-close simulation', async () => {
      await persistExportKey(testExportKey, testUserId, true);

      // Browser close: the tab-scoped sessionStorage is wiped, but localStorage
      // and IndexedDB persist.
      vi.stubGlobal('sessionStorage', createInMemoryStorage());
      mockFetch.mockResolvedValue(
        meOkResponse({ passwordWrappedPrivateKey: account.passwordWrappedPrivateKey })
      );

      const result = await restoreSession();

      if (!result) throw new Error('Expected session to survive');
      expect(result.userId).toBe(testUserId);
      expectAccountPrivateKey(result.privateKey);
    });

    it('session mode is cleared on tab close', async () => {
      await persistExportKey(testExportKey, testUserId, false);
      expect(getStoredAuth()).not.toBeNull();

      // Tab close: sessionStorage is wiped by the browser.
      vi.stubGlobal('sessionStorage', createInMemoryStorage());

      expect(getStoredAuth()).toBeNull();
    });
  });
});

describe('hasStoredAuth', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', createInMemoryStorage());
    vi.stubGlobal('sessionStorage', createInMemoryStorage());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when a marker exists in localStorage', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'user-1' }));
    expect(hasStoredAuth()).toBe(true);
  });

  it('returns true when a marker exists in sessionStorage', () => {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: 'user-1' }));
    expect(hasStoredAuth()).toBe(true);
  });

  it('returns false when no marker exists', () => {
    expect(hasStoredAuth()).toBe(false);
  });

  it('returns false when localStorage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    });
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {},
      removeItem: () => {},
      clear: () => {},
      length: 0,
      key: () => null,
    });
    expect(hasStoredAuth()).toBe(false);
  });
});
