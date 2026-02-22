import { create } from 'zustand';
import { redirect } from '@tanstack/react-router';
import { useShallow } from 'zustand/react/shallow';
import {
  createOpaqueClient,
  startRegistration,
  finishRegistration,
  startLogin,
  finishLogin,
  createAccount,
  unwrapAccountKeyWithPassword,
  rewrapAccountKeyForPasswordChange,
  recoverAccountFromMnemonic,
} from '@hushbox/crypto';
import {
  normalizeIdentifier,
  normalizeUsername,
  fromBase64,
  toBase64,
  ROUTES,
  friendlyErrorMessage,
} from '@hushbox/shared';

import { queryClient } from '@/providers/query-provider';
import { getApiUrl } from '@/lib/api';
import { clearEpochKeyCache } from '@/lib/epoch-key-cache';
import {
  STORAGE_KEY,
  persistExportKey,
  getStoredAuth,
  clearStoredAuth,
  restoreSession,
  type MeResponse,
} from './auth-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract error code from API response body and return user-facing message. */
export function parseErrorMessage(body: unknown): string {
  if (body && typeof body === 'object' && 'code' in body) {
    const code = (body as { code: unknown }).code;
    if (typeof code === 'string') return friendlyErrorMessage(code);
  }
  return friendlyErrorMessage('INTERNAL');
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface UserData {
  id: string;
  email: string;
  username: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  hasAcknowledgedPhrase: boolean;
}

interface AuthState {
  user: UserData | null;
  privateKey: Uint8Array | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  setUser: (user: UserData | null) => void;
  setPrivateKey: (key: Uint8Array) => void;
  setLoading: (isLoading: boolean) => void;
  clear: () => void;
}

interface SignInEmailResult {
  error?: { message: string };
  requires2FA?: boolean;
  verifyTOTP?: (code: string) => Promise<{ success: boolean; error?: string }>;
}

interface SignUpEmailResult {
  error?: { message: string };
}

interface VerifyEmailResult {
  error?: { message: string };
}

// ---------------------------------------------------------------------------
// Zustand Store
// ---------------------------------------------------------------------------

// SECURITY: No persist middleware. Private key must only exist in memory.
// Persisting would leak encryption keys to localStorage/sessionStorage.
export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  privateKey: null,
  isLoading: true,
  isAuthenticated: false,
  setUser: (user) => {
    set({ user, isAuthenticated: !!user });
  },
  setPrivateKey: (key) => {
    set({ privateKey: key });
  },
  setLoading: (isLoading) => {
    set({ isLoading });
  },
  clear: () => {
    const { privateKey } = get();
    if (privateKey) privateKey.fill(0);
    set({ user: null, privateKey: null, isAuthenticated: false, isLoading: false });
  },
}));

// ---------------------------------------------------------------------------
// useSession hook (backward-compatible with old Better Auth shape)
// ---------------------------------------------------------------------------

interface SessionHookResult {
  data: { user: UserData; session: { id: string } } | null;
  isPending: boolean;
}

export function useSession(): SessionHookResult {
  const { user, isLoading } = useAuthStore(
    useShallow((s) => ({ user: s.user, isLoading: s.isLoading }))
  );

  return {
    data: user ? { user, session: { id: user.id } } : null,
    isPending: isLoading,
  };
}

// ---------------------------------------------------------------------------
// signIn (OPAQUE protocol)
// ---------------------------------------------------------------------------

