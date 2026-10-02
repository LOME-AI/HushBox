import { unwrapAccountKeyWithPassword as cryptoUnwrapAccountKey } from '@hushbox/crypto';
import { fromBase64 } from '@hushbox/shared';
import { ApiError } from '@/lib/api/api';
import { queryClient } from '@/providers/query-provider';
import {
  storeExportKeyProtected,
  loadExportKeyProtected,
  clearDeviceKeyStore,
} from '../device-key-store.js';
import { meQueryOptions } from './queries.js';
import { isLinkGuestActive } from './link-guest-auth.js';
import type { MeResponse } from './queries.js';

// Marker only — never key material. The export key itself lives device-protected
// in IndexedDB (see device-key-store). The marker records which user is signed in
// and, by which Web Storage area holds it, whether the session is persistent
// (localStorage = keep-signed-in) or tab-scoped (sessionStorage, cleared on tab
// close). The historical 'kek' key name is kept so an in-flight session's marker
// slot is stable across the upgrade.
export const STORAGE_KEY = 'hushbox_auth_kek';

type UnwrapAccountKey = (exportKey: Uint8Array, wrappedKey: Uint8Array) => Uint8Array;

interface StoredMarker {
  userId: string;
}

interface StoredAuth {
  userId: string;
  keepSignedIn: boolean;
}

interface RestoredSession {
  privateKey: Uint8Array;
  userId: string;
  user: MeResponse['user'];
}

/**
 * Persists the OPAQUE export key so the account private key can be unwrapped on
 * a later load without re-entering the password.
 *
 * The raw export key is never written to Web Storage. It is encrypted under a
 * per-device, non-extractable AES-GCM CryptoKey held in IndexedDB, and only the
 * ciphertext (with iv + userId) is persisted there. Web Storage holds a marker
 * with no key material:
 *
 * - `keepSignedIn` false (default): marker in sessionStorage — the browser clears
 *   only the marker on tab close; the device key + ciphertext persist until the
 *   next app load, where the no-marker branch (doInitAuth) purges them.
 * - `keepSignedIn` true: marker in localStorage — the persistent device key in
 *   IndexedDB keeps the user signed in across browser restarts until logout.
 */
export async function persistExportKey(
  exportKey: Uint8Array,
  userId: string,
  keepSignedIn: boolean
): Promise<void> {
  // Store the device-protected export key first so a present marker always
  // implies a decryptable key in IndexedDB.
  await storeExportKeyProtected(exportKey, userId);
  const marker = JSON.stringify({ userId } satisfies StoredMarker);
  if (keepSignedIn) {
    localStorage.setItem(STORAGE_KEY, marker);
    sessionStorage.removeItem(STORAGE_KEY);
  } else {
    sessionStorage.setItem(STORAGE_KEY, marker);
    localStorage.removeItem(STORAGE_KEY);
  }
}

/**
 * Reads the sign-in marker from Web Storage.
 *
 * Checks localStorage first (persistent sessions), then sessionStorage.
 * `keepSignedIn` reflects which area held the marker. Returns null when no
 * marker is present. This is a synchronous, key-material-free presence check;
 * the actual export key is loaded asynchronously from IndexedDB in
 * restoreSession().
 *
 * A malformed marker (unparseable JSON, missing userId) is treated as
 * logged-out: the corrupt entry is evicted and null is returned. Throwing here
 * would brick boot, since doInitAuth() calls this before its try/finally.
 */
export function getStoredAuth(): StoredAuth | null {
  const local = localStorage.getItem(STORAGE_KEY);
  const raw = local ?? sessionStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return null;
  }

  try {
    const marker = JSON.parse(raw) as StoredMarker;
    if (typeof marker.userId === 'string') {
      return { userId: marker.userId, keepSignedIn: local !== null };
    }
  } catch {
    // Malformed marker JSON — treated as logged out below.
  }
  clearAuthMarkers();
  return null;
}

/**
 * Returns true if a sign-in marker exists (sync Web Storage check).
 * Used to fire optimistic queries (e.g. balance) before initAuth() completes.
 * Returns false if storage is unavailable or throws.
 */
export function hasStoredAuth(): boolean {
  try {
    return getStoredAuth() !== null;
  } catch {
    return false;
  }
}

