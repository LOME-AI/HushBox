import { unwrapAccountKeyWithPassword as cryptoUnwrapAccountKey } from '@hushbox/crypto';
import { toBase64, fromBase64 } from '@hushbox/shared';
import { ApiError } from '@/lib/api';
import { client, fetchJson } from '@/lib/api-client';

export const STORAGE_KEY = 'hushbox_auth_kek';

type UnwrapFunction = (exportKey: Uint8Array, wrappedKey: Uint8Array) => Uint8Array;
let unwrapImpl: UnwrapFunction = cryptoUnwrapAccountKey;

export function setUnwrapImpl(impl: UnwrapFunction): void {
  unwrapImpl = impl;
}

export function resetUnwrapImpl(): void {
  unwrapImpl = cryptoUnwrapAccountKey;
}

interface StoredAuth {
  kek: string; // Base64-encoded export key (kept as 'kek' for backward compat)
  userId: string;
}

export interface RestoredAuth {
  kek: Uint8Array;
  userId: string;
}

export interface RestoredSession {
  privateKey: Uint8Array;
  userId: string;
  user: MeResponse['user'];
  customInstructionsEncrypted: string | null;
}

/**
 * Persists the OPAQUE export key to browser storage.
 *
 * - If `keepSignedIn` is false (default): stored in sessionStorage
 *   - Cleared when browser is closed
 *   - Persists across page refreshes
 *
 * - If `keepSignedIn` is true: stored in localStorage
 *   - Persists even after browser is closed
 *   - User stays signed in until explicit logout
 *
 * The export key is stored (not the password or private key) because:
 * - Password is never stored (security)
 * - Private key is derived from wrapped key on server (requires server validation)
 * - Export key allows unwrapping account private key without re-entering password
 */
export function persistExportKey(
  exportKey: Uint8Array,
  userId: string,
  keepSignedIn: boolean
): void {
  const storage = keepSignedIn ? localStorage : sessionStorage;
  const data: StoredAuth = {
    kek: toBase64(exportKey),
    userId,
  };
  storage.setItem(STORAGE_KEY, JSON.stringify(data));
}

/**
 * Retrieves stored auth data from browser storage.
 *
 * Checks localStorage first (persisted sessions), then sessionStorage.
 * Returns null if no auth data is found.
 *
 * A malformed or legacy blob (unparseable JSON, bad base64) is treated as
 * logged-out: the corrupt entry is evicted and null is returned. Throwing here
 * would brick boot, since doInitAuth() calls this before its try/finally.
 */
export function getStoredAuth(): RestoredAuth | null {
  const stored = localStorage.getItem(STORAGE_KEY) ?? sessionStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return null;
  }

  try {
    const data = JSON.parse(stored) as StoredAuth;
    return {
      kek: fromBase64(data.kek),
      userId: data.userId,
    };
  } catch {
    clearStoredAuth();
    return null;
  }
}

/**
 * Returns true if stored auth credentials exist (sync localStorage check).
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
 * Clears all stored auth data from both localStorage and sessionStorage.
 *
 * Should be called on:
 * - Explicit logout
 * - Definitive auth failures (server returns 401 or 403)
 */
export function clearStoredAuth(): void {
  localStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(STORAGE_KEY);
}

export interface MeResponse {
  user: {
    id: string;
    email: string;
    username: string;
    emailVerified: boolean;
    totpEnabled: boolean;
    hasAcknowledgedPhrase: boolean;
  };
  pending2FA?: true;
  passwordWrappedPrivateKey?: string;
  publicKey?: string;
  customInstructionsEncrypted?: string | null;
}

export async function restoreSession(): Promise<RestoredSession | null> {
  const storedAuth = getStoredAuth();
  if (!storedAuth) {
    return null;
  }

  let data: MeResponse;
  try {
    data = await fetchJson<MeResponse>(client.api.auth.me.$get());
  } catch (error) {
    // Only clear stored auth on definitive auth failures (session invalid/forbidden).
    // Transient errors (500, 503, network) should NOT destroy the user's stored
    // encryption key — allow retry on next page load.
    if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
      clearStoredAuth();
    }
    return null;
  }

  // Page was refreshed during 2FA — password is gone, can't continue
  if (data.pending2FA) {
    clearStoredAuth();
    return null;
  }

  if (!data.passwordWrappedPrivateKey) {
    clearStoredAuth();
    return null;
  }

  try {
    const wrappedKey = fromBase64(data.passwordWrappedPrivateKey);
    const privateKey = unwrapImpl(storedAuth.kek, wrappedKey);

    return {
      privateKey,
      userId: storedAuth.userId,
      user: data.user,
      customInstructionsEncrypted: data.customInstructionsEncrypted ?? null,
    };
  } catch {
    // Stored export key is corrupted or wrong (or the wrapped key is
    // unparseable) — clear it so the next load starts logged-out.
    clearStoredAuth();
    return null;
  }
}