async function signInEmail(options: {
  identifier: string;
  password: string;
  keepSignedIn?: boolean;
}): Promise<SignInEmailResult> {
  const { identifier: rawIdentifier, password, keepSignedIn = false } = options;
  const identifier = normalizeIdentifier(rawIdentifier);
  const passwordBytes = new TextEncoder().encode(password);

  try {
    // 1. OPAQUE login init
    const client = createOpaqueClient();
    const { ke1 } = await startLogin(client, password);

    const initResponse = await fetch(`${getApiUrl()}/api/auth/login/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, ke1 }),
      credentials: 'include',
    });

    if (!initResponse.ok) {
      const body: unknown = await initResponse.json();
      return { error: { message: parseErrorMessage(body) } };
    }

    const { ke2 } = (await initResponse.json()) as {
      ke2: number[];
    };

    // 2. OPAQUE login finish (client-side) — gives us exportKey
    const loginResult = await finishLogin(client, ke2, globalThis.location.host);
    const exportKey = new Uint8Array(loginResult.exportKey);

    // 3. Send ke3 to server
    const finishResponse = await fetch(`${getApiUrl()}/api/auth/login/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, ke3: loginResult.ke3 }),
      credentials: 'include',
    });

    if (!finishResponse.ok) {
      const body: unknown = await finishResponse.json();
      return { error: { message: parseErrorMessage(body) } };
    }

    const finishData = (await finishResponse.json()) as {
      success?: true;
      requires2FA?: true;
      userId: string;
      email?: string;
      passwordWrappedPrivateKey?: string;
    };

    if (finishData.requires2FA) {
      // 2FA path: return callback that captures exportKey in closure
      return {
        requires2FA: true,
        verifyTOTP: async (code: string): Promise<{ success: boolean; error?: string }> => {
          try {
            const response = await fetch(`${getApiUrl()}/api/auth/login/2fa/verify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ code }),
              credentials: 'include',
            });

            if (!response.ok) {
              const body: unknown = await response.json();
              return { success: false, error: parseErrorMessage(body) };
            }

            const verifyResponse = (await response.json()) as {
              success: true;
              userId: string;
              passwordWrappedPrivateKey: string;
            };

            // Unwrap account private key using OPAQUE export key
            const accountPrivateKey = unwrapAccountKeyWithPassword(
              exportKey,
              fromBase64(verifyResponse.passwordWrappedPrivateKey)
            );
            persistExportKey(exportKey, verifyResponse.userId, keepSignedIn);
            useAuthStore.getState().setPrivateKey(accountPrivateKey);

            // Fetch full user data
            const meResponse = await fetch(`${getApiUrl()}/api/auth/me`, {
              credentials: 'include',
            });
            if (meResponse.ok) {
              const meData = (await meResponse.json()) as MeResponse;
              useAuthStore.getState().setUser(meData.user);
            }

            return { success: true };
          } catch {
            return { success: false, error: friendlyErrorMessage('2FA_VERIFICATION_FAILED') };
          }
        },
      };
    }

    // Non-2FA path: unwrap account private key immediately
    if (!finishData.passwordWrappedPrivateKey) {
      return { error: { message: friendlyErrorMessage('ENCRYPTION_NOT_SETUP') } };
    }

    const accountPrivateKey = unwrapAccountKeyWithPassword(
      exportKey,
      fromBase64(finishData.passwordWrappedPrivateKey)
    );
    persistExportKey(exportKey, finishData.userId, keepSignedIn);
    useAuthStore.getState().setPrivateKey(accountPrivateKey);

    // Fetch full user data from /me for complete profile
    const meResponse = await fetch(`${getApiUrl()}/api/auth/me`, {
      credentials: 'include',
    });
    if (meResponse.ok) {
      const meData = (await meResponse.json()) as MeResponse;
      useAuthStore.getState().setUser(meData.user);
    } else {
      // Fallback to minimal user info from login response
      useAuthStore.getState().setUser({
        id: finishData.userId,
        email: finishData.email ?? '',
        username: '',
        emailVerified: false,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
      });
    }

    return {};
  } catch {
    return { error: { message: friendlyErrorMessage('LOGIN_FAILED') } };
  } finally {
    passwordBytes.fill(0);
  }
}

export const signIn = {
  email: signInEmail,
};

// ---------------------------------------------------------------------------
// signUp (OPAQUE protocol)
// ---------------------------------------------------------------------------

async function signUpEmail(options: {
  username: string;
  email: string;
  password: string;
}): Promise<SignUpEmailResult> {
  const { username, email, password } = options;
  const normalizedUsername = normalizeUsername(username);
  const passwordBytes = new TextEncoder().encode(password);

  try {
    // 1. OPAQUE registration init
    const client = createOpaqueClient();
    const { serialized } = await startRegistration(client, password);

    const initResponse = await fetch(`${getApiUrl()}/api/auth/register/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        username: normalizedUsername,
        registrationRequest: serialized,
      }),
      credentials: 'include',
    });

    if (!initResponse.ok) {
      const body: unknown = await initResponse.json();
      return { error: { message: parseErrorMessage(body) } };
    }

    const { registrationResponse } = (await initResponse.json()) as {
      registrationResponse: number[];
    };

    // 2. OPAQUE registration finish (client-side) — gives us exportKey
    const { record, exportKey } = await finishRegistration(
      client,
      registrationResponse,
      globalThis.location.host
    );

    // 3. Create account crypto material using OPAQUE export key
    const opaqueExportKey = new Uint8Array(exportKey);
    const accountResult = await createAccount(opaqueExportKey);

    // 4. Send registration record and crypto material to server
    const finishResponse = await fetch(`${getApiUrl()}/api/auth/register/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        registrationRecord: record,
        accountPublicKey: toBase64(accountResult.publicKey),
        passwordWrappedPrivateKey: toBase64(accountResult.passwordWrappedPrivateKey),
        recoveryWrappedPrivateKey: toBase64(accountResult.recoveryWrappedPrivateKey),
      }),
      credentials: 'include',
    });

    if (!finishResponse.ok) {
      const body: unknown = await finishResponse.json();
      return { error: { message: parseErrorMessage(body) } };
    }

    return {};
  } catch {
    return { error: { message: friendlyErrorMessage('REGISTRATION_FAILED') } };
  } finally {
    // Cleanup sensitive material
    passwordBytes.fill(0);
  }
}

export const signUp = {
  email: signUpEmail,
};

// ---------------------------------------------------------------------------
// changePassword (OPAQUE protocol — password never touches server)
// ---------------------------------------------------------------------------

interface ChangePasswordResult {
  success: boolean;
  error?: string;
}

interface ResetPasswordViaRecoveryResult {
  success: boolean;
  error?: string;
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<ChangePasswordResult> {
  const currentPasswordBytes = new TextEncoder().encode(currentPassword);
  const newPasswordBytes = new TextEncoder().encode(newPassword);

  try {
    // 1. Start OPAQUE login with current password (to verify it)
    const loginClient = createOpaqueClient();
    const { ke1 } = await startLogin(loginClient, currentPassword);

    // 2. Start OPAQUE registration with new password
    const regClient = createOpaqueClient();
    const { serialized: newRegistrationRequest } = await startRegistration(regClient, newPassword);

    // 3. Send both to server in one round trip
    const initResponse = await fetch(`${getApiUrl()}/api/auth/change-password/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ke1, newRegistrationRequest }),
      credentials: 'include',
    });

    if (!initResponse.ok) {
      const body: unknown = await initResponse.json();
      return { success: false, error: parseErrorMessage(body) };
    }

    const { ke2, newRegistrationResponse } = (await initResponse.json()) as {
      ke2: number[];
      newRegistrationResponse: number[];
    };

    // 4. Finish OPAQUE login (proves current password, gives us KE3)
    const loginResult = await finishLogin(loginClient, ke2, globalThis.location.host);

    // 5. Finish OPAQUE registration (gives us new export key)
    const newRegResult = await finishRegistration(
      regClient,
      newRegistrationResponse,
      globalThis.location.host
    );

    // 6. Get account private key from store
    const { privateKey: accountPrivateKey } = useAuthStore.getState();
    if (!accountPrivateKey) {
      return { success: false, error: friendlyErrorMessage('ACCOUNT_KEY_NOT_AVAILABLE') };
    }

    // 7. Re-wrap account private key with new OPAQUE export key
    const newExportKey = new Uint8Array(newRegResult.exportKey);
    const newPasswordWrappedPrivateKey = rewrapAccountKeyForPasswordChange(
      accountPrivateKey,
      newExportKey
    );

    // 8. Send finish request with new registration record + new wrapped key
    const finishResponse = await fetch(`${getApiUrl()}/api/auth/change-password/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ke3: loginResult.ke3,
        newRegistrationRecord: newRegResult.record,
        newPasswordWrappedPrivateKey: toBase64(newPasswordWrappedPrivateKey),
      }),
      credentials: 'include',
    });

    if (!finishResponse.ok) {
      const body: unknown = await finishResponse.json();
      return { success: false, error: parseErrorMessage(body) };
    }

    // 9. Update local export key storage
    const storedAuth = getStoredAuth();
    if (storedAuth) {
      const keepSignedIn = localStorage.getItem(STORAGE_KEY) !== null;
      persistExportKey(newExportKey, storedAuth.userId, keepSignedIn);
    }

    return { success: true };
  } catch {
    return { success: false, error: friendlyErrorMessage('CHANGE_PASSWORD_FAILED') };
  } finally {
    currentPasswordBytes.fill(0);
    newPasswordBytes.fill(0);
  }
}

// ---------------------------------------------------------------------------
// resetPasswordViaRecovery
// ---------------------------------------------------------------------------

export async function resetPasswordViaRecovery(
  rawIdentifier: string,
  recoveryPhrase: string,
  newPassword: string
): Promise<ResetPasswordViaRecoveryResult> {
  const identifier = normalizeIdentifier(rawIdentifier);
  let accountPrivateKey: Uint8Array | null = null;
  let newPasswordBytes: Uint8Array | null = null;

  try {
    // 1. Request recovery wrapped key from server
    const getKeyResponse = await fetch(`${getApiUrl()}/api/auth/recovery/get-wrapped-key`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier }),
      credentials: 'include',
    });

    if (!getKeyResponse.ok) {
      const body: unknown = await getKeyResponse.json();
      return { success: false, error: parseErrorMessage(body) };
    }

    const { recoveryWrappedPrivateKey } = (await getKeyResponse.json()) as {
      recoveryWrappedPrivateKey: string;
    };

    // 2. Recover account private key from mnemonic
    accountPrivateKey = await recoverAccountFromMnemonic(
      recoveryPhrase,
      fromBase64(recoveryWrappedPrivateKey)
    );

    // 3. Start OPAQUE registration with new password
    const client = createOpaqueClient();
    const { serialized: newRegistrationRequest } = await startRegistration(client, newPassword);

    // 4. Send init request
    const initResponse = await fetch(`${getApiUrl()}/api/auth/recovery/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, newRegistrationRequest }),
      credentials: 'include',
    });

    if (!initResponse.ok) {
      const body: unknown = await initResponse.json();
      return { success: false, error: parseErrorMessage(body) };
    }

    const { newRegistrationResponse } = (await initResponse.json()) as {
      newRegistrationResponse: number[];
    };

    // 5. Finish OPAQUE registration — gives us new export key
    const { record, exportKey } = await finishRegistration(
      client,
      newRegistrationResponse,
      globalThis.location.host
    );

    // 6. Re-wrap account private key with new OPAQUE export key
    const newExportKey = new Uint8Array(exportKey);
    const newPasswordWrappedPrivateKey = rewrapAccountKeyForPasswordChange(
      accountPrivateKey,
      newExportKey
    );

    // 7. Send finish request
    newPasswordBytes = new TextEncoder().encode(newPassword);
    const finishResponse = await fetch(`${getApiUrl()}/api/auth/recovery/reset/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier,
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey: toBase64(newPasswordWrappedPrivateKey),
      }),
      credentials: 'include',
    });

    if (!finishResponse.ok) {
      const body: unknown = await finishResponse.json();
      return { success: false, error: parseErrorMessage(body) };
    }

    return { success: true };
  } catch {
    return {
      success: false,
      error: friendlyErrorMessage('CHANGE_PASSWORD_FAILED'),
    };
  } finally {
    if (accountPrivateKey) accountPrivateKey.fill(0);
    if (newPasswordBytes) newPasswordBytes.fill(0);
  }
}

// ---------------------------------------------------------------------------
// disable2FAInit (OPAQUE password re-auth for 2FA disable)
// ---------------------------------------------------------------------------

export async function disable2FAInit(
  password: string
): Promise<{ success: true; ke3: number[] } | { success: false; error: string }> {
  const passwordBytes = new TextEncoder().encode(password);
  try {
    const client = createOpaqueClient();
    const { ke1 } = await startLogin(client, password);

    const initResponse = await fetch(`${getApiUrl()}/api/auth/2fa/disable/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ke1 }),
      credentials: 'include',
    });
    if (!initResponse.ok) {
      const body: unknown = await initResponse.json();
      return { success: false, error: parseErrorMessage(body) };
    }
    const { ke2 } = (await initResponse.json()) as { ke2: number[] };

    const loginResult = await finishLogin(client, ke2, globalThis.location.host);
    return { success: true, ke3: loginResult.ke3 };
  } catch {
    return { success: false, error: friendlyErrorMessage('DISABLE_2FA_INIT_FAILED') };
  } finally {
    passwordBytes.fill(0);
  }
}

