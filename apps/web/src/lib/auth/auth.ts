import { create } from 'zustand';
import { onlineManager } from '@tanstack/react-query';
import { redirect } from '@tanstack/react-router';
import { useShallow } from 'zustand/react/shallow';
import {
  asWrappingPrivateKey,
  createOpaqueClient,
  startRegistration,
  finishRegistration,
  startLogin,
  finishLogin,
  createAccount,
  unwrapAccountKeyWithPassword,
  rewrapAccountKeyForPasswordChange,
  recoverAccountFromMnemonic,
  decryptCustomInstructions,
  deriveResetProof,
  openResetChallenge,
  validatePhrase,
  OPAQUE_SERVER_IDENTIFIER,
} from '@hushbox/crypto';
import {
  canonicalIdentifier,
  normalizeIdentifier,
  normalizeUsername,
  fromBase64,
  toBase64,
  ROUTES,
  ERROR_CODES,
  asErrorCode,
  friendlyErrorMessage,
  rateLimitedMessage,
  retryAfterSecondsOf,
  TERMS_OF_SERVICE_REVISION,
} from '@hushbox/shared';

import { getPlatform } from '@/capacitor/platform';
import { queryClient, registerSessionRevocationClearer } from '@/providers/query-provider';
import { client as apiClient } from '@/lib/api-client';
import { notificationChannel } from '@/lib/notification-channel';
import { clearEpochKeyCache } from '@/lib/crypto/epoch-key-cache';
import { clearDecryptedMessageCache } from '@/lib/crypto/decrypted-message-cache';
import { useModelStore } from '@/stores/model';
import { useDocumentStore } from '@/stores/document';
import {
  persistExportKey,
  getStoredAuth,
  hasStoredAuth,
  clearAuthMarkers,
  clearStoredAuth,
  purgeDeviceKeyQuietly,
  restoreSession,
} from './client.js';
import { instructionsQueryOptions, meQueryOptions } from './queries.js';
import { beginPasswordStepUp } from './password-step-up.js';
import { getLinkGuestAuth } from './link-guest-auth.js';
import {
  normalizeRecoveryPhrase,
  RECOVERY_PHRASE_INVALID_MESSAGE,
  RECOVERY_PHRASE_MISMATCH_MESSAGE,
} from './validation.js';
import type { AcquisitionPlatform } from '@hushbox/shared';
import type { WrappingPrivateKey } from '@hushbox/crypto';
import type { InferResponseType } from 'hono/client';

