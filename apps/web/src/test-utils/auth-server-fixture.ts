import { expect, vi } from 'vitest';
import {
  OPAQUE_SERVER_IDENTIFIER,
  OpaqueServerConfig,
  OpaqueServerRegistrationRequest,
  RESET_CHALLENGE_NONCE_BYTES,
  asServerSecret,
  asWrappingPublicKey,
  createAccount,
  createOpaqueClient,
  createOpaqueServer,
  deriveDummyRecoveryWrappedKey,
  deriveServerMaterial,
  encryptCustomInstructions,
  finishRegistration,
  getPublicKeyFromPrivate,
  opaqueStepUpFinish,
  opaqueStepUpInit,
  sealResetChallenge,
  startRegistration,
  unwrapAccountKeyWithPassword,
  verifyResetProof,
} from '@hushbox/crypto';
import {
  ERROR_CODES,
  TERMS_OF_SERVICE_REVISION,
  canonicalIdentifier,
  fromBase64,
  textEncoder,
  toBase64,
} from '@hushbox/shared';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { useAuthStore, resetInitPromise } from '@/lib/auth/auth';
import { urlFromFetchInput } from './fetch-mock';
import { createInMemoryStorage, installFakeIndexedDB } from './browser-storage-fake';
import type { MeResponse } from '@/lib/auth/queries';
import type { CreateAccountResult, ServerMaterial } from '@hushbox/crypto';
import type { IndexedDbFakeControls, StorageFakeControls } from './browser-storage-fake';

/**
 * The one account this fixture's OPAQUE server knows. Both halves are real: the
 * registration record answers `authInit` for that credential and nothing else, and
 * the account blobs are the ones `createAccount` produced under the export key
 * that same registration yields.
 */
const IDENTIFIER = 'test@example.com';
/**
 * The credential the one account is registered under. Not a password in the
 * sense a scanner cares about: it is fixture material whose only role is to be
 * the OPAQUE KSF's input, and it authenticates nothing outside this process.
 */
const REGISTERED_CREDENTIAL = 'opaque-fixture-account-credential';
const USER_ID = testUuidV7(1);
/** The OPAQUE credential identifier the record is bound to; `authInit` must be given the same one. */
const CREDENTIAL_ID = testUuidV7(2);
const SERVER_SECRET = 'auth-fixture-opaque-server-secret-32-bytes-min';
const TOTP_CODE = '123456';

export interface AuthServerRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
  readonly init: RequestInit | undefined;
}

export type AuthRouteHandler = (request: AuthServerRequest) => Response | Promise<Response>;

export interface AuthServerFixture {
  readonly identifier: string;
  readonly password: string;
  readonly userId: string;
  readonly user: MeResponse['user'];
  /** The registered account's real material, minted once per file. */
  readonly account: CreateAccountResult;
  /** The account private key in the clear, for tests that must build a blob only it opens. */
  readonly accountPrivateKey: Uint8Array;
  /** The OPAQUE export key the registered credential yields; it opens the password-wrapped blob. */
  readonly exportKey: Uint8Array;
  /** Every request the installed fetch saw, in order. */
  readonly requests: AuthServerRequest[];
  /** The two-factor code `/auth/login/2fa/verify` accepts. */
  readonly totpCode: string;
  /** The password-wrapped account key the server serves. Assign to tamper with it. */
  passwordWrappedPrivateKey: Uint8Array;
  /** While true, `/auth/login/finish` answers with the two-factor challenge instead of the key. */
  requires2FA: boolean;
  /** The base64 instructions ciphertext `/account/instructions` serves. */
  instructions: string | null;
  /** Replaces one route for the remainder of the current test. */
  serve: (path: string, handler: AuthRouteHandler) => void;
  /** The stock handler for `path`, so a test can wrap the real one rather than replace it. */
  stockRoute: (path: string) => AuthRouteHandler;
  /** Requests whose URL ends with `path`, in order. */
  requestsTo: (path: string) => AuthServerRequest[];
  /** Encrypts `plaintext` to the account, as the account slice stores it. */
  encryptInstructions: (plaintext: string) => string;
  /** The server's `authInit` half, driven directly for tests that sit below the HTTP layer. */
  challengeStepUp: (ke1: number[]) => Promise<{ ke2: number[]; sessionId: string }>;
  /** The server's `authFinish` half: true iff the proof closes the named handshake. */
  proveStepUp: (ke3: number[], sessionId: string) => boolean;
  /** Restores the default routes and clears per-test state. Call from `beforeEach`. */
  reset: () => void;
  /** Installs the request handler as `globalThis.fetch`. */
  install: () => void;
}

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function refusal(code: string, status = 400): Response {
  return jsonResponse({ code }, status);
}

