import * as React from 'react';
import { QueryClient, QueryClientProvider, QueryCache, MutationCache } from '@tanstack/react-query';
import { ApiError, AccessExpiredError, AdminNotAuthorizedError } from '@/lib/api-client';
import { AccessDeniedScreen } from '@/components/util/access-denied';

/** TanStack's default retry count, kept for transient (5xx/transport) failures. */
const MAX_RETRIES = 3;

/** sessionStorage key holding the epoch-ms of the last re-auth reload. */
const REAUTH_RELOAD_AT_KEY = 'hushbox.admin.reauthReloadAt';

/** sessionStorage key holding how many re-auth reloads this session has spent. */
const REAUTH_RELOAD_COUNT_KEY = 'hushbox.admin.reauthReloadCount';

/**
 * Minimum gap between re-auth reloads. Survives the reload in sessionStorage so
 * an Access challenge that fails to clear the expired cookie cannot spin the
 * page into a reload loop; a genuine re-expiry after the window still re-auths.
 */
const REAUTH_RELOAD_MIN_INTERVAL_MS = 10_000;

/**
 * How many re-auth reloads a session may spend before the app gives up and
 * shows the terminal screen. Spacing alone only slows a loop — a challenge that
 * never clears would reload forever at one every ten seconds — so the budget is
 * what actually ends it, and it is the backstop for any refusal the signal
 * classification reads as transient when it is not. Successfully reaching the
 * API clears it, so a session that recovers keeps its full budget for the next
 * genuine expiry.
 */
const MAX_REAUTH_RELOADS = 3;

let accessDenied = false;
const accessDeniedListeners = new Set<() => void>();

function readAccessDenied(): boolean {
  return accessDenied;
}

function subscribeAccessDenied(listener: () => void): () => void {
  accessDeniedListeners.add(listener);
  return () => {
    accessDeniedListeners.delete(listener);
  };
}

/**
 * Enter the terminal state. Deliberately not persisted: a reload must re-test
 * the identity against the Worker rather than inherit a verdict, so fixing the
 * actor's authorization takes effect on the operator's next load.
 */
function denyAccess(): void {
  if (accessDenied) {
    return;
  }
  accessDenied = true;
  for (const listener of accessDeniedListeners) {
    listener();
  }
}

/**
 * A 4xx is a definitive answer (miss, validation, rate limit) — retrying it
 * repeats the identical request; only transient failures earn retries. Neither
 * an Access expiry nor a permanent refusal is transient — the retry would
 * refetch the login page, or collect the same refusal — so both short-circuit.
 *
 * `query-provider.test.tsx` reaches this as a member of the namespace object
 * from `await import('./query-provider.js')`; no file imports it by name.
 */
export function retryUnlessClientError(failureCount: number, error: unknown): boolean {
  if (error instanceof AccessExpiredError || error instanceof AdminNotAuthorizedError) {
    return false;
  }
  if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
    return false;
  }
  return failureCount < MAX_RETRIES;
}

/**
 * Give the session back its full reload budget once the API answers normally.
 *
 * `query-provider.test.tsx` reaches this as a member of the namespace object
 * from `await import('./query-provider.js')`; no file imports it by name.
 */
export function clearReauthReloads(): void {
  sessionStorage.removeItem(REAUTH_RELOAD_COUNT_KEY);
}

/**
 * Force a full navigation so Cloudflare Access re-runs its challenge on the
 * document request. Two sessionStorage counters, both outliving the reload: the
 * timestamp collapses a burst of parallel panel expiries into one reload, and
 * the spend count ends the sequence at the budget rather than merely spacing it.
 *
 * `query-provider.test.tsx` reaches this as a member of the namespace object
 * from `await import('./query-provider.js')`; no file imports it by name.
 */
export function reloadForReauth(): void {
  const now = Date.now();
  const lastAt = Number(sessionStorage.getItem(REAUTH_RELOAD_AT_KEY));
  if (lastAt && now - lastAt < REAUTH_RELOAD_MIN_INTERVAL_MS) {
    return;
  }
  const spent = Number(sessionStorage.getItem(REAUTH_RELOAD_COUNT_KEY));
  if (spent >= MAX_REAUTH_RELOADS) {
    denyAccess();
    return;
  }
  sessionStorage.setItem(REAUTH_RELOAD_COUNT_KEY, String(spent + 1));
  sessionStorage.setItem(REAUTH_RELOAD_AT_KEY, String(now));
  globalThis.location.reload();
}

/**
 * Cache-level error hook. A permanent refusal goes straight to the terminal
 * screen — no reload can change the Worker's answer — an expiry navigates, and
 * every other failure stays an error the screen renders as before.
 *
 * `query-provider.test.tsx` reaches this as a member of the namespace object
 * from `await import('./query-provider.js')`; no file imports it by name.
 */
export function handleAccessError(error: unknown): void {
  if (error instanceof AdminNotAuthorizedError) {
    denyAccess();
    return;
  }
  if (error instanceof AccessExpiredError) {
    reloadForReauth();
  }
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: handleAccessError, onSuccess: clearReauthReloads }),
  mutationCache: new MutationCache({ onError: handleAccessError }),
  defaultOptions: {
    queries: {
      staleTime: 1000 * 30,
      // An ops tool over live operational data: operators refetch explicitly;
      // a focus-triggered refetch mid-investigation is churn, not freshness.
      refetchOnWindowFocus: false,
      retry: retryUnlessClientError,
    },
  },
});

interface QueryProviderProps {
  children: React.ReactNode;
}

export function QueryProvider({ children }: Readonly<QueryProviderProps>): React.JSX.Element {
  const denied = React.useSyncExternalStore(subscribeAccessDenied, readAccessDenied);
  return (
    <QueryClientProvider client={queryClient}>
      {denied ? <AccessDeniedScreen /> : children}
    </QueryClientProvider>
  );
}