function extractErrorCode(body: unknown): string | undefined {
  if (body && typeof body === 'object' && 'code' in body) {
    const code = (body as { code: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

const RATE_LIMIT_CODES: ReadonlySet<string> = new Set([
  ERROR_CODES.RATE_LIMITED,
  ERROR_CODES.TOO_MANY_ATTEMPTS,
]);

export function parseErrorMessage(body: unknown): string {
  const code = extractErrorCode(body);
  if (!code) return friendlyErrorMessage('INTERNAL');
  if (RATE_LIMIT_CODES.has(code)) {
    const details =
      typeof body === 'object' && body !== null && 'details' in body ? body.details : undefined;
    return rateLimitedMessage(retryAfterSecondsOf(details));
  }
  return friendlyErrorMessage(asErrorCode(code));
}

async function handleErrorResponse(response: Response): Promise<{ success: false; error: string }> {
  const body: unknown = await response.json();
  return { success: false, error: parseErrorMessage(body) };
}

interface UserData {
  id: string;
  email: string;
  username: string;
  emailVerified: boolean;
  totpEnabled: boolean;
  hasAcknowledgedPhrase: boolean;
}

/**
 * What the store knows about the account's stored instruction: `pending` —
 * nothing has settled it, so the value says nothing about the account;
 * `absent` — a landed read or the user's own save settled it and this account
 * stores none; `present` — it settled and `customInstructions` holds it.
 *
 * `customInstructions` is `null` under both `pending` and `absent`, so the
 * value alone cannot say whether the account stores none. Reading that null as
 * "none stored" drops the instruction from every turn and lets an editor seeded
 * from the value save over what is stored; this status is what makes the two
 * tellable apart. A surface that reads the value without asking the status
 * still takes that null as "none stored".
 */
type CustomInstructionsStatus = 'pending' | 'absent' | 'present';

interface AuthState {
  user: UserData | null;
  privateKey: Uint8Array | null;
  customInstructions: string | null;
  customInstructionsStatus: CustomInstructionsStatus;
  isLoading: boolean;
  isAuthenticated: boolean;
  setUser: (user: UserData | null) => void;
  setPrivateKey: (key: Uint8Array) => void;
  setCustomInstructions: (instructions: string | null) => void;
  settleInstructionsRead: (userId: string, instructions: string | null) => void;
  setLoading: (isLoading: boolean) => void;
  clear: () => void;
}

function statusFor(instructions: string | null): CustomInstructionsStatus {
  return instructions === null ? 'absent' : 'present';
}

/**
 * Whether the store holds an account whose stored instruction nothing has
 * settled yet — the one predicate every surface that must not act on
 * {@link AuthState.customInstructions} shares, so no two of them can come apart
 * over the ambiguity {@link CustomInstructionsStatus} exists to resolve.
 *
 * The account conjunct exempts a principal for whom no read is ever issued — a
 * signed-out visitor, a link guest — from the `pending` this store starts at
 * and nothing will move for them; read without it, their composer is held for
 * the life of the document. It exempts by the ABSENCE of an account, so a
 * session seeded with a user and no read is not exempt and settles the status
 * itself: `apps/web/src/demo/seed-session.ts` is such a seed.
 */
export function selectInstructionsReadUnresolved(state: AuthState): boolean {
  return state.user !== null && state.customInstructionsStatus === 'pending';
}

interface SignInEmailResult {
  error?: { message: string; code?: string };
  requires2FA?: boolean;
  verifyTOTP?: (code: string) => Promise<{ success: boolean; error?: string }>;
}

interface SignUpEmailResult {
  error?: { message: string };
}

// SECURITY: No persist middleware. Private key must only exist in memory.
// Persisting would leak encryption keys to localStorage/sessionStorage.
export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  privateKey: null,
  customInstructions: null,
  customInstructionsStatus: 'pending',
  isLoading: true,
  isAuthenticated: false,
  setUser: (user) => {
    set({ user, isAuthenticated: !!user });
  },
  setPrivateKey: (key) => {
    set({ privateKey: key });
  },
  setCustomInstructions: (instructions) => {
    set({ customInstructions: instructions, customInstructionsStatus: statusFor(instructions) });
  },
  // The read resolves beside the session it belongs to, so it can answer after
  // the store has moved on: to another account (a session switch with no
  // document reload), to a signed-out state, or to an instruction the user
  // saved while it was open. It settles only a store that still holds the
  // account the read was issued for, with that read still outstanding.
  //
  // The `pending` conjunct is correct only for a store `clear()` has reset
  // between accounts: over a store still holding the previous account's
  // settled instruction it would decline the new account's read, leaving that
  // plaintext in place to ride the new account's turns.
  settleInstructionsRead: (userId, instructions) => {
    set((state) =>
      state.user?.id === userId && state.customInstructionsStatus === 'pending'
        ? { customInstructions: instructions, customInstructionsStatus: statusFor(instructions) }
        : state
    );
  },
  setLoading: (isLoading) => {
    set({ isLoading });
  },
  clear: () => {
    const { privateKey } = get();
    if (privateKey) privateKey.fill(0);
    set({
      user: null,
      privateKey: null,
      customInstructions: null,
      customInstructionsStatus: 'pending',
      isAuthenticated: false,
      isLoading: false,
    });
  },
}));

interface SessionHookResult {
  data: { user: UserData; session: { id: string } } | null;
  isPending: boolean;
}

export function useSession(): SessionHookResult {
  const { user, isLoading } = useAuthStore(
    useShallow((s) => ({ user: s.user, isLoading: s.isLoading }))
  );

  // When viewing a shared conversation via link guest auth, mask the session
  // so the user appears as an unauthenticated guest. This prevents balance
  // queries (which fail with credentials: 'omit') and ensures the share page
  // shows read-only notification instead of trial notice.
  if (getLinkGuestAuth()) {
    return { data: null, isPending: false };
  }

  return {
    data: user ? { user, session: { id: user.id } } : null,
    isPending: isLoading,
  };
}

async function finalizeLoginWithKey(
  exportKey: Uint8Array,
  wrappedPrivateKey: Uint8Array,
  userId: string,
  keepSignedIn: boolean
): Promise<void> {
  const accountPrivateKey = unwrapAccountKeyWithPassword(exportKey, wrappedPrivateKey);
  await persistExportKey(exportKey, userId, keepSignedIn);
  useAuthStore.getState().setPrivateKey(accountPrivateKey);

  // Routed through the query client so /me inherits the app-wide retry policy.
  // Throws on any non-2xx /me response once retries are exhausted. The caller
  // treats that as a failed login rather than synthesizing account flags: a
  // transient /me failure must never downgrade a verified user's
  // emailVerified/totpEnabled/hasAcknowledgedPhrase to false.
  const meData = await queryClient.fetchQuery(meQueryOptions());
  useAuthStore.getState().setUser(meData.user);
  startCustomInstructionsRead(accountPrivateKey, meData.user.id);
}

function createTOTPVerifier(
  exportKey: Uint8Array,
  keepSignedIn: boolean
): (code: string) => Promise<{ success: boolean; error?: string }> {
  return async (code: string): Promise<{ success: boolean; error?: string }> => {
    let verifyResponse: InferResponseType<
      (typeof apiClient.auth.login)['2fa']['verify']['$post'],
      200
    >;

    try {
      const response = await apiClient.auth.login['2fa'].verify.$post({ json: { code } });

      if (!response.ok) {
        const body: unknown = await response.json();
        return { success: false, error: parseErrorMessage(body) };
      }

      verifyResponse = await response.json();
    } catch {
      return { success: false, error: friendlyErrorMessage('TWO_FACTOR_VERIFICATION_FAILED') };
    }

    // The server has accepted the code and the session is live, so nothing that
    // fails from here on is the code's fault. Finalization is retried rather
    // than reported, because sending the user back to the code prompt spends
    // another server-side two-factor attempt on a step that already succeeded.
    const MAX_FINALIZE_ATTEMPTS = 2;
    let finalized = false;

    for (let attempt = 0; attempt < MAX_FINALIZE_ATTEMPTS && !finalized; attempt += 1) {
      try {
        await finalizeLoginWithKey(
          exportKey,
          fromBase64(verifyResponse.passwordWrappedPrivateKey),
          verifyResponse.userId,
          keepSignedIn
        );
        finalized = true;
      } catch {
        // Retried by the loop; when no attempt succeeds, `finalized` stays false and the
        // sign-in-completion error is what the caller gets.
      }
    }

    if (!finalized) {
      return { success: false, error: friendlyErrorMessage('SIGN_IN_COMPLETION_FAILED') };
    }

    return { success: true };
  };
}

function buildLoginError(body: unknown): { error: { message: string; code?: string } } {
  const code = extractErrorCode(body);
  return { error: { message: parseErrorMessage(body), ...(code && { code }) } };
}

async function signInEmail(options: {
  identifier: string;
  password: string;
  keepSignedIn?: boolean;
}): Promise<SignInEmailResult> {
  const { identifier: rawIdentifier, password, keepSignedIn = false } = options;
  const identifier = normalizeIdentifier(rawIdentifier);

  try {
    const client = createOpaqueClient();
    const { ke1 } = await startLogin(client, password);

    const initResponse = await apiClient.auth.login.init.$post({ json: { identifier, ke1 } });

    if (!initResponse.ok) {
      return buildLoginError(await initResponse.json());
    }

    const { ke2, loginSessionId } = await initResponse.json();

    const loginResult = await finishLogin(client, ke2, OPAQUE_SERVER_IDENTIFIER);
    const exportKey = new Uint8Array(loginResult.exportKey);

    const finishResponse = await apiClient.auth.login.finish.$post({
      json: { identifier, ke3: loginResult.ke3, loginSessionId },
    });

    if (!finishResponse.ok) {
      return buildLoginError(await finishResponse.json());
    }

    const finishData = await finishResponse.json();

    if ('requires2FA' in finishData) {
      return {
        requires2FA: true,
        verifyTOTP: createTOTPVerifier(exportKey, keepSignedIn),
      };
    }

    if (!finishData.passwordWrappedPrivateKey) {
      return { error: { message: friendlyErrorMessage('ENCRYPTION_NOT_SETUP') } };
    }

    await finalizeLoginWithKey(
      exportKey,
      fromBase64(finishData.passwordWrappedPrivateKey),
      finishData.userId,
      keepSignedIn
    );

    return {};
  } catch {
    return { error: { message: friendlyErrorMessage('LOGIN_FAILED') } };
  }
}

export const signIn = {
  email: signInEmail,
};

/**
 * The build target as the account's platform column spells it. `android-direct`
 * is a distribution channel rather than a platform, so it records as `android`
 * — the same collapse the device-token registration makes for its own narrower
 * contract.
 */
function acquisitionPlatform(): AcquisitionPlatform {
  const platform = getPlatform();
  if (platform === 'ios') return 'ios';
  return platform === 'web' ? 'web' : 'android';
}

async function signUpEmail(options: {
  username: string;
  email: string;
  password: string;
  /** The campaign tag the signup link carried, read off the address bar and nowhere else. */
  campaign?: string | undefined;
}): Promise<SignUpEmailResult> {
  const { username, email, password, campaign } = options;
  const normalizedUsername = normalizeUsername(username);

  try {
    const client = createOpaqueClient();
    const { serialized } = await startRegistration(client, password);

    const initResponse = await apiClient.auth.register.init.$post({
      json: {
        email,
        username: normalizedUsername,
        registrationRequest: serialized,
        ...(campaign === undefined ? {} : { c: campaign }),
      },
    });

    if (!initResponse.ok) {
      const body: unknown = await initResponse.json();
      return { error: { message: parseErrorMessage(body) } };
    }

    const { registrationResponse, registerSessionId } = await initResponse.json();

    const { record, exportKey } = await finishRegistration(
      client,
      registrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );

    const opaqueExportKey = new Uint8Array(exportKey);
    const accountResult = await createAccount(opaqueExportKey);

    const finishResponse = await apiClient.auth.register.finish.$post({
      json: {
        email,
        registrationRecord: record,
        accountPublicKey: toBase64(accountResult.publicKey),
        passwordWrappedPrivateKey: toBase64(accountResult.passwordWrappedPrivateKey),
        recoveryWrappedPrivateKey: toBase64(accountResult.recoveryWrappedPrivateKey),
        recoveryPublicKey: toBase64(accountResult.recoveryPublicKey),
        registerSessionId,
        acquisition: {
          ...(campaign === undefined ? {} : { campaign }),
          platform: acquisitionPlatform(),
        },
        acceptedTermsRevision: TERMS_OF_SERVICE_REVISION,
      },
    });

    if (!finishResponse.ok) {
      const body: unknown = await finishResponse.json();
      return { error: { message: parseErrorMessage(body) } };
    }

    return {};
  } catch {
    return { error: { message: friendlyErrorMessage('REGISTRATION_FAILED') } };
  }
}

export const signUp = {
  email: signUpEmail,
};

interface ChangePasswordResult {
  success: boolean;
  error?: string;
}

export interface ResetPasswordViaRecoveryResult {
  success: boolean;
  error?: string;
}

export async function changePassword(
  currentPassword: string,
  newPassword: string
): Promise<ChangePasswordResult> {
  try {
    const stepUp = await beginPasswordStepUp(currentPassword);

    const regClient = createOpaqueClient();
    const { serialized: newRegistrationRequest } = await startRegistration(regClient, newPassword);

    const initResponse = await apiClient.auth['change-password'].init.$post({
      json: { ke1: stepUp.ke1, newRegistrationRequest },
    });

    if (!initResponse.ok) {
      return await handleErrorResponse(initResponse);
    }

    const { ke2, newRegistrationResponse, changePasswordSessionId } = await initResponse.json();

    const ke3 = await stepUp.finish(ke2);

    const newRegResult = await finishRegistration(
      regClient,
      newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );

    const { privateKey: accountPrivateKey } = useAuthStore.getState();
    if (!accountPrivateKey) {
      return { success: false, error: friendlyErrorMessage('ACCOUNT_KEY_NOT_AVAILABLE') };
    }

    const newExportKey = new Uint8Array(newRegResult.exportKey);
    const newPasswordWrappedPrivateKey = rewrapAccountKeyForPasswordChange(
      accountPrivateKey,
      newExportKey
    );

    const finishResponse = await apiClient.auth['change-password'].finish.$post({
      json: {
        ke3,
        newRegistrationRecord: newRegResult.record,
        newPasswordWrappedPrivateKey: toBase64(newPasswordWrappedPrivateKey),
        changePasswordSessionId,
      },
    });

    if (!finishResponse.ok) {
      return await handleErrorResponse(finishResponse);
    }

    const storedAuth = getStoredAuth();
    if (storedAuth) {
      try {
        await persistExportKey(newExportKey, storedAuth.userId, storedAuth.keepSignedIn);
      } catch {
        // The server committed the new password before this write. Falling into
        // the outer catch would tell the user the change did not happen, and
        // they would keep using a password the server no longer accepts.
        return { success: false, error: friendlyErrorMessage('CREDENTIAL_UPDATED_KEY_NOT_SAVED') };
      }
    }

    return { success: true };
  } catch {
    return { success: false, error: friendlyErrorMessage('CREDENTIAL_UPDATE_FAILED') };
  }
}

export interface VerifiedRecoveryPhrase {
  /** Identifier in the form every later request carries, so the two cannot drift. */
  readonly identifier: string;
  readonly accountPrivateKey: Uint8Array;
  readonly recoveryPrivateKey: WrappingPrivateKey;
}

type VerifyRecoveryPhraseResult =
  | { success: true; verified: VerifiedRecoveryPhrase }
  | { success: false; error: string };

/**
 * Proves the phrase belongs to the account before the user picks a password:
 * the BIP-39 checksum locally, then an actual decrypt of the account's recovery
 * blob. The keys it recovers are handed to `resetPasswordViaRecovery`, which is
 * why the 64 MiB Argon2id behind them runs once per attempt rather than twice.
 */
export async function verifyRecoveryPhrase(
  rawIdentifier: string,
  recoveryPhrase: string
): Promise<VerifyRecoveryPhraseResult> {
  const identifier = normalizeIdentifier(rawIdentifier);
  const phrase = normalizeRecoveryPhrase(recoveryPhrase);

  if (!validatePhrase(phrase)) {
    return { success: false, error: RECOVERY_PHRASE_INVALID_MESSAGE };
  }

  let recoveryWrappedPrivateKey: Uint8Array;
  try {
    const getKeyResponse = await apiClient.auth.recovery['get-wrapped-key'].$post({
      json: { identifier },
    });

    if (!getKeyResponse.ok) {
      return await handleErrorResponse(getKeyResponse);
    }

    const body = await getKeyResponse.json();
    recoveryWrappedPrivateKey = fromBase64(body.recoveryWrappedPrivateKey);
  } catch {
    return { success: false, error: friendlyErrorMessage('INTERNAL') };
  }

  try {
    const recovered = await recoverAccountFromMnemonic(phrase, recoveryWrappedPrivateKey);
    return { success: true, verified: { identifier, ...recovered } };
  } catch {
    // An unknown identifier is answered with a same-shaped dummy blob, so it
    // fails this decrypt exactly as a wrong phrase does. One message for both
    // is what keeps the two indistinguishable to the person typing.
    return { success: false, error: RECOVERY_PHRASE_MISMATCH_MESSAGE };
  }
}

/**
 * Zeroes the key material a verification produced. Called when the user leaves
 * the reset flow; a failed reset deliberately keeps it, because the retry is
 * one button away and re-deriving would cost another Argon2id.
 */
export function discardVerifiedRecoveryPhrase(verified: VerifiedRecoveryPhrase): void {
  verified.accountPrivateKey.fill(0);
  verified.recoveryPrivateKey.fill(0);
}

export async function resetPasswordViaRecovery(
  verified: VerifiedRecoveryPhrase,
  newPassword: string
): Promise<ResetPasswordViaRecoveryResult> {
  const { identifier } = verified;
  // Copied before the first await, and read only through these copies. The handle
  // outlives this call and `discardVerifiedRecoveryPhrase` can zero it from another
  // path mid-flight; wrapping the zeroed buffer would store 32 zero bytes as the
  // account key, which the server accepts and which no later login can detect.
  const accountPrivateKey = new Uint8Array(verified.accountPrivateKey);
  const recoveryPrivateKey = asWrappingPrivateKey(new Uint8Array(verified.recoveryPrivateKey));

  try {
    const client = createOpaqueClient();
    const { serialized: newRegistrationRequest } = await startRegistration(client, newPassword);

    const initResponse = await apiClient.auth.recovery.reset.init.$post({
      json: { identifier, newRegistrationRequest },
    });

    if (!initResponse.ok) {
      return await handleErrorResponse(initResponse);
    }

    const { newRegistrationResponse, recoverySessionId, sealedChallenge } =
      await initResponse.json();

    // The phrase gate: only the private half derived from the phrase opens the
    // challenge, and the proof commits to this exact request, so a captured one
    // cannot authorize a rewritten reset.
    const challengeNonce = openResetChallenge(recoveryPrivateKey, fromBase64(sealedChallenge));

    const { record, exportKey } = await finishRegistration(
      client,
      newRegistrationResponse,
      OPAQUE_SERVER_IDENTIFIER
    );

    const newExportKey = new Uint8Array(exportKey);
    const newPasswordWrappedPrivateKey = toBase64(
      rewrapAccountKeyForPasswordChange(accountPrivateKey, newExportKey)
    );

    const resetProof = deriveResetProof(challengeNonce, {
      recoverySessionId,
      canonicalIdentifier: canonicalIdentifier(identifier),
      newRegistrationRecord: Uint8Array.from(record),
      newPasswordWrappedPrivateKey,
    });

    const finishResponse = await apiClient.auth.recovery.reset.finish.$post({
      json: {
        identifier,
        newRegistrationRecord: record,
        newPasswordWrappedPrivateKey,
        recoverySessionId,
        resetProof: toBase64(resetProof),
      },
    });

    if (!finishResponse.ok) {
      return await handleErrorResponse(finishResponse);
    }

    // The handle is zeroed on success only, never in the `finally` below: a
    // failed reset is retried with the same verification, and a zeroed handle
    // would rewrap zeros.
    discardVerifiedRecoveryPhrase(verified);
    return { success: true };
  } catch {
    return {
      success: false,
      error: friendlyErrorMessage('CREDENTIAL_UPDATE_FAILED'),
    };
  } finally {
    accountPrivateKey.fill(0);
    recoveryPrivateKey.fill(0);
  }
}

export async function disable2FAInit(
  password: string
): Promise<
  { success: true; ke3: number[]; disable2FASessionId: string } | { success: false; error: string }
> {
  try {
    const stepUp = await beginPasswordStepUp(password);

    const initResponse = await apiClient.auth['2fa'].disable.init.$post({
      json: { ke1: stepUp.ke1 },
    });
    if (!initResponse.ok) {
      const body: unknown = await initResponse.json();
      return { success: false, error: parseErrorMessage(body) };
    }
    const { ke2, disable2FASessionId } = await initResponse.json();

    const ke3 = await stepUp.finish(ke2);
    return { success: true, ke3, disable2FASessionId };
  } catch {
    return { success: false, error: friendlyErrorMessage('DISABLE_2FA_INIT_FAILED') };
  }
}

export async function disable2FAFinish(
  ke3: number[],
  code: string,
  disable2FASessionId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const response = await apiClient.auth['2fa'].disable.finish.$post({
      json: { ke3, code, disable2FASessionId },
    });
    if (!response.ok) {
      const body: unknown = await response.json();
      return { success: false, error: parseErrorMessage(body) };
    }
    return { success: true };
  } catch {
    return { success: false, error: friendlyErrorMessage('TWO_FACTOR_VERIFICATION_FAILED') };
  }
}

