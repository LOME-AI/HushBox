import { z } from 'zod';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createFakeRegistrationRecord,
  createOpaqueServer,
  deriveServerMaterial,
  opaqueKekFingerprint,
  openServerMaterial,
  sealServerMaterial,
} from '@hushbox/crypto';
import { canonicalIdentifier, toBase64 } from '@hushbox/shared';
import { ResultAsync, errAsync, fromPromise, okAsync } from '../../../../lib/result/index.js';
import { redisGetDel, redisSet } from '../../../../lib/redis/index.js';
import { clear, consumeLayers } from '../../../../lib/rate-limit/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { IDENTITY_KEYS, loginNetworkLockoutId } from '../keys.js';
import { openUnderLiveKey } from '../open-under-live-key.js';
import { issueSession } from '../session/session.js';
import { proofHolds } from '../session/step-up.js';
import {
  MAX_KE_ARRAY_LENGTH,
  opaqueByteArray,
  deserializeKe1,
  deserializeRegistrationRecord,
  opaqueProtocolError,
  throwIfOpaqueError,
} from './opaque.js';
import type { OpaqueKE1, OpaqueRegistrationRecord, ServerMaterial } from '@hushbox/crypto';
import type { DomainError } from '../../../../lib/errors/index.js';
import type {
  AccountLockedEmailPort,
  IdentityUserRecord,
  IdentityUsersStore,
} from '../../ports/index.js';
import type { IdentitySecrets, OpaqueFinishFlow } from './opaque.js';
import type { RedisClient } from '../keys.js';

export const loginInitBodySchema = z.object({
  identifier: z.string().min(1).max(254),
  ke1: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
});

export const loginFinishBodySchema = z.object({
  identifier: z.string().min(1).max(254),
  ke3: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
  loginSessionId: z.uuid(),
});

/** The pending OPAQUE login handshake as stored in the Redis registry. */
export type PendingLogin = z.infer<(typeof IDENTITY_KEYS.opaquePendingLogin)['schema']>;

export interface LoginStartArgs {
  readonly store: IdentityUsersStore;
  readonly redis: RedisClient;
  readonly secrets: Pick<IdentitySecrets, 'opaqueKek' | 'enumerationDecoySecret'>;
  readonly identifier: string;
  readonly ke1: number[];
  /**
   * The caller's network identity, half of what the per-network lockout counts,
   * or null where production carried no address to derive one from. Null is
   * refused rather than keyed on a sentinel: one window shared by every caller
   * behind an edge fault caps the whole fault at one caller's allowance.
   */
  readonly callerNetworkId: string | null;
  /**
   * Best-effort security notification, dispatched only on the exact attempt
   * that trips the account-wide lockout and only for a resolved account (an
   * unknown identifier has no address). A send failure never changes the
   * response.
   */
  readonly accountLockedEmail: AccountLockedEmailPort;
}

export type LoginStartOutcome =
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  // The row's material is sealed under a KEK this deployment does not hold:
  // the key and the rows disagree — an operator condition, never a wrong
  // password.
  | { readonly kind: 'server-material-unreadable' }
  | { readonly kind: 'started'; readonly ke2: number[]; readonly loginSessionId: string };

function lookupByIdentifier(
  store: IdentityUsersStore,
  identifier: string,
  canonical: string
): ResultAsync<IdentityUserRecord | null, DomainError> {
  return identifier.includes('@') ? store.findByEmail(canonical) : store.findByUsername(canonical);
}

