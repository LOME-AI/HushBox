import * as React from 'react';
import { useQuery, useMutation } from '@tanstack/react-query';
import {
  useA11yStore,
  reconcileAccessibilityPreferences,
  type AccessibilityPreferences,
} from '@hushbox/ui/accessibility/store';
import { client, fetchJson } from '@/lib/api-client';
import { idempotencyExempt } from '@/lib/api/idempotent-mutation.js';
import { useStableSession } from '@/hooks/auth/use-stable-session';

const DEBOUNCE_MS = 750;
const ACCOUNT_COPY_KEY_PREFIX = 'hushbox.a11y.account.v1.';

interface AccountCopy {
  preferences: AccessibilityPreferences;
  updatedAt: string;
}

/**
 * Where one account's copy of the synced preferences lives on this device.
 * Deliberately not the device blob the accessibility store persists: that one is
 * shared by everyone who signs in here, and a reconcile that reads it compares
 * whoever last used the device against whoever is signing in now. Deriving the
 * key from the account id is what makes reading another account's copy
 * impossible rather than merely guarded against.
 */
function accountCopyKey(userId: string): string {
  return `${ACCOUNT_COPY_KEY_PREFIX}${userId}`;
}

function readAccountCopy(userId: string): AccountCopy | null {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(accountCopyKey(userId));
    if (raw === null) return null;
    parsed = JSON.parse(raw);
  } catch {
    // Blocked storage or an unparseable blob reads as "this account has nothing
    // here", which hands the decision to the server rather than to the device.
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { preferences, updatedAt } = parsed as { preferences?: unknown; updatedAt?: unknown };
  if (typeof updatedAt !== 'string' || !Number.isFinite(Date.parse(updatedAt))) return null;
  return { preferences: reconcileAccessibilityPreferences(preferences), updatedAt };
}

function writeAccountCopy(userId: string, copy: AccountCopy): void {
  try {
    localStorage.setItem(accountCopyKey(userId), JSON.stringify(copy));
  } catch {
    // A device that cannot persist the copy still syncs for this session; the
    // next boot simply takes the server as authoritative.
  }
}

interface ServerPrefsResponse {
  preferences: AccessibilityPreferences;
  updatedAt: string | null;
}

interface PutBody {
  preferences: AccessibilityPreferences;
  updatedAt: string;
}

function extractPrefs(state: ReturnType<typeof useA11yStore.getState>): AccessibilityPreferences {
  // Schema-driven: reconcile strips action functions and `updatedAt`, leaving
  // exactly the fields defined by `accessibilityPreferencesSchema`.
  return reconcileAccessibilityPreferences(state);
}

/**
 * Syncs accessibility preferences with the server using LWW semantics.
 * - Mount: GET, then reconcile the signed-in account's own copy against it.
 * - On store change: debounced PUT after DEBOUNCE_MS.
 * - On `visibilitychange` to 'hidden': flush any pending PUT immediately.
 *
 * The local side of every comparison is that account's copy, never the device
 * blob the accessibility store persists: on a shared device the device blob
 * belongs to whoever used it last, so comparing it against the server is how
 * one person's settings reach another person's account.
 *
 * Multi-device conflicts use whole-blob LWW — a later writer can clobber an
 * earlier writer's per-field changes. Acceptable here because accessibility
 * settings aren't co-edited in real time.
 *
 * Failures (401, network, etc.) are silently swallowed. The account copy is
 * written alongside every push, so a push that never landed is retried at the
 * next boot.
 */
export function useAccessibilitySync(): void {
  const { isAuthenticated, session } = useStableSession();
  const userId = isAuthenticated ? (session?.user.id ?? null) : null;

  const { data: serverPrefs } = useQuery<ServerPrefsResponse>({
    queryKey: ['accessibility-preferences', userId],
    queryFn: async (): Promise<ServerPrefsResponse> =>
      fetchJson(client.account.preferences.accessibility.$get()),
    enabled: userId !== null,
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  const putMutation = useMutation<unknown, Error, PutBody>({
    meta: idempotencyExempt('naturally-idempotent'),
    mutationFn: async (body: PutBody): Promise<unknown> =>
      fetchJson(client.account.preferences.accessibility.$put({ json: body })),
  });
  // TanStack Query's `mutate` is referentially stable across the mutation
  // lifecycle, but the mutation object is not. Depending on the whole object in
  // the sync effect below re-subscribes (and resets the debounce timer) on every
  // pending->success transition, which can drop a pending write.
  const { mutate: putMutate } = putMutation;

  const lastSyncedTsRef = React.useRef<string | null>(null);
  const bootReconciledForRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!serverPrefs || userId === null || bootReconciledForRef.current === userId) return;
    bootReconciledForRef.current = userId;

    const accountCopy = readAccountCopy(userId);
    const serverTs = serverPrefs.updatedAt;
    const serverMs = serverTs === null ? -Infinity : Date.parse(serverTs);
    const accountMs = accountCopy === null ? -Infinity : Date.parse(accountCopy.updatedAt);

    if (accountCopy !== null && accountMs > serverMs) {
      // This account's own copy is ahead of the server — a push that never
      // landed. Re-apply it and retry.
      lastSyncedTsRef.current = accountCopy.updatedAt;
      useA11yStore.setState({ ...accountCopy.preferences, updatedAt: accountCopy.updatedAt });
      putMutate({ preferences: accountCopy.preferences, updatedAt: accountCopy.updatedAt });
    } else if (serverTs === null) {
      // This account has nothing stored anywhere. Whatever the device is already
      // showing stands until the account changes something, and nothing is sent.
      lastSyncedTsRef.current = null;
    } else {
      // Server wins: stamp the dedup gate BEFORE applying server state so the
      // subscribe handler sees `state.updatedAt === lastSyncedTsRef.current`
      // and skips queuing an echo PUT.
      lastSyncedTsRef.current = serverTs;
      writeAccountCopy(userId, { preferences: serverPrefs.preferences, updatedAt: serverTs });
      useA11yStore.setState({ ...serverPrefs.preferences, updatedAt: serverTs });
    }
  }, [serverPrefs, putMutate, userId]);

  React.useEffect(() => {
    if (userId === null) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let pending: ReturnType<typeof useA11yStore.getState> | null = null;

    const flush = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending !== null && pending.updatedAt !== null) {
        const ts = pending.updatedAt;
        const preferences = extractPrefs(pending);
        lastSyncedTsRef.current = ts;
        writeAccountCopy(userId, { preferences, updatedAt: ts });
        putMutate({ preferences, updatedAt: ts });
        pending = null;
      }
    };

    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'hidden') flush();
    };

    const unsubscribe = useA11yStore.subscribe((state, previous) => {
      // Skip writes that originated from a server pull (same ts as last synced).
      if (state.updatedAt === lastSyncedTsRef.current) return;
      // Skip non-mutation rehydrates that don't bump the timestamp.
      if (state.updatedAt === previous.updatedAt) return;
      if (state.updatedAt === null) return;
      pending = state;
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(flush, DEBOUNCE_MS);
    });

    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibilityChange);
      // `flush()` clears the debounce timer itself, so it replaces the bare
      // clearTimeout: leaving the app layout must not drop a pending write.
      flush();
    };
  }, [userId, putMutate]);
}