interface RecoveryMaterialBlobs {
  readonly recoveryWrappedPrivateKey: string;
  readonly recoveryPublicKey: string;
}

/**
 * Saves a regenerated recovery keypair behind an OPAQUE password step-up. Both
 * round trips fire on one submit so the server-side handshake is never held open
 * across the user's thinking time, and the material rides the finish call
 * because that is the call the proof gates.
 */
export async function saveRecoveryMaterial(
  password: string,
  material: RecoveryMaterialBlobs
): Promise<{ success: boolean; error?: string }> {
  try {
    const stepUp = await beginPasswordStepUp(password);

    const initResponse = await apiClient.auth.recovery.save.init.$post({
      json: { ke1: stepUp.ke1 },
    });
    if (!initResponse.ok) {
      return await handleErrorResponse(initResponse);
    }
    const { ke2, recoverySaveSessionId } = await initResponse.json();

    // OPAQUE is constant-time: `/init` answers every password identically, so a
    // wrong one fails here, in our own MAC check, and never on the wire.
    let ke3: number[];
    try {
      ke3 = await stepUp.finish(ke2);
    } catch {
      return { success: false, error: friendlyErrorMessage('INCORRECT_PASSWORD') };
    }

    const finishResponse = await apiClient.auth.recovery.save.finish.$post({
      json: {
        ke3,
        recoverySaveSessionId,
        recoveryWrappedPrivateKey: material.recoveryWrappedPrivateKey,
        recoveryPublicKey: material.recoveryPublicKey,
      },
    });
    if (!finishResponse.ok) {
      return await handleErrorResponse(finishResponse);
    }
    return { success: true };
  } catch {
    return { success: false, error: friendlyErrorMessage('RECOVERY_MATERIAL_SAVE_FAILED') };
  }
}