/**
 * Round one of OPAQUE login. An unknown identifier takes the
 * fake-registration-record path: the response shape, status, and stored
 * pending state are identical to a real user's, so nothing distinguishes
 * "no such account" from "wrong password" — at this round or the next.
 *
 * Login is a secret-guessing surface, so the attempt is spent BEFORE the
 * handshake begins: the increment is the gate, and at most the cap of password
 * verifications is ever admitted even under concurrency. A verified login
 * clears the counter (the `clear` in the finish round).
 *
 * The lockout keys on the user id when one exists, else on the canonical
 * identifier. Keying a found user on user.id (rather than the submitted
 * identifier string) is deliberate: it unifies email and username into ONE
 * brute-force budget — the lockout's primary guarantee — and matches the
 * on-success clear below, which also keys on user.id. It admits a minor
 * linkage oracle: exhausting the cap via one identifier form and then
 * hitting 429 via the other confirms both name the same account. Accepted —
 * closing it by keying on the submitted identifier would (a) multiply the
 * per-account guessing budget by the number of identifier forms and
 * (b) desynchronize the on-success clear, trading the core brute-force
 * guarantee for a lesser concern an attacker can only exploit once they
 * already hold both identifiers.
 *
 * That budget is spent by anyone who can NAME the account, which is the other
 * half of the reasoning and the half a guessing-only reading misses: a
 * reservation spent before any cryptographic work is also a DENIAL lever, so
 * a budget an attacker can drain from one address is a way to hold that
 * account's owner out of login. The bound below is therefore two windows in
 * one all-or-nothing check — what one network may spend, and what the account
 * may spend across every network — so denial costs an address per window while
 * the brute-force bound survives as the wider of the two.
 */
export function startLogin(args: LoginStartArgs): ResultAsync<LoginStartOutcome, DomainError> {
  const canonical = canonicalIdentifier(args.identifier);
  return lookupByIdentifier(args.store, args.identifier, canonical).andThen((user) =>
    admitLoginAttempt(args, user, canonical)
  );
}

/**
 * Position of the account-wide ceiling among the layers spent below. The
 * script attributes a refusal to the FIRST refusing layer, so the ceiling is
 * declared ahead of the per-network window: when both refuse, the refusal the
 * caller is told about — and the crossing the notification reads — is the
 * account-wide one.
 */
const CEILING_LAYER = 0;

/**
 * Both reservations are spent as ONE layered check rather than two calls. Two
 * calls cannot express all-or-nothing: a refusal on the second leaves the
 * first's increment standing, so an attacker's REFUSED requests would drain
 * the sibling window — the hazard layering exists to prevent.
 *
 * The attempt is spent before the finish round verifies the password, and a
 * {@link consumeLayers} that timed out can still have counted — only its wait
 * is abandoned. So a lockout can advance with no caller learning the outcome:
 * an account-locked email during a Redis degradation is that, not the
 * credential stuffing it resembles.
 */
function admitLoginAttempt(
  args: LoginStartArgs,
  user: IdentityUserRecord | null,
  canonical: string
): ResultAsync<LoginStartOutcome, DomainError> {
  const networkId = args.callerNetworkId;
  if (networkId === null) {
    // The generic `unavailable` refusal, never the limiter's own wire code:
    // that code is the money guard's proof that a card charge was never
    // dispatched, and the arch rule `money-guard-codes-come-from-the-pipeline`
    // keeps it inside the pipeline stage for exactly that reason.
    return errAsync<LoginStartOutcome, DomainError>(
      unavailableError('login lockout has no caller network to key on')
    );
  }
  const lockoutKey = user?.id ?? canonical;
  return ResultAsync.fromSafePromise(loginNetworkLockoutId(lockoutKey, networkId))
    .andThen((networkKeyedId) =>
      consumeLayers(args.redis, [
        { definition: IDENTITY_KEYS.loginLockout, id: lockoutKey },
        { definition: IDENTITY_KEYS.loginLockoutPerNetwork, id: networkKeyedId },
      ])
    )
    .andThen((decision) => {
      if (decision.allowed) return beginLoginHandshake(args, user, canonical);
      return notifyLockoutTriggered(
        args,
        user,
        crossedTheCeiling(decision.layer, decision.count)
      ).map(
        (): LoginStartOutcome => ({
          kind: 'rate-limited',
          retryAfterSeconds: decision.retryAfterSeconds,
        })
      );
    });
}