function field(body: Record<string, unknown>, name: string): string {
  const value = body[name];
  return typeof value === 'string' ? value : '';
}

function numbers(body: Record<string, unknown>, name: string): number[] {
  const value = body[name];
  return Array.isArray(value) ? (value as number[]) : [];
}

function randomBytes(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

interface PendingReset {
  readonly identifier: string;
  readonly nonce: Uint8Array;
}

/**
 * Builds a real OPAQUE server with one registered account and serves the auth
 * routes from it, so every flow under test completes the genuine protocol. The
 * fetch boundary is the only thing stubbed: it is the one true external seam.
 *
 * Expensive — one registration round trip plus one `createAccount` — so build it
 * once per file in `beforeAll` and call `reset()` from `beforeEach`.
 */
export async function createAuthServerFixture(): Promise<AuthServerFixture> {
  const material: ServerMaterial = await deriveServerMaterial(textEncoder.encode(SERVER_SECRET));
  const server = createOpaqueServer(material, OPAQUE_SERVER_IDENTIFIER);

  const registrationClient = createOpaqueClient();
  const { serialized } = await startRegistration(registrationClient, REGISTERED_CREDENTIAL);
  const registrationResponse = await server.registerInit(
    OpaqueServerRegistrationRequest.deserialize(OpaqueServerConfig, serialized),
    CREDENTIAL_ID
  );
  if (registrationResponse instanceof Error) throw registrationResponse;
  const registered = await finishRegistration(
    registrationClient,
    registrationResponse.serialize(),
    OPAQUE_SERVER_IDENTIFIER
  );

  const exportKey = new Uint8Array(registered.exportKey);
  const account = await createAccount(exportKey);
  const accountPrivateKey = unwrapAccountKeyWithPassword(
    exportKey,
    account.passwordWrappedPrivateKey
  );

  const user: MeResponse['user'] = {
    id: USER_ID,
    email: IDENTIFIER,
    username: 'test_user',
    emailVerified: true,
    totpEnabled: false,
    hasAcknowledgedPhrase: true,
  };

  /** The record `authInit` answers on; replaced whenever a flow registers a new password. */
  let registrationRecord = new Uint8Array(registered.record);
  const pendingHandshakes = new Map<string, number[]>();
  const pendingResets = new Map<string, PendingReset>();
  const routes = new Map<string, AuthRouteHandler>();
  const stockRoutes = new Map<string, AuthRouteHandler>();

  const fixture: AuthServerFixture = {
    identifier: IDENTIFIER,
    password: REGISTERED_CREDENTIAL,
    userId: USER_ID,
    user,
    account,
    accountPrivateKey,
    exportKey,
    requests: [],
    totpCode: TOTP_CODE,
    passwordWrappedPrivateKey: account.passwordWrappedPrivateKey,
    requires2FA: false,
    instructions: null,
    serve: (path, handler) => {
      routes.set(path, handler);
    },
    stockRoute: (path) => {
      const handler = stockRoutes.get(path);
      if (!handler) throw new Error(`No stock route for ${path}`);
      return handler;
    },
    requestsTo: (path) => fixture.requests.filter((request) => request.url.endsWith(path)),
    encryptInstructions: (plaintext) =>
      toBase64(encryptCustomInstructions(account.publicKey, plaintext, USER_ID)),
    challengeStepUp: async (ke1) => await beginHandshake({ ke1 }),
    proveStepUp: (ke3, sessionId) => closeHandshake({ ke3, sessionId }, 'sessionId'),
    reset: () => {
      fixture.requests.length = 0;
      fixture.passwordWrappedPrivateKey = account.passwordWrappedPrivateKey;
      fixture.requires2FA = false;
      fixture.instructions = null;
      registrationRecord = new Uint8Array(registered.record);
      pendingHandshakes.clear();
      pendingResets.clear();
      routes.clear();
      for (const [path, handler] of stockRoutes) routes.set(path, handler);
    },
    install: () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          const url = urlFromFetchInput(input);
          const raw = typeof init?.body === 'string' ? init.body : '{}';
          const request: AuthServerRequest = {
            url,
            body: JSON.parse(raw) as Record<string, unknown>,
            init,
          };
          fixture.requests.push(request);
          const handler = longestMatch(url);
          if (!handler) throw new Error(`Unexpected fetch: ${url}`);
          return await handler(request);
        })
      );
    },
  };

  function longestMatch(url: string): AuthRouteHandler | undefined {
    let matched: AuthRouteHandler | undefined;
    let matchedLength = -1;
    for (const [path, handler] of routes) {
      if (url.endsWith(path) && path.length > matchedLength) {
        matched = handler;
        matchedLength = path.length;
      }
    }
    return matched;
  }

  /** The server's `authInit` half, shared by login and every password step-up. */
  async function beginHandshake(body: Record<string, unknown>): Promise<{
    ke2: number[];
    sessionId: string;
  }> {
    const { ke2, expectedSerialized } = await opaqueStepUpInit({
      material,
      opaqueRegistration: registrationRecord,
      username: CREDENTIAL_ID,
      ke1: Uint8Array.from(numbers(body, 'ke1')),
    });
    const sessionId = crypto.randomUUID();
    pendingHandshakes.set(sessionId, expectedSerialized);
    return { ke2: [...ke2], sessionId };
  }

  /** The server's `authFinish` half: a single-use claim on the handshake the init minted. */
  function closeHandshake(body: Record<string, unknown>, sessionField: string): boolean {
    const sessionId = field(body, sessionField);
    const expectedSerialized = pendingHandshakes.get(sessionId);
    pendingHandshakes.delete(sessionId);
    if (!expectedSerialized) return false;
    return opaqueStepUpFinish({
      ke3: Uint8Array.from(numbers(body, 'ke3')),
      expectedSerialized,
    }).ok;
  }

  /** Adopts a password the client just registered, so a later sign-in proves the change landed. */
  function adoptNewPassword(body: Record<string, unknown>): void {
    registrationRecord = Uint8Array.from(numbers(body, 'newRegistrationRecord'));
    fixture.passwordWrappedPrivateKey = fromBase64(field(body, 'newPasswordWrappedPrivateKey'));
  }

  async function registerNewPassword(body: Record<string, unknown>): Promise<number[]> {
    const response = await server.registerInit(
      OpaqueServerRegistrationRequest.deserialize(
        OpaqueServerConfig,
        numbers(body, 'newRegistrationRequest')
      ),
      CREDENTIAL_ID
    );
    if (response instanceof Error) throw response;
    return response.serialize();
  }

  function meBody(): MeResponse {
    return {
      user,
      passwordWrappedPrivateKey: toBase64(fixture.passwordWrappedPrivateKey),
      publicKey: toBase64(account.publicKey),
    };
  }

  function defaultRoutes(): [string, AuthRouteHandler][] {
    return [
      [
        '/auth/login/init',
        async ({ body }) => {
          const { ke2, sessionId } = await beginHandshake(body);
          return jsonResponse({ ke2, loginSessionId: sessionId });
        },
      ],
      [
        '/auth/login/finish',
        ({ body }) => {
          if (!closeHandshake(body, 'loginSessionId')) return refusal(ERROR_CODES.AUTH_FAILED, 401);
          if (fixture.requires2FA) return jsonResponse({ requires2FA: true, userId: USER_ID });
          return jsonResponse({
            success: true,
            userId: USER_ID,
            passwordWrappedPrivateKey: toBase64(fixture.passwordWrappedPrivateKey),
          });
        },
      ],
      [
        '/auth/login/2fa/verify',
        ({ body }) =>
          field(body, 'code') === TOTP_CODE
            ? jsonResponse({
                success: true,
                userId: USER_ID,
                passwordWrappedPrivateKey: toBase64(fixture.passwordWrappedPrivateKey),
              })
            : refusal(ERROR_CODES.INVALID_TOTP_CODE, 401),
      ],
      [
        '/auth/register/init',
        async ({ body }) => {
          const response = await server.registerInit(
            OpaqueServerRegistrationRequest.deserialize(
              OpaqueServerConfig,
              numbers(body, 'registrationRequest')
            ),
            CREDENTIAL_ID
          );
          if (response instanceof Error) throw response;
          return jsonResponse({
            registrationResponse: response.serialize(),
            registerSessionId: crypto.randomUUID(),
          });
        },
      ],
      [
        '/auth/register/finish',
        ({ body }) => {
          // The route's schema takes only the current revision, and refuses before it
          // consumes the handshake.
          if (body['acceptedTermsRevision'] !== TERMS_OF_SERVICE_REVISION) {
            return refusal(ERROR_CODES.VALIDATION);
          }
          registrationRecord = Uint8Array.from(numbers(body, 'registrationRecord'));
          fixture.passwordWrappedPrivateKey = fromBase64(field(body, 'passwordWrappedPrivateKey'));
          return jsonResponse({ success: true });
        },
      ],
      [
        '/auth/change-password/init',
        async ({ body }) => {
          const { ke2, sessionId } = await beginHandshake(body);
          return jsonResponse({
            ke2,
            newRegistrationResponse: await registerNewPassword(body),
            changePasswordSessionId: sessionId,
          });
        },
      ],
      [
        '/auth/change-password/finish',
        ({ body }) => {
          if (!closeHandshake(body, 'changePasswordSessionId')) {
            return refusal(ERROR_CODES.NO_PENDING_STEP_UP, 401);
          }
          adoptNewPassword(body);
          return jsonResponse({ success: true });
        },
      ],
      [
        '/auth/2fa/disable/init',
        async ({ body }) => {
          const { ke2, sessionId } = await beginHandshake(body);
          return jsonResponse({ ke2, disable2FASessionId: sessionId });
        },
      ],
      [
        '/auth/2fa/disable/finish',
        ({ body }) => {
          if (!closeHandshake(body, 'disable2FASessionId')) {
            return refusal(ERROR_CODES.NO_PENDING_STEP_UP, 401);
          }
          return field(body, 'code') === TOTP_CODE
            ? jsonResponse({ success: true })
            : refusal(ERROR_CODES.INVALID_TOTP_CODE, 401);
        },
      ],
      [
        '/auth/recovery/save/init',
        async ({ body }) => {
          const { ke2, sessionId } = await beginHandshake(body);
          return jsonResponse({ ke2, recoverySaveSessionId: sessionId });
        },
      ],
      [
        '/auth/recovery/save/finish',
        ({ body }) =>
          closeHandshake(body, 'recoverySaveSessionId')
            ? jsonResponse({ success: true })
            : refusal(ERROR_CODES.NO_PENDING_STEP_UP, 401),
      ],
      [
        '/auth/recovery/get-wrapped-key',
        ({ body }) => {
          // The enumeration-safe answer the identity slice gives: the stored blob
          // for a known identifier, a same-shaped derived dummy for an unknown one.
          const canonical = canonicalIdentifier(field(body, 'identifier'));
          const blob =
            canonical === canonicalIdentifier(IDENTIFIER)
              ? account.recoveryWrappedPrivateKey
              : deriveDummyRecoveryWrappedKey(
                  asServerSecret(textEncoder.encode(SERVER_SECRET)),
                  canonical,
                  account.recoveryWrappedPrivateKey
                );
          return jsonResponse({ recoveryWrappedPrivateKey: toBase64(blob) });
        },
      ],
      [
        '/auth/recovery/reset/init',
        async ({ body }) => {
          const nonce = randomBytes(RESET_CHALLENGE_NONCE_BYTES);
          const recoverySessionId = crypto.randomUUID();
          pendingResets.set(recoverySessionId, {
            identifier: canonicalIdentifier(field(body, 'identifier')),
            nonce,
          });
          return jsonResponse({
            newRegistrationResponse: await registerNewPassword(body),
            recoverySessionId,
            sealedChallenge: toBase64(
              sealResetChallenge(asWrappingPublicKey(account.recoveryPublicKey), nonce)
            ),
          });
        },
      ],
      [
        '/auth/recovery/reset/finish',
        ({ body }) => {
          const recoverySessionId = field(body, 'recoverySessionId');
          const claimed = pendingResets.get(recoverySessionId);
          pendingResets.delete(recoverySessionId);
          const canonical = canonicalIdentifier(field(body, 'identifier'));
          if (claimed?.identifier !== canonical) {
            return refusal(ERROR_CODES.NO_PENDING_RECOVERY, 401);
          }
          const held = verifyResetProof(
            claimed.nonce,
            {
              recoverySessionId,
              canonicalIdentifier: canonical,
              newRegistrationRecord: Uint8Array.from(numbers(body, 'newRegistrationRecord')),
              newPasswordWrappedPrivateKey: field(body, 'newPasswordWrappedPrivateKey'),
            },
            fromBase64(field(body, 'resetProof'))
          );
          if (!held) return refusal(ERROR_CODES.NO_PENDING_RECOVERY, 401);
          adoptNewPassword(body);
          return jsonResponse({ success: true });
        },
      ],
      ['/auth/me', () => jsonResponse(meBody())],
      ['/auth/logout', () => jsonResponse({ success: true })],
      ['/auth/token-login', () => jsonResponse({ success: true })],
      ['/auth/verify-email', () => jsonResponse({ success: true })],
      ['/auth/verify-email/resend', () => jsonResponse({ success: true })],
      ['/account/instructions', () => jsonResponse({ instructions: fixture.instructions })],
    ];
  }

  for (const [path, handler] of defaultRoutes()) stockRoutes.set(path, handler);
  fixture.reset();
  return fixture;
}