/**
 * What follows a local sign-out, which decides how it ends. `'reload'` reloads
 * the page itself; `'navigate-away'` means the caller has already started a
 * full-document navigation; `'switch-user'` means the caller signs in again in
 * this same context.
 */
type SignOutNext = 'reload' | 'navigate-away' | 'switch-user';

// Local-only side of sign-out — used after server-side destruction has already
// happened (e.g. account deletion's 204 response).
export async function clearLocalAuthState({
  next = 'reload',
}: { next?: SignOutNext } = {}): Promise<void> {
  // Until the page is replaced, a still-mounted query observer would refetch
  // what this sign-out empties, with the session cookie already gone. Offline,
  // a read that checks TanStack Query's online state before each request makes
  // none: the default `'online'` network mode checks before a fetch starts and
  // before each retry, and a read that requests page after page within one
  // fetch checks before each page. Only a switch-user sign-out stays online,
  // because its login runs next in this same context.
  if (next !== 'switch-user') onlineManager.setOnline(false);
  // Awaited, not fired: `globalThis.location.reload()` tears the JS context
  // down, and an in-flight IndexedDB delete dies with it, leaving the wrapped
  // device key on disk after sign-out.
  await clearStoredAuth();
  clearEpochKeyCache();
  useAuthStore.getState().clear();
  // Force text modality active so the trial page never lands on a non-text
  // modality (which would disable every icon for trial users).
  useModelStore.getState().resetForUnauthenticated();
  // Drop decrypted document content from memory so it can't outlive the session.
  useDocumentStore.getState().closePanel();
  // Drop every viewed message's decrypted plaintext held at module scope.
  clearDecryptedMessageCache();
  queryClient.clear();
  initPromise = null;
  // A full reload is the only way to GUARANTEE no decrypted plaintext lingers
  // in module-level memory after sign-out. Logout is rare enough to afford it.
  // A navigation the caller started drops that memory the same way, and the
  // switch-user flows (dev persona picker) re-authenticate as another principal
  // in the same context, where a reload would tear the JS context down before
  // their login runs.
  if (next === 'reload') globalThis.location.reload();
}