// ---------------------------------------------------------------------------
// disable2FAFinish (send ke3 + TOTP code to finalize 2FA disable)
// ---------------------------------------------------------------------------

export async function disable2FAFinish(
  ke3: number[],
  code: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await fetch(`${getApiUrl()}/api/auth/2fa/disable/finish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ke3, code }),
      credentials: 'include',
    });
    if (!response.ok) {
      const body: unknown = await response.json();
      return { success: false, error: parseErrorMessage(body) };
    }
    return { success: true };
  } catch {
    return { success: false, error: friendlyErrorMessage('2FA_VERIFICATION_FAILED') };
  }
}

// ---------------------------------------------------------------------------
// signOut
// ---------------------------------------------------------------------------

export async function signOutAndClearCache(): Promise<void> {
  await fetch(`${getApiUrl()}/api/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });
  clearStoredAuth();
  clearEpochKeyCache(); // zeros and clears all cached epoch keys
  useAuthStore.getState().clear(); // zeros privateKey, clears state
  queryClient.clear();
}

// ---------------------------------------------------------------------------
// authClient (backward-compatible object)
// ---------------------------------------------------------------------------

export const authClient = {
  getSession: async (): Promise<{ data: { user: UserData } | null }> => {
    await initAuth();
    const { user, isAuthenticated } = useAuthStore.getState();
    if (user && isAuthenticated) {
      return { data: { user } };
    }
    return { data: null };
  },

  verifyEmail: async (options: { query: { token: string } }): Promise<VerifyEmailResult> => {
    try {
      const response = await fetch(`${getApiUrl()}/api/auth/verify-email`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: options.query.token }),
        credentials: 'include',
      });

      if (!response.ok) {
        const body: unknown = await response.json();
        return { error: { message: parseErrorMessage(body) } };
      }

      return {};
    } catch {
      return { error: { message: friendlyErrorMessage('VERIFICATION_FAILED') } };
    }
  },
};