/** The browser fakes `resetAuthEnvironment` installs, for tests that steer them. */
export interface AuthTestEnvironment {
  readonly storage: StorageFakeControls;
  readonly indexedDb: IndexedDbFakeControls;
}

/**
 * The per-test reset every auth-flow file shares: fresh Web Storage and IndexedDB
 * fakes, the fixture's routes reinstalled, and the auth store back to its
 * signed-out state. Shared rather than copied per file because the store reset is
 * a contract: a field added to the store later and missed in one copy would leak
 * state between tests and stay green.
 */
export function resetAuthEnvironment(fixture: AuthServerFixture): AuthTestEnvironment {
  vi.clearAllMocks();
  const storage: StorageFakeControls = { failRead: false };
  vi.stubGlobal('localStorage', createInMemoryStorage(storage));
  vi.stubGlobal('sessionStorage', createInMemoryStorage(storage));
  const { controls: indexedDb } = installFakeIndexedDB();
  fixture.reset();
  fixture.install();
  useAuthStore.setState({
    user: null,
    privateKey: null,
    customInstructions: null,
    customInstructionsStatus: 'pending',
    isLoading: true,
    isAuthenticated: false,
  });
  resetInitPromise();
  return { storage, indexedDb };
}

/**
 * The private key is the account's own iff its public half matches. `publicKey`
 * defaults to the fixture account's; pass one for an account a test registered.
 */
export function expectAccountPrivateKey(
  fixture: AuthServerFixture,
  privateKey: Uint8Array | null,
  publicKey: Uint8Array = fixture.account.publicKey
): void {
  if (!privateKey) throw new Error('Expected a private key');
  expect([...getPublicKeyFromPrivate(privateKey)]).toEqual([...publicKey]);
}