export async function signOutAndClearCache({
  next = 'reload',
}: { next?: SignOutNext } = {}): Promise<void> {
  // Before the session goes: dropping the server row needs the cookie that is
  // about to be revoked. Best-effort — a device that stays registered is pruned
  // reactively on the next send, and sign-out must not depend on push.
  await notificationChannel.unregister().catch(() => {
    // Nothing to recover; the server prunes on the next delivery failure.
  });
  await apiClient.auth.logout.$post();
  await clearLocalAuthState({ next });
}

async function runSimpleAuthPost(
  request: Promise<Response>
): Promise<{ error?: { message: string } }> {
  try {
    const response = await request;
    if (!response.ok) {
      const responseBody: unknown = await response.json();
      return { error: { message: parseErrorMessage(responseBody) } };
    }
    return {};
  } catch {
    return { error: { message: friendlyErrorMessage('INTERNAL') } };
  }
}

export const authClient = {
  getSession: async (): Promise<{ data: { user: UserData } | null }> => {
    await initAuth();
    const { user, isAuthenticated } = useAuthStore.getState();
    if (user && isAuthenticated) {
      return { data: { user } };
    }
    return { data: null };
  },

  tokenLogin: (options: { token: string }): Promise<{ error?: { message: string } }> =>
    runSimpleAuthPost(apiClient.auth['token-login'].$post({ json: { token: options.token } })),

  resendVerification: (options: { email: string }): Promise<{ error?: { message: string } }> =>
    runSimpleAuthPost(
      apiClient.auth['verify-email'].resend.$post({ json: { email: options.email } })
    ),
};