/**
 * True only on the exact attempt that crossed the ACCOUNT-WIDE ceiling, which
 * is the only crossing at which every sentence of the account-locked template
 * is true. A per-network crossing refuses one network rather than locking the
 * account, and fires once per address a guesser holds, which would make the
 * notification a channel into that account holder's inbox. The refusing layer
 * keeps advancing past its cap, so `maxAttempts + 1` names one attempt and the
 * notification below fires once rather than on every subsequent locked one.
 */
function crossedTheCeiling(layer: number, count: number): boolean {
  return layer === CEILING_LAYER && count === IDENTITY_KEYS.loginLockout.maxAttempts + 1;
}

/**
 * Fires the account-locked notification once — only on the attempt that
 * crossed the threshold and only for a resolved account, so
 * a lockout under an unknown identifier (enumeration path) sends nothing and
 * subsequent locked attempts do not spam. Best-effort: a send failure is
 * swallowed so it never changes the login response.
 */
function notifyLockoutTriggered(
  args: LoginStartArgs,
  user: IdentityUserRecord | null,
  crossed: boolean
): ResultAsync<void, DomainError> {
  if (!crossed || !user?.email) return okAsync();
  const lockoutMinutes = Math.floor(IDENTITY_KEYS.loginLockout.windowSeconds / 60);
  return args.accountLockedEmail
    .sendAccountLockedEmail({ to: user.email, userName: user.username, lockoutMinutes })
    .orElse(() => okAsync());
}

function beginLoginHandshake(
  args: LoginStartArgs,
  user: IdentityUserRecord | null,
  canonical: string
): ResultAsync<LoginStartOutcome, DomainError> {
  return deserializeKe1(args.ke1)
    .asyncAndThen((ke1) => runAuthInit(args, user, canonical, ke1))
    .andThen((initialized) =>
      initialized === 'server-material-unreadable'
        ? okAsync<LoginStartOutcome, DomainError>({ kind: 'server-material-unreadable' })
        : storePendingLogin(args.redis, user, canonical, initialized)
    );
}

type OpaqueServerInstance = ReturnType<typeof createOpaqueServer>;
/** `{ ke2, expected }` — the library exports no KE2 type, so derive it. */
type AuthInitResult = Exclude<Awaited<ReturnType<OpaqueServerInstance['authInit']>>, Error>;

/**
 * Deserializes the server-stored OPAQUE registration record. A failure here
 * is corruption in data the slice itself wrote — a DEFECT, resolved OUTSIDE
 * the protocol-error mapper below so its throw surfaces as a 500 to telemetry
 * (an invariant break), never the client-input validation channel. Routing it
 * to a 400 would both hide the corruption and make a corrupt account
 * distinguishable from a healthy one at login init. A malformed CLIENT-supplied
 * record stays a 400 through the codec's validation mapping.
 */
function deserializeStoredRegistrationRecord(user: IdentityUserRecord): OpaqueRegistrationRecord {
  const record = deserializeRegistrationRecord([...user.opaqueRegistration]);
  if (record.isErr()) {
    throw new Error('identity: stored OPAQUE registration record is corrupt', {
      cause: record.error,
    });
  }
  return record.value;
}

/**
 * The credential id the decoy blob is sealed for. The fake registration
 * record is registered under a fixed id of its own, so the decoy blob needs
 * no per-identifier AAD either — one blob serves every unknown identifier.
 */
const DECOY_CREDENTIAL_ID = 'fake-credential-id';

/**
 * The decoy blob is cached per process (like the fake record it partners),
 * keyed on both secrets: the material inside is what the unknown-identifier
 * server is built on, so a blob sealed for another decoy secret would build a
 * server the fake record was not registered against. The key carries a digest
 * of the decoy secret, never its bytes — a module-level string lives for the
 * isolate's lifetime.
 *
 * NOTE: Module-level mutable cache (server-only state).
 */
