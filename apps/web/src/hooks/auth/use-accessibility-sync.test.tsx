import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

vi.mock('@/lib/api-client', () => ({
  client: {
    account: {
      preferences: {
        accessibility: {
          $get: vi.fn(),
          $put: vi.fn(),
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

vi.mock('@/lib/auth/auth', () => ({
  useSession: vi.fn(),
}));

import {
  useA11yStore,
  ACCESSIBILITY_PREFERENCES_DEFAULTS,
  type AccessibilityPreferences,
} from '@hushbox/ui/accessibility/store';
import { HOUR_MS, TEST_DAY_START, isoAt, setClock } from '@hushbox/shared/test-time';
import { client, fetchJson } from '@/lib/api-client';
import { useSession } from '@/lib/auth/auth';
import { useAccessibilitySync } from '@/hooks/auth/use-accessibility-sync';

const mockedFetchJson = vi.mocked(fetchJson);
const mockedClient = vi.mocked(client, true);
const mockedUseSession = vi.mocked(useSession);

function makeWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const Wrapper: React.FC<{ children: React.ReactNode }> = ({ children }) =>
    React.createElement(QueryClientProvider, { client: queryClient }, children);
  return Wrapper;
}

function authed(userId = 'user-1'): void {
  mockedUseSession.mockReturnValue({
    data: { user: { id: userId, email: `${userId}@example.com` }, session: { id: `s-${userId}` } },
    isPending: false,
  } as unknown as ReturnType<typeof useSession>);
}

function unauthed(): void {
  mockedUseSession.mockReturnValue({
    data: null,
    isPending: false,
  } as unknown as ReturnType<typeof useSession>);
}

function resetStore(): void {
  useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS, updatedAt: null });
}

const ACCOUNT_COPY_KEY = 'hushbox.a11y.account.v1.user-1';
const DEVICE_BLOB_KEY = 'hushbox.a11y.v1';

/**
 * The suite-wide setup stubs `localStorage` with a no-op, which would make every
 * account-scoped read return null regardless of what the hook wrote. These cases
 * are about what reaches storage, so they need one that remembers.
 */
function installMemoryStorage(): void {
  const entries = new Map<string, string>();
  const storage: Storage = {
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => {
      entries.set(key, value);
    },
    removeItem: (key) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
    key: (index) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    value: storage,
    writable: true,
    configurable: true,
  });
}

function seedAccountCopy(preferences: AccessibilityPreferences, updatedAt: string): void {
  localStorage.setItem(ACCOUNT_COPY_KEY, JSON.stringify({ preferences, updatedAt }));
}

function setVisibility(state: 'visible' | 'hidden'): void {
  Object.defineProperty(document, 'visibilityState', {
    value: state,
    writable: true,
    configurable: true,
  });
  document.dispatchEvent(new Event('visibilitychange'));
}

describe('useAccessibilitySync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installMemoryStorage();
    resetStore();
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('unauthenticated', () => {
    it('does not call GET when no session', () => {
      unauthed();
      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      expect(mockedClient.account.preferences.accessibility.$get).not.toHaveBeenCalled();
    });

    it('does not PUT when store changes', async () => {
      unauthed();
      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      // Give microtasks a chance
      await Promise.resolve();
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });
  });

  describe('authenticated boot reconcile', () => {
    it('overwrites local store when server has newer timestamp', async () => {
      authed();
      const serverTs = isoAt(TEST_DAY_START + 12 * HOUR_MS);
      mockedFetchJson.mockResolvedValueOnce({
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'high' },
        updatedAt: serverTs,
      });
      resetStore();

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );

      await waitFor(() => {
        expect(useA11yStore.getState().contrast).toBe('high');
      });
      expect(useA11yStore.getState().updatedAt).toBe(serverTs);
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });

    it('pushes the account copy to the server when its timestamp is newer', async () => {
      authed();
      const localTs = isoAt(TEST_DAY_START + 13 * HOUR_MS);
      const serverTs = isoAt(TEST_DAY_START + 12 * HOUR_MS);
      seedAccountCopy({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'high' }, localTs);
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: serverTs,
        })
        .mockResolvedValueOnce({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );

      await waitFor(() => {
        expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);
      });
      const putMock = mockedClient.account.preferences.accessibility.$put as ReturnType<
        typeof vi.fn
      >;
      const putCall = putMock.mock.calls[0]?.[0] as {
        json: { updatedAt: string; preferences: { contrast: string } };
      };
      expect(putCall.json.updatedAt).toBe(localTs);
      expect(putCall.json.preferences.contrast).toBe('high');
      expect(useA11yStore.getState().contrast).toBe('high');
      expect(useA11yStore.getState().updatedAt).toBe(localTs);
    });

    it('gives the tie to the server when the account copy shares its timestamp', async () => {
      authed();
      const ts = isoAt(TEST_DAY_START + 12 * HOUR_MS);
      seedAccountCopy({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'high' }, ts);
      mockedFetchJson.mockResolvedValueOnce({
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'low' },
        updatedAt: ts,
      });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );

      await waitFor(() => {
        expect(mockedFetchJson).toHaveBeenCalled();
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
      expect(useA11yStore.getState().contrast).toBe('low');
    });

    it('pulls from server when local has no timestamp (fresh device)', async () => {
      authed();
      const serverTs = isoAt(TEST_DAY_START + 12 * HOUR_MS);
      mockedFetchJson.mockResolvedValueOnce({
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, fontSize: '141' },
        updatedAt: serverTs,
      });
      resetStore();

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );

      await waitFor(() => {
        expect(useA11yStore.getState().fontSize).toBe('141');
      });
      expect(useA11yStore.getState().updatedAt).toBe(serverTs);
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });

    it('does not echo a PUT after pulling server state (debounce window)', async () => {
      authed();
      vi.useFakeTimers();
      const serverTs = isoAt(TEST_DAY_START + 12 * HOUR_MS);
      mockedFetchJson.mockResolvedValueOnce({
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, contrast: 'high' },
        updatedAt: serverTs,
      });
      resetStore();

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );

      // Drain GET + boot reconcile.
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      expect(useA11yStore.getState().contrast).toBe('high');
      expect(useA11yStore.getState().updatedAt).toBe(serverTs);

      // Boot's setState must be deduped — no PUT should fire even after the
      // 750ms debounce window has elapsed.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });
  });

  describe('two users, one device', () => {
    it('writes nothing to a second account that has never synced on this device', async () => {
      vi.useFakeTimers();
      setClock(TEST_DAY_START + 10 * HOUR_MS);
      const putSpy = mockedClient.account.preferences.accessibility.$put as ReturnType<
        typeof vi.fn
      >;

      authed('user-1');
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 9 * HOUR_MS),
        })
        .mockResolvedValue({ accepted: true });

      const firstUser = renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(putSpy).toHaveBeenCalledTimes(1);
      firstUser.unmount();

      putSpy.mockClear();
      mockedFetchJson.mockReset();
      mockedFetchJson.mockResolvedValueOnce({
        preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
        updatedAt: null,
      });
      authed('user-2');

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(putSpy).not.toHaveBeenCalled();
    });

    it("applies a second account's server preferences over the settings left on the device", async () => {
      vi.useFakeTimers();
      const serverTs = isoAt(TEST_DAY_START + 12 * HOUR_MS);
      useA11yStore.setState({
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        contrast: 'high',
        updatedAt: isoAt(TEST_DAY_START + 13 * HOUR_MS),
      });
      authed('user-2');
      mockedFetchJson.mockResolvedValueOnce({
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, fontSize: '141' },
        updatedAt: serverTs,
      });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
      expect(useA11yStore.getState().fontSize).toBe('141');
      expect(useA11yStore.getState().contrast).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.contrast);
    });

    it('leaves the device settings applied for an account with nothing stored anywhere', async () => {
      vi.useFakeTimers();
      useA11yStore.setState({
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        contrast: 'high',
        updatedAt: isoAt(TEST_DAY_START + 13 * HOUR_MS),
      });
      authed('user-2');
      mockedFetchJson.mockResolvedValueOnce({
        preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
        updatedAt: null,
      });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(useA11yStore.getState().contrast).toBe('high');
    });

    it("pushes an account's own local copy when it is ahead of the server", async () => {
      vi.useFakeTimers();
      setClock(TEST_DAY_START + 10 * HOUR_MS);
      const putSpy = mockedClient.account.preferences.accessibility.$put as ReturnType<
        typeof vi.fn
      >;

      authed('user-1');
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 9 * HOUR_MS),
        })
        .mockRejectedValueOnce(new Error('network error'));

      const firstVisit = renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      act(() => {
        useA11yStore.getState().update({ magnifier: true });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(putSpy).toHaveBeenCalledTimes(1);
      firstVisit.unmount();

      // The push never landed, so the server is still behind on the next visit.
      putSpy.mockClear();
      resetStore();
      mockedFetchJson.mockReset();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 9 * HOUR_MS),
        })
        .mockResolvedValue({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      expect(putSpy).toHaveBeenCalledTimes(1);
      const retried = putSpy.mock.calls[0]?.[0] as {
        json: { preferences: { magnifier: boolean } };
      };
      expect(retried.json.preferences.magnifier).toBe(true);
      expect(useA11yStore.getState().magnifier).toBe(true);
    });

    it('stores the synced copy under a key naming the account', async () => {
      vi.useFakeTimers();
      setClock(TEST_DAY_START + 10 * HOUR_MS);
      authed('user-1');
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 9 * HOUR_MS),
        })
        .mockResolvedValue({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      const stored = localStorage.getItem(ACCOUNT_COPY_KEY);
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored!) as { preferences: { contrast: string } };
      expect(parsed.preferences.contrast).toBe('high');
    });

    it('keeps writing the device blob the pre-paint bootstrap reads', async () => {
      vi.useFakeTimers();
      setClock(TEST_DAY_START + 10 * HOUR_MS);
      authed('user-1');
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 9 * HOUR_MS),
        })
        .mockResolvedValue({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      const deviceBlob = localStorage.getItem(DEVICE_BLOB_KEY);
      expect(deviceBlob).not.toBeNull();
      const parsed = JSON.parse(deviceBlob!) as { state: { contrast: string } };
      expect(parsed.state.contrast).toBe('high');
    });

    it('treats a corrupt account copy as absent, leaving the server authoritative', async () => {
      vi.useFakeTimers();
      localStorage.setItem(ACCOUNT_COPY_KEY, '{not json');
      useA11yStore.setState({
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        contrast: 'high',
        updatedAt: isoAt(TEST_DAY_START + 13 * HOUR_MS),
      });
      authed('user-1');
      mockedFetchJson.mockResolvedValueOnce({
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, fontSize: '141' },
        updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
      });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
      expect(useA11yStore.getState().fontSize).toBe('141');
    });

    it('treats an account copy without a usable timestamp as absent', async () => {
      vi.useFakeTimers();
      seedAccountCopy(ACCESSIBILITY_PREFERENCES_DEFAULTS, 'not-a-date');
      useA11yStore.setState({
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        contrast: 'high',
        updatedAt: isoAt(TEST_DAY_START + 13 * HOUR_MS),
      });
      authed('user-1');
      mockedFetchJson.mockResolvedValueOnce({
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, fontSize: '141' },
        updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
      });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
      expect(useA11yStore.getState().fontSize).toBe('141');
    });

    it('treats a non-object account copy as absent', async () => {
      vi.useFakeTimers();
      localStorage.setItem(ACCOUNT_COPY_KEY, '"a string"');
      useA11yStore.setState({
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        contrast: 'high',
        updatedAt: isoAt(TEST_DAY_START + 13 * HOUR_MS),
      });
      authed('user-1');
      mockedFetchJson.mockResolvedValueOnce({
        preferences: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, fontSize: '141' },
        updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
      });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
      expect(useA11yStore.getState().fontSize).toBe('141');
    });
  });

  describe('debounced sync', () => {
    it('PUTs 750ms after a store change', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
        })
        .mockResolvedValueOnce({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );

      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(700);
      });
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);
    });

    it('does not drop a pending write when the PUT lifecycle transitions mid-debounce', async () => {
      authed();
      vi.useFakeTimers();

      let resolveFirstPut: ((value: unknown) => void) | null = null;
      const firstPutSettled = new Promise<unknown>((resolve) => {
        resolveFirstPut = resolve;
      });

      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
        })
        // First PUT stays in-flight until we resolve it, so its mutation
        // lifecycle transitions (pending -> success) land mid-debounce.
        .mockReturnValueOnce(firstPutSettled)
        .mockResolvedValue({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      // First toggle: debounce fires, PUT #1 sent and left pending.
      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);

      // Second toggle starts a fresh debounce window.
      act(() => {
        useA11yStore.getState().update({ fontSize: '141' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });

      // PUT #1 resolves mid-debounce, flipping the mutation pending -> success.
      // This must not reset the second toggle's debounce timer.
      await act(async () => {
        resolveFirstPut?.({ accepted: true });
        await firstPutSettled;
        await vi.advanceTimersByTimeAsync(0);
      });

      // Finish the second debounce window.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(2);
      const putMock = mockedClient.account.preferences.accessibility.$put as ReturnType<
        typeof vi.fn
      >;
      const secondPutCall = putMock.mock.calls[1]?.[0] as {
        json: { preferences: { fontSize: string } };
      };
      expect(secondPutCall.json.preferences.fontSize).toBe('141');
    });

    it('coalesces multiple changes within debounce window into a single PUT', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
        })
        .mockResolvedValue({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      act(() => {
        useA11yStore.getState().update({ fontSize: '141' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(300);
      });
      act(() => {
        useA11yStore.getState().update({ magnifier: true });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);
      const putMock = mockedClient.account.preferences.accessibility.$put as ReturnType<
        typeof vi.fn
      >;
      const putCall = putMock.mock.calls[0]?.[0] as {
        json: { preferences: { contrast: string; fontSize: string; magnifier: boolean } };
      };
      expect(putCall.json.preferences.contrast).toBe('high');
      expect(putCall.json.preferences.fontSize).toBe('141');
      expect(putCall.json.preferences.magnifier).toBe(true);
    });
  });

  describe('visibility flush', () => {
    it('flushes pending PUT immediately when tab becomes hidden', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
        })
        .mockResolvedValueOnce({ accepted: true });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();

      await act(async () => {
        setVisibility('hidden');
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);
    });

    it('does nothing when becoming hidden with no pending PUT', async () => {
      authed();
      mockedFetchJson.mockResolvedValueOnce({
        preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
        updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
      });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await waitFor(() => {
        expect(mockedFetchJson).toHaveBeenCalled();
      });
      // Let the GET resolution settle into React state before flipping visibility.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      act(() => {
        setVisibility('hidden');
      });
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });
  });

  describe('failure modes', () => {
    it('silently absorbs a PUT failure (no throw, store unchanged)', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
        })
        .mockRejectedValueOnce(new Error('network error'));

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });
      expect(useA11yStore.getState().contrast).toBe('high');
    });

    it('silently absorbs a GET failure (does not throw, store unchanged)', async () => {
      authed();
      mockedFetchJson.mockRejectedValueOnce(new Error('401'));
      useA11yStore.setState({
        ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
        contrast: 'high',
        updatedAt: isoAt(TEST_DAY_START + 13 * HOUR_MS),
      });

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await waitFor(() => {
        expect(mockedFetchJson).toHaveBeenCalled();
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      // Store still has whatever the user had
      expect(useA11yStore.getState().contrast).toBe('high');
    });
  });

  describe('cleanup', () => {
    it('flushes a pending write when the app layout unmounts', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
        })
        .mockResolvedValue({ accepted: true });

      // `useAccessibilitySync` is called in the body of `AppLayout`, the `/_app`
      // pathless layout route, so leaving that tree (sign-out, a public share
      // link) unmounts the component holding the hook.
      const { unmount } = renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      act(() => {
        useA11yStore.getState().update({ fontSize: '141' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();

      await act(async () => {
        unmount();
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);
      const putMock = mockedClient.account.preferences.accessibility.$put as ReturnType<
        typeof vi.fn
      >;
      const putCall = putMock.mock.calls[0]?.[0] as {
        json: { preferences: { fontSize: string } };
      };
      expect(putCall.json.preferences.fontSize).toBe('141');
    });

    it('does not PUT again when the debounce window elapses after unmount', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
        })
        .mockResolvedValueOnce({ accepted: true });

      const { unmount } = renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(100);
      });
      unmount();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2000);
      });

      // Unmount flushes the pending write; the timer it cancelled must not fire a second one.
      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);
    });
  });

  describe('subscribe and visibility guards', () => {
    it('does not flush when a visibilitychange fires while the tab stays visible', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson.mockResolvedValueOnce({
        preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
        updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
      });
      resetStore();

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });

      // A visibilitychange while the tab is still visible must not flush the
      // pending write early.
      act(() => {
        setVisibility('visible');
      });
      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });

    it('ignores a store change that does not bump the timestamp', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson
        .mockResolvedValueOnce({
          preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
          updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
        })
        .mockResolvedValue({ accepted: true });
      resetStore();

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      // A genuine mutation bumps the timestamp and arms the debounce.
      act(() => {
        useA11yStore.getState().update({ contrast: 'high' });
      });
      const mutatedTs = useA11yStore.getState().updatedAt;

      // A rehydrate-style write that reuses the same timestamp must be skipped
      // by the `state.updatedAt === previous.updatedAt` guard — it must not
      // spawn a second pending write.
      act(() => {
        useA11yStore.setState({ magnifier: true, updatedAt: mutatedTs });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(mockedClient.account.preferences.accessibility.$put).toHaveBeenCalledTimes(1);
    });

    it('ignores a store change that clears the timestamp to null', async () => {
      authed();
      vi.useFakeTimers();
      mockedFetchJson.mockResolvedValueOnce({
        preferences: ACCESSIBILITY_PREFERENCES_DEFAULTS,
        updatedAt: isoAt(TEST_DAY_START + 12 * HOUR_MS),
      });
      resetStore();

      renderHook(
        () => {
          useAccessibilitySync();
        },
        { wrapper: makeWrapper() }
      );
      await act(async () => {
        await vi.runOnlyPendingTimersAsync();
      });

      // Clearing updatedAt to null (an unsynced rehydrate) hits the null guard
      // and must not trigger a PUT.
      act(() => {
        useA11yStore.setState({ contrast: 'high', updatedAt: null });
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(800);
      });

      expect(mockedClient.account.preferences.accessibility.$put).not.toHaveBeenCalled();
    });
  });
});