/**
 * Removes the Web Storage sign-in markers, and nothing else.
 *
 * The synchronous half of {@link clearStoredAuth}, for callers bound by a
 * synchronous contract: the markers go before the caller returns, and what the
 * caller does about the device key is left to its own call site.
 */
export function clearAuthMarkers(): void {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEY);
}

/**
 * Clears all stored auth: the Web Storage markers and the device-protected
 * export key in IndexedDB.
 *
 * Should be called on:
 * - Explicit logout
 * - Definitive auth failures (server returns 401 or 403)
 *
 * Await it. A caller that navigates or reloads without awaiting tears the JS
 * context down mid-delete and leaves the wrapped export key on disk.
 */
export async function clearStoredAuth(): Promise<void> {
  clearAuthMarkers();
  await purgeDeviceKeyQuietly();
}

// Removing the marker in clearAuthMarkers already logs the session out. The
// IndexedDB delete has no recovery path, so a failure is intentionally ignored
// rather than propagated to callers that only wanted the session gone.
export async function purgeDeviceKeyQuietly(): Promise<void> {
  try {
    await clearDeviceKeyStore();
  } catch {
    // Best-effort purge; nothing to recover if IndexedDB is unavailable.
  }
}

/**
 * Clears stored auth on a verdict the server handed down about `/me`.
 *
 * In link-guest mode the API client issues every request with credentials
 * deliberately omitted, so `/me` is answered as an anonymous request: its
 * verdict describes no session and must never destroy the visitor's key
 * material. Outside that mode the verdict is about the session, and stands.
 */
async function clearStoredAuthOnServerVerdict(): Promise<void> {
  if (isLinkGuestActive()) return;
  await clearStoredAuth();
}

// Fetches /me and validates it can drive a session restore. Returns null (after
// clearing definitively-invalid stored auth) when the session can't continue.
async function fetchMeForRestore(): Promise<MeResponse | null> {
  let data: MeResponse;
  try {
    // Routed through the query client so /me inherits the app-wide retry policy
    // (transient network/5xx blips are retried). 401/403 are not retryable, so
    // they fall through to the definitive-failure handling below.
    data = await queryClient.fetchQuery(meQueryOptions());
  } catch (error) {
    // Only clear stored auth on definitive auth failures (session invalid/forbidden).
    // Transient errors (500, 503, network) should NOT destroy the user's stored
    // encryption key — allow retry on next page load.
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      await clearStoredAuthOnServerVerdict();
    }
    return null;
  }

  // A body without the wrapped key cannot drive an unwrap. A page refreshed
  // during 2FA never reaches this check: `/me` is session-class, so the pipeline
  // refuses a half-authenticated principal, and the catch that clears stored
  // auth on 401/403 takes it.
  if (!data.passwordWrappedPrivateKey) {
    await clearStoredAuthOnServerVerdict();
    return null;
  }

  return data;
}

// A parameter, not a module binding: no module state can redirect a call site that did
// not opt in, and the return value hands any caller the plaintext key regardless.
export async function restoreSession(
  unwrapAccountKey: UnwrapAccountKey = cryptoUnwrapAccountKey
): Promise<RestoredSession | null> {
  const marker = getStoredAuth();
  if (!marker) {
    return null;
  }

  const data = await fetchMeForRestore();
  if (!data?.passwordWrappedPrivateKey) {
    return null;
  }

  let exportKey: Uint8Array;
  let userId: string;
  try {
    // Decrypt the export key into memory (transient) — never persisted as raw
    // bytes. A missing record means the marker outlived its device key (a closed
    // session tab); treat as logged out.
    const protectedKey = await loadExportKeyProtected();
    if (!protectedKey) {
      await clearStoredAuth();
      return null;
    }
    ({ exportKey, userId } = protectedKey);
  } catch {
    await clearStoredAuth();
    return null;
  }

  try {
    const wrappedKey = fromBase64(data.passwordWrappedPrivateKey);
    const privateKey = unwrapAccountKey(exportKey, wrappedKey);

    return { privateKey, userId, user: data.user };
  } catch {
    // Stored export key is corrupted or wrong (or the wrapped key is
    // unparseable) — clear it so the next load starts logged-out.
    await clearStoredAuth();
    return null;
  }
}