/**
 * Starts the account's instruction read beside the session it belongs to and
 * returns at once: no bootstrap and no route guard waits on it, so a read that
 * never answers cannot hold an authenticated user on the login screen with no
 * error, or blank a chat page that has already rendered.
 *
 * The blob is encrypted to the account key, so the server never reads it and
 * every chat turn carries the plaintext the client decrypted here. Nothing in
 * this call's ordering tells an unanswered read apart from an account that
 * stores none; the store's {@link CustomInstructionsStatus} is what carries
 * that distinction, and only a landed read or the user's own save moves it off
 * `pending`; after either, a `null` value means the account stores none.
 */
function startCustomInstructionsRead(privateKey: Uint8Array, userId: string): void {
  // Returns void rather than the promise: a caller that could await it could
  // put this read back on the path a session and a navigation wait for.
  void readStoredCustomInstructions(privateKey, userId);
}

async function readStoredCustomInstructions(privateKey: Uint8Array, userId: string): Promise<void> {
  try {
    const { instructions } = await queryClient.fetchQuery(instructionsQueryOptions());
    useAuthStore
      .getState()
      .settleInstructionsRead(userId, readCustomInstructions(privateKey, userId, instructions));
  } catch (error) {
    // Handled by leaving the status `pending`: a request that failed and a blob
    // that would not open both leave the read with no answer to trust, and the
    // session it belongs to stands either way.
    console.error('Custom instructions read failed (the session continues):', error);
  }
}