// ---------------------------------------------------------------------------
// initAuth (singleton — restores session from stored export key)
// ---------------------------------------------------------------------------

let initPromise: Promise<void> | null = null;

export function initAuth(): Promise<void> {
  initPromise ??= doInitAuth();
  return initPromise;
}

async function doInitAuth(): Promise<void> {
  useAuthStore.getState().setLoading(true);

  const storedAuth = getStoredAuth();
  if (!storedAuth) {
    useAuthStore.getState().setLoading(false);
    return;
  }

  try {
    const restored = await restoreSession();
    if (!restored) {
      // Session not restored (transient error or cleared auth).
      // Reset singleton so next initAuth() call retries.
      initPromise = null;
      useAuthStore.getState().setLoading(false);
      return;
    }

    useAuthStore.getState().setPrivateKey(restored.privateKey);
    useAuthStore.getState().setUser(restored.user);
  } catch {
    // restoreSession() handles clearing auth for definitive failures (401/403).
    // Don't clear here — transient errors should allow retry.
    initPromise = null;
  } finally {
    useAuthStore.getState().setLoading(false);
  }
}

// ---------------------------------------------------------------------------
// requireAuth (route guard)
// ---------------------------------------------------------------------------

export async function requireAuth(): Promise<{ user: UserData }> {
  const { user, isAuthenticated } = useAuthStore.getState();
  if (user && isAuthenticated) {
    return { user };
  }

  // Try restore
  await initAuth();

  const state = useAuthStore.getState();
  if (!state.user || !state.isAuthenticated) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is designed to be thrown
    throw redirect({ to: ROUTES.LOGIN });
  }

  return { user: state.user };
}

// Allow test resets
export function resetInitPromise(): void {
  initPromise = null;
}