let cachedDecoyBlob: { readonly key: string; readonly blob: Uint8Array } | null = null;

async function decoyCacheKey(secrets: LoginStartArgs['secrets']): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new Uint8Array(secrets.enumerationDecoySecret)
  );
  return `${toBase64(opaqueKekFingerprint(secrets.opaqueKek))}:${toBase64(new Uint8Array(digest))}`;
}

/**
 * The unknown-identifier path's material: derived from the decoy secret (the
 * fake record was registered against exactly this material), sealed under the
 * live KEK, and then OPENED — so the path performs the same unseal a real row
 * does and its timing does not tell "no such account" from "wrong password".
 */
async function decoyServerMaterial(secrets: LoginStartArgs['secrets']): Promise<ServerMaterial> {
  const key = await decoyCacheKey(secrets);
  if (cachedDecoyBlob?.key !== key) {
    const material = await deriveServerMaterial(secrets.enumerationDecoySecret);
    cachedDecoyBlob = {
      key,
      blob: sealServerMaterial(secrets.opaqueKek, DECOY_CREDENTIAL_ID, material),
    };
  }
  return openServerMaterial(secrets.opaqueKek, DECOY_CREDENTIAL_ID, cachedDecoyBlob.blob);
}

function runAuthInit(
  args: LoginStartArgs,
  user: IdentityUserRecord | null,
  canonical: string,
  ke1: OpaqueKE1
): ResultAsync<AuthInitResult | 'server-material-unreadable', DomainError> {
  if (user === null) return authInitOn(args, ke1, { credentialIdentifier: canonical });
  const storedRecord = deserializeStoredRegistrationRecord(user);
  const storedMaterial = openUnderLiveKey(() =>
    openServerMaterial(args.secrets.opaqueKek, user.id, user.opaqueServerMaterial)
  );
  if (storedMaterial === null) {
    return okAsync<AuthInitResult | 'server-material-unreadable', DomainError>(
      'server-material-unreadable'
    );
  }
  return authInitOn(args, ke1, {
    credentialIdentifier: user.id,
    material: storedMaterial,
    record: storedRecord,
  });
}

/** What the AKE init runs on: a resolved row's material and record, or the decoy pair when absent. */
interface AuthInitSubject {
  readonly credentialIdentifier: string;
  readonly material?: ServerMaterial;
  readonly record?: OpaqueRegistrationRecord;
}

/**
 * The AKE init itself: on the row's material and record when the identifier
 * resolved, on the decoy pair when it did not — one code path either way.
 */
function authInitOn(
  args: LoginStartArgs,
  ke1: OpaqueKE1,
  subject: AuthInitSubject
): ResultAsync<AuthInitResult, DomainError> {
  return fromPromise(
    (async (): Promise<AuthInitResult> => {
      const material = subject.material ?? (await decoyServerMaterial(args.secrets));
      const server = createOpaqueServer(material, OPAQUE_SERVER_IDENTIFIER);
      let registrationRecord = subject.record;
      if (registrationRecord === undefined) {
        const fake = await createFakeRegistrationRecord(args.secrets.enumerationDecoySecret);
        registrationRecord = fake.registrationRecord;
      }
      return throwIfOpaqueError(
        await server.authInit(ke1, registrationRecord, subject.credentialIdentifier)
      );
    })(),
    opaqueProtocolError('OPAQUE authInit rejected the request')
  );
}

function storePendingLogin(
  redis: RedisClient,
  user: IdentityUserRecord | null,
  canonical: string,
  initialized: AuthInitResult
): ResultAsync<LoginStartOutcome, DomainError> {
  const loginSessionId = crypto.randomUUID();
  return redisSet(
    redis,
    IDENTITY_KEYS.opaquePendingLogin,
    {
      identifier: canonical,
      userId: user?.id ?? null,
      expectedSerialized: initialized.expected.serialize(),
    },
    loginSessionId
  ).map(
    (): LoginStartOutcome => ({
      kind: 'started',
      ke2: initialized.ke2.serialize(),
      loginSessionId,
    })
  );
}

