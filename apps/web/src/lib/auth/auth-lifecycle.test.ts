import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { onlineManager } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { SMART_MODEL_ID } from '@hushbox/shared';
import { PENDING, settlementOf } from '@/test-utils/promise-settlement';
import {
  createAuthServerFixture,
  expectAccountPrivateKey,
  resetAuthEnvironment,
} from '@/test-utils/auth-server-fixture';
import { decryptedCache } from '@/lib/crypto/decrypted-message-cache';

vi.mock('@tanstack/react-router', () => ({ redirect: vi.fn((options) => options) }));

const { mockQueryClientClear } = vi.hoisted(() => ({ mockQueryClientClear: vi.fn() }));

vi.mock('@/providers/query-provider', () => ({
  queryClient: {
    clear: mockQueryClientClear,
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

import { registerSessionRevocationClearer } from '@/providers/query-provider';
import { notificationChannel } from '@/lib/notification-channel';
import {
  useAuthStore,
  useSession,
  signOutAndClearCache,
  clearLocalAuthState,
  authClient,
  initAuth,
  requireAuth,
  parseErrorMessage,
  selectInstructionsReadUnresolved,
} from './auth';
import { persistExportKey, STORAGE_KEY } from './client.js';
import { setLinkGuestAuth, clearLinkGuestAuth } from './link-guest-auth.js';
import { loadExportKeyProtected } from '../device-key-store.js';
import type { AuthServerFixture, AuthTestEnvironment } from '@/test-utils/auth-server-fixture';

// Captured at module-eval time (before any `clearAllMocks`): auth.ts registers
// its revocation clearer once, as an import side effect.
const registeredRevocationClearer = vi.mocked(registerSessionRevocationClearer).mock.calls[0]?.[0];

function definedClearer(): () => boolean {
  if (!registeredRevocationClearer) throw new Error('Expected a registered revocation clearer');
  return registeredRevocationClearer;
}

const originalLocation = globalThis.location;

describe('auth session lifecycle', () => {
  let fixture: AuthServerFixture;
  let environment: AuthTestEnvironment;

  beforeAll(async () => {
    fixture = await createAuthServerFixture();
  });

  beforeEach(() => {
    environment = resetAuthEnvironment(fixture);
    decryptedCache.clear();
    // clearLocalAuthState forces a hard reload; getApiUrl is mocked so nothing
    // else reads location. Stub reload so the reload does not throw.
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: { href: 'http://localhost/', origin: 'http://localhost', reload: vi.fn() },
    });
  });

  afterEach(() => {
    clearLinkGuestAuth();
    // Every sign-out that leaves the page takes the shared manager offline.
    onlineManager.setOnline(true);
    vi.unstubAllGlobals();
    Object.defineProperty(globalThis, 'location', {
      configurable: true,
      writable: true,
      value: originalLocation,
    });
  });

  /** Puts this device in the state a completed sign-in leaves behind. */
  async function signedInOnThisDevice(): Promise<void> {
    await persistExportKey(fixture.exportKey, fixture.userId, true);
  }

  /** Waits for the instruction read that bootstrap fired beside the session to answer. */
  async function instructionsRead(): Promise<void> {
    await vi.waitFor(() => {
      expect(useAuthStore.getState().customInstructionsStatus).not.toBe('pending');
    });
  }

  describe('parseErrorMessage', () => {
    it('returns the friendly message for a known code', () => {
      expect(parseErrorMessage({ code: 'AUTH_FAILED' })).toBe(
        'Incorrect username, email, or password. Please try again.'
      );
    });

    it('returns the generic fallback for an unknown code', () => {
      expect(parseErrorMessage({ code: 'TOTALLY_UNKNOWN' })).toBe(
        'Something went wrong. Please try again.'
      );
    });

    it('returns the generic fallback when the code field is missing', () => {
      expect(parseErrorMessage({ success: false })).toBe(
        'Something went wrong. Please try again later.'
      );
    });

    it('returns the generic fallback for a non-object body', () => {
      expect(parseErrorMessage(null)).toBe('Something went wrong. Please try again later.');
      expect(parseErrorMessage('some string')).toBe(
        'Something went wrong. Please try again later.'
      );
      expect(parseErrorMessage(42)).toBe('Something went wrong. Please try again later.');
    });
  });

  describe('useAuthStore', () => {
    it('starts logged out and loading', () => {
      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.privateKey).toBeNull();
      expect(state.isLoading).toBe(true);
      expect(state.isAuthenticated).toBe(false);
    });

    it('marks the session authenticated when a user is set', () => {
      useAuthStore.getState().setUser(fixture.user);

      const state = useAuthStore.getState();
      expect(state.user).toEqual(fixture.user);
      expect(state.isAuthenticated).toBe(true);
    });

    it('marks the session unauthenticated when the user is cleared', () => {
      useAuthStore.setState({ user: fixture.user, isAuthenticated: true });

      useAuthStore.getState().setUser(null);

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.isAuthenticated).toBe(false);
    });

    it('holds the private key setPrivateKey was given', () => {
      const privateKey = new Uint8Array([5, 6, 7, 8]);

      useAuthStore.getState().setPrivateKey(privateKey);

      expect(useAuthStore.getState().privateKey).toEqual(privateKey);
    });

    it('toggles the loading flag', () => {
      useAuthStore.getState().setLoading(false);
      expect(useAuthStore.getState().isLoading).toBe(false);

      useAuthStore.getState().setLoading(true);
      expect(useAuthStore.getState().isLoading).toBe(true);
    });

    it('zeroes the private key buffer on clear', () => {
      const privateKey = new Uint8Array([5, 6, 7, 8]);
      useAuthStore.setState({ user: fixture.user, privateKey, isAuthenticated: true });

      useAuthStore.getState().clear();

      const state = useAuthStore.getState();
      expect(state.user).toBeNull();
      expect(state.privateKey).toBeNull();
      expect(state.isAuthenticated).toBe(false);
      expect(state.isLoading).toBe(false);
      expect([...privateKey]).toEqual([0, 0, 0, 0]);
    });

    it('clears without a private key to zero', () => {
      useAuthStore.setState({ user: fixture.user, privateKey: null, isAuthenticated: true });

      expect(() => {
        useAuthStore.getState().clear();
      }).not.toThrow();
      expect(useAuthStore.getState().user).toBeNull();
    });
  });

  describe('useSession', () => {
    it('returns the session when a user is authenticated', () => {
      useAuthStore.setState({ user: fixture.user, isLoading: false, isAuthenticated: true });

      const { result } = renderHook(() => useSession());

      expect(result.current.data).toEqual({
        user: fixture.user,
        session: { id: fixture.user.id },
      });
      expect(result.current.isPending).toBe(false);
    });

    it('returns no session data when no user is present', () => {
      useAuthStore.setState({ user: null, isLoading: false, isAuthenticated: false });

      const { result } = renderHook(() => useSession());

      expect(result.current.data).toBeNull();
      expect(result.current.isPending).toBe(false);
    });

    it('reports pending while the bootstrap is loading', () => {
      useAuthStore.setState({ user: null, isLoading: true, isAuthenticated: false });

      const { result } = renderHook(() => useSession());

      expect(result.current.isPending).toBe(true);
    });

    it('masks the session while link-guest mode is active', () => {
      useAuthStore.setState({ user: fixture.user, isLoading: false, isAuthenticated: true });
      setLinkGuestAuth('some-link-public-key');

      const { result } = renderHook(() => useSession());

      expect(result.current.data).toBeNull();
      expect(result.current.isPending).toBe(false);
    });
  });

  describe('signOutAndClearCache', () => {
    it('posts the logout, clears the stored auth and empties the query cache', async () => {
      const privateKey = new Uint8Array([1, 2, 3, 4]);
      await signedInOnThisDevice();
      useAuthStore.setState({ user: fixture.user, privateKey, isAuthenticated: true });

      await signOutAndClearCache();

      const [logout] = fixture.requestsTo('/auth/logout');
      expect(logout?.init?.method).toBe('POST');
      expect(logout?.init?.credentials).toBe('include');
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(await loadExportKeyProtected()).toBeNull();
      expect(mockQueryClientClear).toHaveBeenCalled();
      expect(useAuthStore.getState().user).toBeNull();
      expect([...privateKey]).toEqual([0, 0, 0, 0]);
    });

    it('stops push delivery to this device before the session ends', async () => {
      useAuthStore.setState({ user: fixture.user, isAuthenticated: true });

      await signOutAndClearCache();

      expect(notificationChannel.unregister).toHaveBeenCalled();
    });

    it('signs out even when unregistering push fails', async () => {
      await signedInOnThisDevice();
      useAuthStore.setState({ user: fixture.user, isAuthenticated: true });
      vi.mocked(notificationChannel.unregister).mockRejectedValueOnce(new Error('offline'));

      await signOutAndClearCache();

      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('propagates a failed logout request', async () => {
      fixture.serve('/auth/logout', () => {
        throw new Error('Network error');
      });

      await expect(signOutAndClearCache()).rejects.toThrow('Network error');
    });

    it('resets model selections on sign out', async () => {
      const { useModelStore } = await import('@/stores/model');
      useModelStore.setState({
        selections: {
          text: [
            { id: 'model-a', name: 'Model A' },
            { id: 'model-b', name: 'Model B' },
          ],
          image: [{ id: 'imagen', name: 'Imagen' }],
          audio: [],
          video: [{ id: 'veo', name: 'Veo' }],
        },
      });

      await signOutAndClearCache();

      const { selections } = useModelStore.getState();
      expect(selections.text).toHaveLength(1);
      expect(selections.text[0]?.id).toBe(SMART_MODEL_ID);
      expect(selections.image).toEqual([]);
      expect(selections.video).toEqual([]);
    });

    it('drops the decrypted active document on sign out', async () => {
      const { useDocumentStore } = await import('@/stores/document');
      useDocumentStore.getState().setActiveDocument({
        id: 'doc-1',
        type: 'code',
        title: 'Secret',
        content: 'decrypted secret content',
        lineCount: 1,
        isStreaming: false,
      });

      await signOutAndClearCache();

      const documentState = useDocumentStore.getState();
      expect(documentState.activeDocument).toBeNull();
      expect(documentState.activeDocumentId).toBeNull();
      expect(documentState.isPanelOpen).toBe(false);
    });

    it('reloads the page by default', async () => {
      await signOutAndClearCache();

      expect(globalThis.location.reload).toHaveBeenCalledOnce();
    });

    it('skips the reload for a switch-user sign-out so its login runs in the same context', async () => {
      await signedInOnThisDevice();

      await signOutAndClearCache({ next: 'switch-user' });

      expect(globalThis.location.reload).not.toHaveBeenCalled();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe('clearLocalAuthState', () => {
    it('clears auth, query and model state without calling the logout endpoint', async () => {
      const privateKey = new Uint8Array([1, 2, 3, 4]);
      await signedInOnThisDevice();
      useAuthStore.setState({ user: fixture.user, privateKey, isAuthenticated: true });
      const { useModelStore } = await import('@/stores/model');
      useModelStore.setState({
        selections: {
          text: [{ id: 'model-a', name: 'Model A' }],
          image: [{ id: 'imagen', name: 'Imagen' }],
          audio: [],
          video: [],
        },
      });

      await clearLocalAuthState();

      expect(fixture.requestsTo('/auth/logout')).toHaveLength(0);
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(mockQueryClientClear).toHaveBeenCalled();
      const auth = useAuthStore.getState();
      expect(auth.user).toBeNull();
      expect(auth.privateKey).toBeNull();
      expect(auth.isAuthenticated).toBe(false);
      expect([...privateKey]).toEqual([0, 0, 0, 0]);
      const { selections } = useModelStore.getState();
      expect(selections.text[0]?.id).toBe(SMART_MODEL_ID);
      expect(selections.image).toEqual([]);
    });

    it('drops the decrypted active document', async () => {
      const { useDocumentStore } = await import('@/stores/document');
      useDocumentStore.getState().setActiveDocument({
        id: 'doc-2',
        type: 'code',
        title: 'Secret',
        content: 'decrypted secret content',
        lineCount: 1,
        isStreaming: false,
      });

      await clearLocalAuthState();

      const documentState = useDocumentStore.getState();
      expect(documentState.activeDocument).toBeNull();
      expect(documentState.activeDocumentId).toBeNull();
      expect(documentState.isPanelOpen).toBe(false);
    });

    it('empties the module decrypted-message plaintext cache', async () => {
      decryptedCache.set('conv-1:msg-1', { epochNumber: 0, content: 'secret plaintext' });

      await clearLocalAuthState();

      expect(decryptedCache.size).toBe(0);
    });

    it('forces a hard page reload so module plaintext is dropped from memory', async () => {
      await clearLocalAuthState();

      expect(globalThis.location.reload).toHaveBeenCalledOnce();
    });

    it('finishes deleting the stored device key before the page reloads', async () => {
      await signedInOnThisDevice();
      environment.indexedDb.holdDelete = true;

      const cleared = clearLocalAuthState();

      // The IndexedDB delete is still in flight; reloading now would tear the JS
      // context down mid-delete and leave the wrapped device key on disk.
      expect(await settlementOf(cleared)).toBe(PENDING);
      expect(globalThis.location.reload).not.toHaveBeenCalled();

      environment.indexedDb.releaseDelete();
      await cleared;

      expect(globalThis.location.reload).toHaveBeenCalledOnce();
    });

    it('skips the reload before a navigation the caller started but still clears auth state', async () => {
      await signedInOnThisDevice();
      useAuthStore.setState({ user: fixture.user, isAuthenticated: true });

      await clearLocalAuthState({ next: 'navigate-away' });

      expect(globalThis.location.reload).not.toHaveBeenCalled();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });
  });

  describe('initAuth', () => {
    it('runs once for concurrent callers', async () => {
      await signedInOnThisDevice();

      const first = initAuth();
      const second = initAuth();

      expect(first).toBe(second);
      await first;
      expect(fixture.requestsTo('/auth/me')).toHaveLength(1);
    });

    it('settles to logged-out when no sign-in marker exists', async () => {
      await initAuth();

      expect(useAuthStore.getState().isLoading).toBe(false);
      expect(useAuthStore.getState().user).toBeNull();
      expect(fixture.requestsTo('/auth/me')).toHaveLength(0);
    });

    it('purges a device key left behind with no marker', async () => {
      // Session mode leaves the device key in IndexedDB with no marker — the
      // browser clears only the sessionStorage marker on tab close.
      await persistExportKey(fixture.exportKey, fixture.userId, false);
      sessionStorage.removeItem(STORAGE_KEY);

      await initAuth();

      expect(await loadExportKeyProtected()).toBeNull();
    });

    it('waits for the no-marker device-key purge before it resolves', async () => {
      await persistExportKey(fixture.exportKey, fixture.userId, false);
      sessionStorage.removeItem(STORAGE_KEY);
      environment.indexedDb.holdDelete = true;

      const initialized = initAuth();

      expect(await settlementOf(initialized)).toBe(PENDING);

      environment.indexedDb.releaseDelete();

      await expect(initialized).resolves.toBeUndefined();
    });

    it('restores the account key from the stored device key', async () => {
      await signedInOnThisDevice();

      await initAuth();

      expectAccountPrivateKey(fixture, useAuthStore.getState().privateKey);
      expect(useAuthStore.getState().user).toEqual(fixture.user);
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('settles to logged-out when the marker outlived its device key', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: fixture.userId }));

      await initAuth();

      expect(useAuthStore.getState().isLoading).toBe(false);
      expect(useAuthStore.getState().user).toBeNull();
    });

    it('leaves the session untouched when the instruction read fails', async () => {
      await signedInOnThisDevice();
      fixture.serve('/account/instructions', () => {
        throw new Error('Network error');
      });
      const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

      await initAuth();

      expect(localStorage.getItem(STORAGE_KEY)).not.toBeNull();
      expect(useAuthStore.getState().user).toEqual(fixture.user);
      expect(useAuthStore.getState().isLoading).toBe(false);
      expect(useAuthStore.getState().customInstructionsStatus).toBe('pending');
      // The read runs beside the session, so its failure is reported after
      // `initAuth` has already resolved.
      await vi.waitFor(() => {
        expect(reported).toHaveBeenCalled();
      });
      reported.mockRestore();
    });

    it('retries on the next call when the account read failed transiently', async () => {
      await signedInOnThisDevice();
      fixture.serve('/auth/me', () => Response.json({ code: 'INTERNAL' }, { status: 500 }));
      await initAuth();
      expect(useAuthStore.getState().user).toBeNull();

      fixture.serve('/auth/me', fixture.stockRoute('/auth/me'));
      await initAuth();

      expect(useAuthStore.getState().user).toEqual(fixture.user);
      expectAccountPrivateKey(fixture, useAuthStore.getState().privateKey);
    });

    it('retries on the next call when a previous attempt threw', async () => {
      await signedInOnThisDevice();
      fixture.serve('/auth/me', () => {
        throw new Error('Network error');
      });
      await initAuth();
      expect(useAuthStore.getState().user).toBeNull();

      fixture.serve('/auth/me', fixture.stockRoute('/auth/me'));
      await initAuth();

      expect(useAuthStore.getState().user).toEqual(fixture.user);
    });

    it('does not run again once a restore has succeeded', async () => {
      await signedInOnThisDevice();
      await initAuth();
      expect(useAuthStore.getState().user).toEqual(fixture.user);

      await initAuth();

      expect(fixture.requestsTo('/auth/me')).toHaveLength(1);
    });

    it('decrypts the stored custom instructions on restore', async () => {
      await signedInOnThisDevice();
      fixture.instructions = fixture.encryptInstructions('Be concise and direct');

      await initAuth();
      await instructionsRead();

      expect(fixture.requestsTo('/account/instructions')).toHaveLength(1);
      expect(useAuthStore.getState().customInstructions).toBe('Be concise and direct');
    });

    it('leaves custom instructions null when the account has none stored', async () => {
      await signedInOnThisDevice();

      await initAuth();
      await instructionsRead();

      expect(useAuthStore.getState().customInstructions).toBeNull();
      expect(useAuthStore.getState().customInstructionsStatus).toBe('absent');
    });

    it('leaves custom instructions null when the stored blob does not decrypt', async () => {
      await signedInOnThisDevice();
      fixture.instructions = 'bm90LWEtcmVhbC1ibG9i';
      const reported = vi.spyOn(console, 'error').mockImplementation(() => {});

      await initAuth();
      await vi.waitFor(() => {
        expect(reported).toHaveBeenCalled();
      });

      expect(useAuthStore.getState().customInstructions).toBeNull();
      // The account does store an instruction, so the read that could not open
      // it has no answer to give: `absent` would say this account stores none.
      expect(useAuthStore.getState().customInstructionsStatus).toBe('pending');
      expect(useAuthStore.getState().user).toEqual(fixture.user);
      reported.mockRestore();
    });

    it('settles to logged-out when reading the stored marker throws', async () => {
      environment.storage.failRead = true;

      await expect(initAuth()).resolves.toBeUndefined();

      expect(useAuthStore.getState().isLoading).toBe(false);
      expect(useAuthStore.getState().user).toBeNull();
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
    });

    it('does not cache a rejected promise when reading the stored marker throws', async () => {
      environment.storage.failRead = true;
      await initAuth();

      environment.storage.failRead = false;
      await expect(initAuth()).resolves.toBeUndefined();
    });
  });

  describe('the stored instruction read', () => {
    interface HeldRead {
      /** Answers the held request; the returned response's `bodyUsed` flips once it is read. */
      readonly release: (instructions: string | null) => Response;
    }

    /** Serves `/account/instructions` with a request that answers only when released. */
    function heldInstructionsRead(): HeldRead {
      let answer: (response: Response) => void = () => {};
      const response = new Promise<Response>((resolve) => {
        answer = resolve;
      });
      fixture.serve('/account/instructions', () => response);
      return {
        release: (instructions) => {
          const served = Response.json({ instructions });
          answer(served);
          return served;
        },
      };
    }

    /** Drains the microtasks the released read's own continuation runs on. */
    async function drainContinuations(): Promise<void> {
      for (let index = 0; index < 20; index += 1) await Promise.resolve();
    }

    interface InstructionsReading {
      readonly status: string;
      readonly value: string | null;
    }

    function reading(): InstructionsReading {
      const { customInstructions, customInstructionsStatus } = useAuthStore.getState();
      return { status: customInstructionsStatus, value: customInstructions };
    }

    it('restores the session while the read is still open', async () => {
      await signedInOnThisDevice();
      heldInstructionsRead();

      await initAuth();

      expect(useAuthStore.getState().user).toEqual(fixture.user);
      expect(useAuthStore.getState().isLoading).toBe(false);
      expect(fixture.requestsTo('/account/instructions')).toHaveLength(1);
    });

    it('admits a route guard while the read is still open', async () => {
      await signedInOnThisDevice();
      useAuthStore.setState({ user: null, isAuthenticated: false });
      heldInstructionsRead();

      await expect(requireAuth()).resolves.toEqual({ user: fixture.user });
    });

    it('tells an unanswered read, an account with none, and a stored one apart', async () => {
      await signedInOnThisDevice();
      const held = heldInstructionsRead();
      await initAuth();
      const unanswered = reading();

      const served = held.release(null);
      await vi.waitFor(() => {
        expect(served.bodyUsed).toBe(true);
      });
      await drainContinuations();
      const none = reading();

      resetAuthEnvironment(fixture);
      await signedInOnThisDevice();
      fixture.instructions = fixture.encryptInstructions('Be concise and direct');
      await initAuth();
      await instructionsRead();
      const stored = reading();

      expect(unanswered).toEqual({ status: 'pending', value: null });
      expect(none).toEqual({ status: 'absent', value: null });
      expect(stored).toEqual({ status: 'present', value: 'Be concise and direct' });
      expect(new Set([unanswered, none, stored].map((one) => JSON.stringify(one))).size).toBe(3);
    });

    it("keeps the user's own save when a slow read answers after it", async () => {
      await signedInOnThisDevice();
      const held = heldInstructionsRead();
      await initAuth();

      useAuthStore.getState().setCustomInstructions('typed while the read was open');
      const served = held.release(fixture.encryptInstructions('what the server still held'));
      await vi.waitFor(() => {
        expect(served.bodyUsed).toBe(true);
      });
      await drainContinuations();

      expect(reading()).toEqual({
        status: 'present',
        value: 'typed while the read was open',
      });
    });

    it('declines a read issued for an account the store no longer holds', async () => {
      await signedInOnThisDevice();
      const held = heldInstructionsRead();
      await initAuth();

      // The dev persona picker's switch: sign out and sign in as someone else
      // with no reload, leaving the first account's read open over the second
      // account's store.
      useAuthStore.getState().clear();
      useAuthStore.getState().setUser({ ...fixture.user, id: 'a-second-account' });

      const served = held.release(null);
      await vi.waitFor(() => {
        expect(served.bodyUsed).toBe(true);
      });
      await drainContinuations();

      expect(reading()).toEqual({ status: 'pending', value: null });
    });

    it('declines a read that answers after the session was signed out', async () => {
      await signedInOnThisDevice();
      const held = heldInstructionsRead();
      await initAuth();

      useAuthStore.getState().clear();

      const served = held.release(null);
      await vi.waitFor(() => {
        expect(served.bodyUsed).toBe(true);
      });
      await drainContinuations();

      expect(reading()).toEqual({ status: 'pending', value: null });
    });

    describe('the predicate every surface that must not act on the value shares', () => {
      /** Every principal the store can hold, asked of the one predicate. */
      function unresolved(): boolean {
        return selectInstructionsReadUnresolved(useAuthStore.getState());
      }

      it('holds an account whose read has not answered', async () => {
        await signedInOnThisDevice();
        heldInstructionsRead();
        await initAuth();

        expect(unresolved()).toBe(true);
      });

      it('releases the account once its read lands on one that stores none', async () => {
        await signedInOnThisDevice();
        await initAuth();
        await instructionsRead();

        expect(unresolved()).toBe(false);
      });

      it('holds no visitor without an account, for whom no read is ever issued', () => {
        useAuthStore.getState().clear();

        expect(unresolved()).toBe(false);
      });

      it('releases a seeded session that settled its own status with no read', () => {
        useAuthStore.getState().clear();
        useAuthStore.getState().setUser(fixture.user);
        useAuthStore.getState().setCustomInstructions(null);

        expect(unresolved()).toBe(false);
      });
    });
  });

  describe('requireAuth', () => {
    it('returns the user when the session is already authenticated', async () => {
      useAuthStore.setState({ user: fixture.user, isAuthenticated: true });

      const result = await requireAuth();

      expect(result).toEqual({ user: fixture.user });
      expect(fixture.requests).toHaveLength(0);
    });

    it('restores the session and returns the user when not authenticated', async () => {
      await signedInOnThisDevice();
      useAuthStore.setState({ user: null, isAuthenticated: false });

      const result = await requireAuth();

      expect(result).toEqual({ user: fixture.user });
    });

    it('redirects to login when no session can be restored', async () => {
      useAuthStore.setState({ user: null, isAuthenticated: false });

      await expect(requireAuth()).rejects.toEqual({ to: '/login' });
      expect(redirect).toHaveBeenCalledWith({ to: '/login' });
    });

    it('redirects to login when the stored device key is gone', async () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: fixture.userId }));
      useAuthStore.setState({ user: null, isAuthenticated: false });

      await expect(requireAuth()).rejects.toEqual({ to: '/login' });
    });
  });

  describe('authClient.getSession', () => {
    it('returns the user when authenticated', async () => {
      useAuthStore.setState({ user: fixture.user, isAuthenticated: true, isLoading: false });

      const result = await authClient.getSession();

      expect(result).toEqual({ data: { user: fixture.user } });
    });

    it('returns no data when not authenticated', async () => {
      useAuthStore.setState({ user: null, isAuthenticated: false, isLoading: false });

      const result = await authClient.getSession();

      expect(result).toEqual({ data: null });
    });

    it('restores the session before checking authentication', async () => {
      await signedInOnThisDevice();
      useAuthStore.setState({ user: null, isAuthenticated: false });

      const result = await authClient.getSession();

      expect(result).toEqual({ data: { user: fixture.user } });
      expect(fixture.requestsTo('/auth/me')).toHaveLength(1);
    });
  });

  describe('authClient.tokenLogin', () => {
    it('posts the token as JSON with session credentials', async () => {
      const result = await authClient.tokenLogin({ token: 'valid-token' });

      expect(result.error).toBeUndefined();
      const [request] = fixture.requestsTo('/auth/token-login');
      expect(request?.init?.method).toBe('POST');
      expect(request?.init?.credentials).toBe('include');
      expect(new Headers(request?.init?.headers).get('Content-Type')).toBe('application/json');
      expect(request?.body).toEqual({ token: 'valid-token' });
    });

    it('surfaces the code a refused token login carries', async () => {
      fixture.serve('/auth/token-login', () =>
        Response.json({ code: 'LOGIN_TOKEN_INVALID' }, { status: 401 })
      );

      const result = await authClient.tokenLogin({ token: 'bad-token' });

      expect(result.error).toEqual({
        message: 'This login link has expired or already been used.',
      });
    });

    it('returns the generic failure when the network is down', async () => {
      fixture.serve('/auth/token-login', () => {
        throw new Error('Network error');
      });

      const result = await authClient.tokenLogin({ token: 'some-token' });

      expect(result.error).toEqual({ message: 'Something went wrong. Please try again later.' });
    });
  });

  describe('authClient.resendVerification', () => {
    it('posts the email as JSON with session credentials', async () => {
      const result = await authClient.resendVerification({ email: 'test@example.com' });

      expect(result.error).toBeUndefined();
      const [request] = fixture.requestsTo('/auth/verify-email/resend');
      expect(request?.init?.method).toBe('POST');
      expect(request?.init?.credentials).toBe('include');
      expect(request?.body).toEqual({ email: 'test@example.com' });
    });

    it('surfaces the code a refused resend carries', async () => {
      fixture.serve('/auth/verify-email/resend', () =>
        Response.json({ code: 'RATE_LIMITED' }, { status: 429 })
      );

      const result = await authClient.resendVerification({ email: 'test@example.com' });

      expect(result.error).toEqual({
        message: 'Too many attempts. Try again in a moment.',
      });
    });

    it('returns the generic failure when the network is down', async () => {
      fixture.serve('/auth/verify-email/resend', () => {
        throw new Error('Network error');
      });

      const result = await authClient.resendVerification({ email: 'test@example.com' });

      expect(result.error).toEqual({ message: 'Something went wrong. Please try again later.' });
    });
  });

  describe('session-revocation clearer', () => {
    it('registers a revocation clearer with the query provider on import', () => {
      expect(registeredRevocationClearer).toBeDefined();
    });

    it('clears auth and reports true when an authenticated session exists', () => {
      useAuthStore.setState({ user: fixture.user, isAuthenticated: true });

      expect(definedClearer()()).toBe(true);
      expect(useAuthStore.getState().isAuthenticated).toBe(false);
      expect(useAuthStore.getState().user).toBeNull();
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it('starts a device-key purge it cannot await', async () => {
      await signedInOnThisDevice();
      useAuthStore.setState({ user: fixture.user, isAuthenticated: true });

      definedClearer()();

      // Unawaited on purpose — the redirect this returning true triggers may kill
      // it, and the next load's no-marker branch awaits the same purge. Pinned as
      // started so nobody "simplifies" the earlier, usually-winning attempt away.
      await vi.waitFor(async () => {
        expect(await loadExportKeyProtected()).toBeNull();
      });
    });

    it('clears auth and reports true when only a stored-auth marker exists', () => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: fixture.userId }));

      expect(definedClearer()()).toBe(true);
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    // The expected login-challenge 401 fires before any session exists, so the
    // clearer must leave a device key from an earlier tab exactly where it is.
    it('reports false and destroys no key material when no session exists', async () => {
      await signedInOnThisDevice();
      localStorage.removeItem(STORAGE_KEY);

      expect(definedClearer()()).toBe(false);
      expect(await loadExportKeyProtected()).not.toBeNull();
    });
  });
});