function readCustomInstructions(
  privateKey: Uint8Array,
  userId: string,
  encryptedBase64: string | null
): string | null {
  if (!encryptedBase64) return null;
  // A blob that will not open throws to the caller rather than reading as
  // `null`: the account does store an instruction, and settling that to
  // `absent` would license an editor seeded from the value to save over the one
  // copy of a blob only this account's key can open.
  return decryptCustomInstructions(privateKey, fromBase64(encryptedBase64), userId);
}

let initPromise: Promise<void> | null = null;

export function initAuth(): Promise<void> {
  initPromise ??= doInitAuth();
  return initPromise;
}

async function doInitAuth(): Promise<void> {
  useAuthStore.getState().setLoading(true);

  try {
    // Read storage inside the try so a malformed/legacy blob settles to
    // logged-out instead of bricking boot with a stuck spinner and a poisoned
    // cached initPromise.
    const storedAuth = getStoredAuth();
    if (!storedAuth) {
      // A closed session tab leaves its device key + ciphertext in IndexedDB with
      // no marker — the browser clears only the sessionStorage marker on tab close.
      // This no-marker branch is where session mode actually purges them, on the
      // next app load.
      await clearStoredAuth();
      return;
    }

    const restored = await restoreSession();
    if (!restored) {
      // Reset singleton so next initAuth() call retries.
      initPromise = null;
      useAuthStore.getState().setLoading(false);
      return;
    }

    useAuthStore.getState().setPrivateKey(restored.privateKey);
    useAuthStore.getState().setUser(restored.user);
    startCustomInstructionsRead(restored.privateKey, restored.user.id);
  } catch {
    // restoreSession() handles clearing auth for definitive failures (401/403);
    // transient errors should allow retry.
    initPromise = null;
  } finally {
    useAuthStore.getState().setLoading(false);
  }
}