/**
 * Resolves and CONSUMES the pending login handshake in one atomic Redis
 * GETDEL — strictly single-use, success or failure. The read and delete are
 * a single operation, so two concurrent finish deliveries can never both
 * observe the handshake: exactly one wins the value and the other reads null
 * (restarting the handshake harmlessly). This is the `opaque-protocol` finish
 * route's atomic first-delivery claim on the handshake id — a GET-then-DEL
 * pair would let both deliveries win and mint two sessions from one
 * handshake.
 */
export function consumePendingLogin(args: {
  readonly redis: RedisClient;
  readonly loginSessionId: string;
}): ResultAsync<PendingLogin | null, DomainError> {
  return redisGetDel(args.redis, IDENTITY_KEYS.opaquePendingLogin, args.loginSessionId);
}

export interface LoginFinishArgs {
  readonly store: IdentityUsersStore;
  readonly redis: RedisClient;
  readonly identifier: string;
  readonly ke3: number[];
  /**
   * The FINISH caller's network identity, which the per-network counter's
   * clear is keyed on. A different request from the one that spent the
   * counters, so a caller that changed networks between the rounds clears a
   * window it did not spend and leaves its own to expire — the clear is
   * best-effort, so neither costs the caller its session.
   */
  readonly callerNetworkId: string | null;
  /** The already-consumed pending handshake (see `consumePendingLogin`). */
  readonly pending: PendingLogin;
}

export type LoginFinishOutcome =
  | { readonly kind: 'auth-failed' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'email-not-verified' }
  | { readonly kind: 'success'; readonly user: IdentityUserRecord };

function authFailed(): ResultAsync<LoginFinishOutcome, DomainError> {
  return okAsync<LoginFinishOutcome, DomainError>({ kind: 'auth-failed' });
}

/**
 * Round two of OPAQUE login, verifying an already-consumed pending state.
 * Every indistinguishable failure (mismatched identifier, malformed KE3,
 * MAC mismatch, fake-record path, vanished user) collapses onto
 * `auth-failed`, preserving the enumeration safety the init round
 * established. The locked check runs only after the password verified, so
 * lock state leaks to no one who doesn't hold the credentials.
 *
 * The finish reads no secret: `authFinish` is a stateless MAC comparison over
 * the pinned expected result, so it runs through the step-up's {@link proofHolds}
 * on the zeroed construction — no per-user material is opened on this round.
 */
export function finishLogin(args: LoginFinishArgs): ResultAsync<LoginFinishOutcome, DomainError> {
  if (args.pending.identifier !== canonicalIdentifier(args.identifier)) return authFailed();
  if (!proofHolds(args.pending.expectedSerialized, args.ke3) || args.pending.userId === null) {
    return authFailed();
  }
  return resolveVerifiedUser(args, args.pending.userId);
}

function resolveVerifiedUser(
  args: LoginFinishArgs,
  userId: string
): ResultAsync<LoginFinishOutcome, DomainError> {
  return args.store.findById(userId).andThen((user) => {
    if (user === null) return authFailed();
    if (user.lockedAt !== null) {
      return okAsync<LoginFinishOutcome, DomainError>({ kind: 'locked' });
    }
    // Email-verify gate (legacy parity), checked only after the password
    // verified so it leaks to no one without the credential. The pending
    // handshake is already consumed (GETDEL in the claim step), and the
    // lockout counter is deliberately NOT cleared — an unverified login is not
    // a verified success. A guest-origin account with no email is never gated.
    if (user.email && !user.emailVerified) {
      return okAsync<LoginFinishOutcome, DomainError>({ kind: 'email-not-verified' });
    }
    // A verified password clears both attempt counters, each keyed on the user
    // id, which is what init used for a found user.
    return clearLoginCounters(args.redis, user.id, args.callerNetworkId).map(
      (): LoginFinishOutcome => ({ kind: 'success', user })
    );
  });
}

