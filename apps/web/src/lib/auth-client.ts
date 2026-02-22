import { unwrapAccountKeyWithPassword as cryptoUnwrapAccountKey } from '@hushbox/crypto';
import { toBase64, fromBase64 } from '@hushbox/shared';
import { getApiUrl } from '@/lib/api';

export const STORAGE_KEY = 'hushbox_auth_kek';

// Dependency injection for testing
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
 */
export function getStoredAuth(): RestoredAuth | null {
  const stored = localStorage.getItem(STORAGE_KEY) ?? sessionStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return null;
  }

  const data = JSON.parse(stored) as StoredAuth;
  return {
    kek: fromBase64(data.kek),
    userId: data.userId,
  };
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

/**
 * Restores a session from stored export key by fetching the wrapped account key from server.
 *
 * Flow:
 * 1. Get stored export key from browser storage
 * 2. Fetch wrapped account private key from server (validates session cookie)
 * 3. Unwrap account private key using export key
 * 4. Return private key and userId for use in the app
 *
 * Clears stored auth only on definitive auth failures (401/403).
 * Transient errors (500, network) return null without clearing storage.
 */
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
}

export async function restoreSession(): Promise<RestoredSession | null> {
  const storedAuth = getStoredAuth();
  if (!storedAuth) {
    return null;
  }

  try {
    const response = await fetch(`${getApiUrl()}/api/auth/me`, {
      credentials: 'include',
    });

    if (!response.ok) {
      // Only clear stored auth on definitive auth failures (session invalid/forbidden).
      // Transient errors (500, 503, network) should NOT destroy the user's stored
      // encryption key — allow retry on next page load.
      if (response.status === 401 || response.status === 403) {
        clearStoredAuth();
      }
      return null;
    }

    const data = (await response.json()) as MeResponse;

    // Page was refreshed during 2FA — password is gone, can't continue
    if (data.pending2FA) {
      clearStoredAuth();
      return null;
    }

    if (!data.passwordWrappedPrivateKey) {
      clearStoredAuth();
      return null;
    }

    const wrappedKey = fromBase64(data.passwordWrappedPrivateKey);

    try {
      const privateKey = unwrapImpl(storedAuth.kek, wrappedKey);

      return {
        privateKey,
        userId: storedAuth.userId,
        user: data.user,
      };
    } catch {
      // Stored export key is corrupted or wrong — clear it
      clearStoredAuth();
      return null;
    }
  } catch {
    // Network errors / timeouts — don't destroy stored auth.
    // The user can retry on next page load.
    return null;
  }
}