export async function requireAuth(): Promise<{ user: UserData }> {
  const { user, isAuthenticated } = useAuthStore.getState();
  if (user && isAuthenticated) {
    return { user };
  }

  await initAuth();

  const state = useAuthStore.getState();
  if (!state.user || !state.isAuthenticated) {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- TanStack Router redirect is designed to be thrown
    throw redirect({ to: ROUTES.LOGIN });
  }

  return { user: state.user };
}

export function resetInitPromise(): void {
  initPromise = null;
}

// Wire the global mid-session-revocation handler. The query/mutation caches call
// this on any error; it acts only when a live session exists — an in-memory
// authenticated store or a stored-auth marker (the bootstrap window before the
// store is hydrated). An expected OPAQUE login-challenge 401 fires before any
// session exists, so this reports false and the caller neither clears nor
// redirects. Returns true iff a session was present and has been cleared.
registerSessionRevocationClearer((): boolean => {
  const isSessionLive = useAuthStore.getState().isAuthenticated || hasStoredAuth();
  if (!isSessionLive) {
    return false;
  }
  // The markers go synchronously; the device-key purge is floated, because this
  // registration contract has no await to give it. Floating is correct here and
  // a defect on the sign-out path, where an await exists: there, an unawaited
  // delete races a reload that can abort it for good, while here the redirect
  // aborting it costs nothing — doInitAuth's no-marker branch awaits the same
  // purge on the next load regardless. Started early because it usually wins.
  clearAuthMarkers();
  void purgeDeviceKeyQuietly();
  useAuthStore.getState().clear();
  return true;
});