/**
 * Drops what a verified password earns back: the account-wide ceiling, and
 * this caller's own network window when its network resolved. Best-effort on
 * both counts — the password is already verified, so a failed clear must not
 * cost the session, and failing to clear fails safe.
 */
function clearLoginCounters(
  redis: RedisClient,
  userId: string,
  callerNetworkId: string | null
): ResultAsync<void, never> {
  const ceiling = clear(redis, IDENTITY_KEYS.loginLockout, userId);
  if (callerNetworkId === null) return ceiling;
  return ceiling
    .andThen(() => ResultAsync.fromSafePromise(loginNetworkLockoutId(userId, callerNetworkId)))
    .andThen((networkKeyedId) =>
      clear(redis, IDENTITY_KEYS.loginLockoutPerNetwork, networkKeyedId)
    );
}

export type LoginRouteOutcome =
  | { readonly kind: 'no-pending' }
  | { readonly kind: 'auth-failed' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'email-not-verified' }
  | {
      readonly kind: 'logged-in';
      readonly user: IdentityUserRecord;
      readonly requires2FA: boolean;
    };

export interface LoginFinishFlowArgs {
  readonly store: IdentityUsersStore;
  readonly redis: RedisClient;
  readonly identifier: string;
  readonly ke3: number[];
  readonly loginSessionId: string;
  /** The finish caller's network identity (see {@link LoginFinishArgs}). */
  readonly callerNetworkId: string | null;
  readonly request: Request;
  readonly response: Response;
  /** The fail-fast-validated IRON_SESSION_SECRET, never a raw env read. */
  readonly secret: string;
  readonly isProduction: boolean;
  readonly now: number;
}

/**
 * The login-finish `byEventId` composition (see `OpaqueFinishFlow`):
 * consuming the pending handshake is the first-delivery claim, and
 * verification — including minting the session on success — runs only on
 * the claimed state, so every failure mode flows through the one Result.
 */
export function createLoginFinishFlow(
  args: LoginFinishFlowArgs
): OpaqueFinishFlow<LoginRouteOutcome> {
  let pending: PendingLogin | null = null;
  return {
    claim: () =>
      consumePendingLogin({ redis: args.redis, loginSessionId: args.loginSessionId }).map(
        (state) => {
          pending = state;
          return state !== null;
        }
      ),
    execute: () => executeLoginFinish(args, pending),
    onDuplicate: () => okAsync<LoginRouteOutcome, DomainError>({ kind: 'no-pending' }),
  };
}

function executeLoginFinish(
  args: LoginFinishFlowArgs,
  pending: PendingLogin | null
): ResultAsync<LoginRouteOutcome, DomainError> {
  if (pending === null) {
    // `execute` runs only for the delivery that won the claim; a null
    // consume can never win it.
    throw new Error('identity: login finish executed without a claimed pending state');
  }
  return finishLogin({
    store: args.store,
    redis: args.redis,
    identifier: args.identifier,
    ke3: args.ke3,
    callerNetworkId: args.callerNetworkId,
    pending,
  }).andThen((outcome) =>
    outcome.kind === 'success'
      ? issueVerifiedSession(args, outcome.user)
      : okAsync<LoginRouteOutcome, DomainError>(outcome)
  );
}

/** A TOTP-enabled user gets a pending-2fa session; anyone else, full. */
function issueVerifiedSession(
  args: LoginFinishFlowArgs,
  user: IdentityUserRecord
): ResultAsync<LoginRouteOutcome, DomainError> {
  return issueSession({
    request: args.request,
    response: args.response,
    redis: args.redis,
    secret: args.secret,
    isProduction: args.isProduction,
    userId: user.id,
    kind: user.totpEnabled ? 'pending-2fa' : 'full',
    now: args.now,
  }).map((): LoginRouteOutcome => ({ kind: 'logged-in', user, requires2FA: user.totpEnabled }));
}
