import { z } from 'zod';
import {
  OPAQUE_SERVER_IDENTIFIER,
  createOpaqueServer,
  mintServerMaterial,
  opaqueKekFingerprint,
  sealServerMaterial,
} from '@hushbox/crypto';
import {
  GROWTH_UNKNOWN_CAMPAIGN,
  TERMS_OF_SERVICE_REVISION,
  USERNAME_REGEX,
  acquisitionSchema,
  campaignTagSchema,
  isReservedUsername,
  normalizeUsername,
} from '@hushbox/shared';
import { HOUR_MS } from '@hushbox/shared/durations';
import { provisionWalletsWithinTx } from '../../../billing/public/wallet-provisioning.js';
import { countRegistrationStarted, resolveCampaignTag } from '../../../growth/public/funnel.js';
import { FINGERPRINT_CODES } from '../../../../lib/telemetry/index.js';
import { Result, fromPromise, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { runSettlement } from '../../../../lib/idempotency/index.js';
import { redisGetDel, redisSet } from '../../../../lib/redis/index.js';
import {
  decodePublicKeyField,
  decodeRecoveryPublicKeyField,
  decodeWrappedKeyField,
} from '../guards.js';
import { EMAIL_VERIFY_TOKEN_TTL_MS } from '../account/email-verification.js';
import { consume } from '../../../../lib/rate-limit/index.js';
import { IDENTITY_KEYS } from '../keys.js';
import {
  MAX_KE_ARRAY_LENGTH,
  deserializeRegistrationRecord,
  deserializeRegistrationRequest,
  kekFingerprintMatches,
  opaqueByteArray,
  opaqueProtocolError,
  throwIfOpaqueError,
} from './opaque.js';
import type { Acquisition } from '@hushbox/shared';
import type { OpaqueKek, OpaqueServerRegistrationRequest } from '@hushbox/crypto';
import type { Database } from '@hushbox/db';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { BillingStores, WelcomeEmailPort } from '../../../billing/index.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type {
  IdentityUsersStore,
  IdentityVerificationStore,
  InsertRegisteredOutcome,
  RegistrationValues,
  VerificationEmailPort,
} from '../../ports/index.js';
import type { IdentitySecrets, OpaqueFinishFlow } from './opaque.js';
import type { RedisClient } from '../keys.js';

/**
 * The username is normalized BEFORE the rule and the reserved list run: the
 * stored form is what identifies a person, so `"Admin"` must be refused on the
 * `admin` it would become, not admitted on the casing it arrived in.
 */
export const registerInitBodySchema = z.object({
  email: z.email().max(254),
  username: z
    .string()
    .transform(normalizeUsername)
    .refine((username) => USERNAME_REGEX.test(username))
    .refine((username) => !isReservedUsername(username)),
  registrationRequest: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
  /**
   * The campaign tag the signup link carried, straight off the address bar.
   * It is validated against the live campaigns before it is counted and never
   * refuses the handshake: a stale link still registers an account.
   */
  c: campaignTagSchema.optional(),
});

export const registerFinishBodySchema = z.object({
  email: z.email().max(254),
  registrationRecord: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
  accountPublicKey: z.string().min(1),
  passwordWrappedPrivateKey: z.string().min(1),
  recoveryWrappedPrivateKey: z.string().min(1),
  recoveryPublicKey: z.string().min(1),
  registerSessionId: z.uuid(),
  /**
   * Where this account came from. Optional on the wire so a client that does
   * not send it still registers; an account that sends none carries no
   * acquisition row and is never asked the channel question.
   */
  acquisition: acquisitionSchema.optional(),
  /**
   * The Terms revision the user accepted. Only the revision the server
   * currently publishes is accepted, so no account exists without a recorded
   * acceptance of the text it was shown.
   */
  acceptedTermsRevision: z.literal(TERMS_OF_SERVICE_REVISION),
});

/**
 * What the funnel count needs from the request, kept together so the growth
 * write takes one argument rather than four loose ones that could be passed in
 * the wrong order.
 */
export interface RegistrationGrowthArgs {
  /** The tag the link carried, still unvalidated. */
  readonly campaignTag: string | undefined;
  /** The caller's address as the shared resolver answered it; growth keys it before counting. */
  readonly address: string;
  /** The key growth derives the start's address identity under; absent is a deploy defect. */
  readonly secret: string | undefined;
  /** Growth's own read of its active campaign tags, called only on a registry miss. */
  readonly listActiveTags: () => ResultAsync<readonly string[], DomainError>;
}

export interface RegistrationStartArgs {
  readonly store: IdentityUsersStore;
  readonly redis: RedisClient;
  readonly secrets: Pick<IdentitySecrets, 'opaqueKek'>;
  readonly email: string;
  readonly username: string;
  readonly registrationRequest: number[];
  readonly now: number;
  readonly growth: RegistrationGrowthArgs;
  /** The channel a growth degrade is reported on; registration itself never degrades. */
  readonly logger: Telemetry;
}

export type RegistrationStartOutcome =
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  | {
      readonly kind: 'started';
      readonly registrationResponse: number[];
      readonly registerSessionId: string;
    };

/**
 * Round one of OPAQUE registration. The request is processed identically
 * whether or not the email is already registered — the existing flag rides
 * along in the pending state so the finish round can answer the same
 * fake-success shape, preventing account enumeration.
 */
export function startRegistration(
  args: RegistrationStartArgs
): ResultAsync<RegistrationStartOutcome, DomainError> {
  const email = args.email.toLowerCase();
  return consume(args.redis, IDENTITY_KEYS.registerRateLimit, email).andThen((decision) =>
    decision.allowed
      ? beginRegistrationHandshake(args, email)
      : okAsync<RegistrationStartOutcome, DomainError>({
          kind: 'rate-limited',
          retryAfterSeconds: decision.retryAfterSeconds,
        })
  );
}

function beginRegistrationHandshake(
  args: RegistrationStartArgs,
  email: string
): ResultAsync<RegistrationStartOutcome, DomainError> {
  return deserializeRegistrationRequest(args.registrationRequest)
    .asyncAndThen((request) => prepareRegistration(args, email, request))
    .andThen((prepared) =>
      countStarted(args, prepared.existing).andThen(() =>
        storePendingRegistration(args, email, prepared)
      )
    );
}

/**
 * The funnel's one count, taken on both outcomes of the handshake.
 *
 * The decoy branch counts into growth's shadow set rather than skipping the
 * write: an existing-email handshake that did measurably less work than a real
 * one would leak, by timing, exactly the fact the decoy exists to hide.
 *
 * An address the ceiling turns away is reported the first time it happens in a
 * bucket, because the only other trace is a floor mark on a dashboard and set
 * membership that expires with the bucket. Reaching that ceiling takes a
 * hundred thousand distinct address prefixes in one hour under one tag, which
 * is a statement about an attacker rather than about traffic. The store latches
 * the flag per set per bucket, so a sustained attempt is one report an hour per
 * tag rather than one per refused address.
 *
 * Every failure is swallowed into success after one report. Registration is
 * authentication and never degrades; growth may, and an account that could not
 * be counted is still an account.
 */
function countStarted(args: RegistrationStartArgs, decoy: boolean): ResultAsync<void, DomainError> {
  const secret = args.growth.secret;
  if (secret === undefined || secret === '') {
    args.logger.captureError(
      new Error('GROWTH_HASH_SECRET is required to count a registration start'),
      FINGERPRINT_CODES.growthRegistrationStartUnavailable
    );
    return okAsync();
  }
  return resolveCampaignTag({
    redis: args.redis,
    listActiveTags: args.growth.listActiveTags,
    tag: args.growth.campaignTag,
  })
    .andThen((campaign) =>
      countRegistrationStarted(args.redis, {
        secret,
        address: args.growth.address,
        at: new Date(args.now),
        campaign,
        decoy,
      })
    )
    .map((latched) => {
      if (latched) {
        args.logger.captureError(
          new Error('growth set reached its ceiling: the registration-start count'),
          FINGERPRINT_CODES.growthSetOverflowed
        );
      }
    })
    .orElse(() => {
      args.logger.captureError(
        new Error('registration start could not be counted'),
        FINGERPRINT_CODES.growthRegistrationStartUnavailable
      );
      return okAsync();
    });
}

interface PreparedRegistration {
  readonly serializedResponse: number[];
  readonly existing: boolean;
  readonly userId: string;
  /** The minted material the response was computed on, sealed under the KEK. */
  readonly serverMaterial: Uint8Array;
  readonly kekFingerprint: Uint8Array;
}

function prepareRegistration(
  args: RegistrationStartArgs,
  email: string,
  request: OpaqueServerRegistrationRequest
): ResultAsync<PreparedRegistration, DomainError> {
  return args.store
    .findByEmail(email)
    .andThen((existingUser) => runRegisterInit(args, request, existingUser !== null));
}

/**
 * Mints the durable `users.id` as a UUIDv7 — a 48-bit big-endian millisecond
 * timestamp prefix followed by a random tail — so the most-joined table keeps
 * B-tree insert locality and time-ordering (parity with every other PK, which
 * uses the schema's DB-side `uuidv7()`).
 *
 * It is minted app-side rather than deferred to the `users.id` column default
 * because this same value is the OPAQUE `credential_identifier`: it is bound in
 * `registerInit` BEFORE the row exists and re-supplied verbatim at login
 * (`authInit`) to seed the per-user OPRF key. The two calls must pass a
 * byte-identical identifier, and login can only rebind on `users.id` (it accepts
 * either username or email as the submitted identifier), so the id cannot be
 * generated by the INSERT — it must be known at register-init.
 */
export function generateUserId(now: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const view = new DataView(bytes.buffer);
  const ts = BigInt(Math.trunc(now));
  for (let index = 0; index < 6; index += 1) {
    view.setUint8(index, Number((ts >> BigInt((5 - index) * 8)) & 0xffn));
  }
  view.setUint8(6, (view.getUint8(6) & 0x0f) | 0x70); // version 7
  view.setUint8(8, (view.getUint8(8) & 0x3f) | 0x80); // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

/**
 * Mints this account's own OPAQUE server material and runs registerInit on
 * it. The material is sealed here, under the KEK this round holds, and rides
 * the pending state to the finish round unchanged: a finish that re-read the
 * KEK could stamp a record with material it was not produced under.
 */
function runRegisterInit(
  args: RegistrationStartArgs,
  request: OpaqueServerRegistrationRequest,
  existing: boolean
): ResultAsync<PreparedRegistration, DomainError> {
  const userId = generateUserId(args.now);
  const kek = args.secrets.opaqueKek;
  return fromPromise(
    (async (): Promise<PreparedRegistration> => {
      const material = await mintServerMaterial();
      const server = createOpaqueServer(material, OPAQUE_SERVER_IDENTIFIER);
      const response = throwIfOpaqueError(await server.registerInit(request, userId));
      return {
        serializedResponse: response.serialize(),
        existing,
        userId,
        serverMaterial: sealServerMaterial(kek, userId, material),
        kekFingerprint: opaqueKekFingerprint(kek),
      };
    })(),
    opaqueProtocolError('OPAQUE registerInit rejected the request')
  );
}

function storePendingRegistration(
  args: RegistrationStartArgs,
  email: string,
  prepared: PreparedRegistration
): ResultAsync<RegistrationStartOutcome, DomainError> {
  const registerSessionId = crypto.randomUUID();
  return redisSet(
    args.redis,
    IDENTITY_KEYS.opaquePendingRegistration,
    {
      email,
      username: normalizeUsername(args.username),
      userId: prepared.userId,
      serverMaterial: [...prepared.serverMaterial],
      kekFingerprint: [...prepared.kekFingerprint],
      ...(prepared.existing ? { existing: true } : {}),
    },
    registerSessionId
  ).map(
    (): RegistrationStartOutcome => ({
      kind: 'started',
      registrationResponse: prepared.serializedResponse,
      registerSessionId,
    })
  );
}

/** The pinned account identity plus the sealed material its record was produced on. */
interface PendingRegistration {
  readonly userId: string;
  readonly email: string;
  readonly username: string;
  readonly serverMaterial: Uint8Array;
  readonly kekFingerprint: Uint8Array;
}

export type ConsumePendingRegistrationOutcome =
  | { readonly kind: 'no-pending' }
  | { readonly kind: 'existing' }
  | ({ readonly kind: 'pending' } & PendingRegistration);

/**
 * Resolves and CONSUMES the pending registration state in one atomic Redis
 * GETDEL — strictly single-use. The read and delete are a single operation,
 * so two concurrent finish deliveries (or a crash-retry) can never both
 * observe the state: exactly one wins it and the other reads null, taking the
 * no-pending path. This is the `opaque-protocol` finish route's atomic
 * first-delivery claim on the handshake id — a GET-then-DEL pair would let
 * both deliveries win and race the account INSERT.
 */
export function consumePendingRegistration(args: {
  readonly redis: RedisClient;
  readonly email: string;
  readonly registerSessionId: string;
}): ResultAsync<ConsumePendingRegistrationOutcome, DomainError> {
  return redisGetDel(
    args.redis,
    IDENTITY_KEYS.opaquePendingRegistration,
    args.registerSessionId
  ).map((pending): ConsumePendingRegistrationOutcome => {
    if (pending === null) return { kind: 'no-pending' };
    // Defense-in-depth: a stolen handshake id must not complete a
    // registration for a different email.
    if (pending.email !== args.email.toLowerCase()) return { kind: 'no-pending' };
    if (pending.existing === true) return { kind: 'existing' };
    return {
      kind: 'pending',
      userId: pending.userId,
      email: pending.email,
      username: pending.username,
      serverMaterial: new Uint8Array(pending.serverMaterial),
      kekFingerprint: new Uint8Array(pending.kekFingerprint),
    };
  });
}

export interface CompleteRegistrationArgs {
  readonly db: Database;
  readonly store: IdentityUsersStore;
  readonly billingStores: BillingStores;
  readonly verificationStore: IdentityVerificationStore;
  readonly welcomeEmail: WelcomeEmailPort;
  readonly verificationEmail: VerificationEmailPort;
  /** Read only to check the pinned fingerprint against it — never to seal. */
  readonly opaqueKek: OpaqueKek;
  readonly pending: PendingRegistration;
  readonly registrationRecord: number[];
  readonly accountPublicKey: string;
  readonly passwordWrappedPrivateKey: string;
  readonly recoveryWrappedPrivateKey: string;
  readonly recoveryPublicKey: string;
  readonly now: number;
  /** The Terms revision recorded against the account in its settlement. */
  readonly acceptedTermsRevision: number;
  /**
   * The acquisition stamp, already resolved against the live campaigns so the
   * tag the FK sees names a campaign row that exists. Absent when the client
   * sent none.
   */
  readonly acquisition?: AcquisitionStamp | undefined;
}

/** The acquisition row's own values, as the settlement writes them. */
export interface AcquisitionStamp {
  readonly campaign: string;
  readonly platform: Acquisition['platform'];
}

/** `kek-rotated`: the KEK changed between the two rounds; the pinned material cannot be written. */
type CompleteRegistrationOutcome = InsertRegisteredOutcome | { readonly kind: 'kek-rotated' };

/**
 * The account INSERT plus wallet + welcome-credit provisioning, preceded by
 * pure input decoding. Insert and provisioning commit in ONE settlement
 * transaction: a crash between them leaves neither, so
 * a registered user always owns the wallets `requirePurchasedWallet` demands —
 * there is no lazy re-provision path. A racing duplicate resolves to
 * `email-taken` / `username-taken` as a value (the INSERT does no work) and
 * provisioning is skipped. On success, best-effort notifications fire outside
 * the transaction: the welcome email (unconditionally — the greeting is
 * decoupled from whether a promo credit was granted) and the verification
 * token + email — neither can block or fail the 201.
 */
export function completeRegistration(
  args: CompleteRegistrationArgs
): ResultAsync<CompleteRegistrationOutcome, DomainError> {
  if (!kekFingerprintMatches(args.pending.kekFingerprint, args.opaqueKek)) {
    return okAsync<CompleteRegistrationOutcome, DomainError>({ kind: 'kek-rotated' });
  }
  return decodeRegistrationValues(args).asyncAndThen((values) =>
    finalizeRegistration(args, values)
  );
}

function decodeRegistrationValues(
  args: CompleteRegistrationArgs
): Result<RegistrationValues, DomainError> {
  return deserializeRegistrationRecord(args.registrationRecord).andThen((record) =>
    Result.combine([
      decodePublicKeyField(args.accountPublicKey, 'accountPublicKey'),
      decodeWrappedKeyField(args.passwordWrappedPrivateKey, 'passwordWrappedPrivateKey'),
      decodeWrappedKeyField(args.recoveryWrappedPrivateKey, 'recoveryWrappedPrivateKey'),
      decodeRecoveryPublicKeyField(args.recoveryPublicKey),
    ]).map(
      ([
        publicKey,
        passwordWrappedPrivateKey,
        recoveryWrappedPrivateKey,
        recoveryPublicKey,
      ]): RegistrationValues => ({
        id: args.pending.userId,
        email: args.pending.email,
        username: args.pending.username,
        opaqueRegistration: new Uint8Array(record.serialize()),
        opaqueServerMaterial: args.pending.serverMaterial,
        opaqueKekFingerprint: args.pending.kekFingerprint,
        publicKey,
        passwordWrappedPrivateKey,
        recoveryWrappedPrivateKey,
        recoveryPublicKey,
      })
    )
  );
}

function finalizeRegistration(
  args: CompleteRegistrationArgs,
  values: RegistrationValues
): ResultAsync<InsertRegisteredOutcome, DomainError> {
  return fromPromise(runRegistrationSettlement(args, values), (cause) =>
    unavailableError('registration settlement failed', cause)
  ).andThen((outcome) =>
    outcome.kind === 'created'
      ? dispatchRegistrationSideEffects(args).map((): InsertRegisteredOutcome => outcome)
      : okAsync<InsertRegisteredOutcome, DomainError>(outcome)
  );
}

/**
 * Insert then provision, atomically. Provisioning is skipped when the INSERT
 * hit a unique violation — nothing was written, so the transaction commits
 * empty and the caller surfaces the taken outcome.
 */
async function runRegistrationSettlement(
  args: CompleteRegistrationArgs,
  values: RegistrationValues
): Promise<InsertRegisteredOutcome> {
  return runSettlement(args.db, async (tx) => {
    const outcome = await args.store.insertRegisteredWithinTx(tx, values);
    if (outcome.kind === 'created') {
      // Inside the same transaction as the account, so a rolled-back
      // registration leaves no source row and a committed one is never
      // missing its own.
      if (args.acquisition !== undefined) {
        await args.store.insertAcquisitionWithinTx(tx, {
          userId: outcome.userId,
          campaign: args.acquisition.campaign,
          platform: args.acquisition.platform,
        });
      }
      await args.store.insertTermsAcceptanceWithinTx(tx, {
        userId: outcome.userId,
        revision: args.acceptedTermsRevision,
      });
      await provisionWalletsWithinTx(args.billingStores, tx, outcome.userId);
    }
    return outcome;
  });
}

/**
 * Best-effort post-commit notifications for a newly created account: the
 * welcome greeting (always sent — decoupled from promo-credit grant) and the
 * verification token + email. Neither can block or fail the 201.
 */
export function dispatchRegistrationSideEffects(
  args: CompleteRegistrationArgs
): ResultAsync<void, DomainError> {
  const to = args.pending.email;
  const userName = args.pending.username;
  return args.welcomeEmail
    .sendWelcomeEmail({ to, userName })
    .orElse(() => okAsync())
    .andThen(() => issueVerification(args, to, userName));
}

/**
 * Issues a fresh single-use verification token and sends the link, all
 * best-effort: a token-issue or send failure is swallowed so registration
 * still returns 201 (the user can re-request via the resend route).
 */
function issueVerification(
  args: CompleteRegistrationArgs,
  to: string,
  userName: string
): ResultAsync<void, DomainError> {
  const token = crypto.randomUUID();
  const expiresAt = new Date(args.now + EMAIL_VERIFY_TOKEN_TTL_MS);
  return args.verificationStore
    .issueEmailVerification(args.pending.userId, token, expiresAt)
    .andThen(() =>
      args.verificationEmail.sendVerificationEmail({
        to,
        token,
        userName,
        expiresInHours: EMAIL_VERIFY_TOKEN_TTL_MS / HOUR_MS,
      })
    )
    .orElse(() => okAsync());
}

export type RegisterFinishOutcome =
  | { readonly kind: 'no-pending' }
  | { readonly kind: 'existing' }
  | CompleteRegistrationOutcome;

export interface RegisterFinishFlowArgs {
  readonly store: IdentityUsersStore;
  readonly redis: RedisClient;
  readonly secrets: Pick<IdentitySecrets, 'opaqueKek'>;
  readonly db: Database;
  readonly billingStores: BillingStores;
  readonly verificationStore: IdentityVerificationStore;
  readonly welcomeEmail: WelcomeEmailPort;
  readonly verificationEmail: VerificationEmailPort;
  readonly email: string;
  readonly registerSessionId: string;
  readonly registrationRecord: number[];
  readonly accountPublicKey: string;
  readonly passwordWrappedPrivateKey: string;
  readonly recoveryWrappedPrivateKey: string;
  readonly recoveryPublicKey: string;
  readonly now: number;
  readonly acceptedTermsRevision: number;
  /** What the client said about where this signup came from, unvalidated. */
  readonly acquisition?: Acquisition | undefined;
  /** Growth's active-tag read, so an archived or invented tag records as unknown. */
  readonly listActiveTags: () => ResultAsync<readonly string[], DomainError>;
  /** The channel a growth degrade is reported on; registration itself never degrades. */
  readonly logger: Telemetry;
}

/**
 * The acquisition stamp with its campaign resolved against the live tags.
 *
 * It runs BEFORE the settlement, because resolving reads Redis and Postgres
 * and nothing external may happen inside the settlement transaction. A tag no
 * live campaign carries records as `unknown` rather than refusing the signup,
 * and a resolution that cannot be completed records `unknown` too, after one
 * report: the campaign column is a foreign key, so a tag that cannot be proved
 * live would otherwise take the whole registration down with it.
 */
function resolveAcquisitionStamp(
  args: RegisterFinishFlowArgs,
  stamp: Acquisition
): ResultAsync<AcquisitionStamp, DomainError> {
  return resolveCampaignTag({
    redis: args.redis,
    listActiveTags: args.listActiveTags,
    tag: stamp.campaign,
  })
    .orElse(() => {
      args.logger.captureError(
        new Error('signup campaign tag could not be resolved'),
        FINGERPRINT_CODES.growthRegistrationStartUnavailable
      );
      return okAsync<string, DomainError>(GROWTH_UNKNOWN_CAMPAIGN);
    })
    .map((campaign): AcquisitionStamp => ({ campaign, platform: stamp.platform }));
}

/**
 * The register-finish `byEventId` composition (see `OpaqueFinishFlow`):
 * consuming the pending handshake is the first-delivery claim — a replayed
 * finish finds nothing and takes the duplicate path.
 */
export function createRegisterFinishFlow(
  args: RegisterFinishFlowArgs
): OpaqueFinishFlow<RegisterFinishOutcome> {
  let consumed: ConsumePendingRegistrationOutcome = { kind: 'no-pending' };
  return {
    claim: () =>
      consumePendingRegistration({
        redis: args.redis,
        email: args.email,
        registerSessionId: args.registerSessionId,
      }).map((outcome) => {
        consumed = outcome;
        return outcome.kind !== 'no-pending';
      }),
    execute: () => executeRegisterFinish(args, consumed),
    onDuplicate: () => okAsync<RegisterFinishOutcome, DomainError>({ kind: 'no-pending' }),
  };
}

function executeRegisterFinish(
  args: RegisterFinishFlowArgs,
  consumed: ConsumePendingRegistrationOutcome
): ResultAsync<RegisterFinishOutcome, DomainError> {
  if (consumed.kind === 'no-pending') {
    // `execute` runs only for the delivery that won the claim; a
    // no-pending consume can never win it.
    throw new Error('identity: register finish executed without a claimed pending state');
  }
  if (consumed.kind === 'existing') {
    return okAsync<RegisterFinishOutcome, DomainError>({ kind: 'existing' });
  }
  const stamp = args.acquisition;
  if (stamp === undefined) return completeRegistrationFor(args, consumed);
  return resolveAcquisitionStamp(args, stamp).andThen((acquisition) =>
    completeRegistrationFor(args, consumed, acquisition)
  );
}

/** The finish half, with whatever acquisition stamp survived resolution. */
function completeRegistrationFor(
  args: RegisterFinishFlowArgs,
  consumed: PendingRegistration,
  acquisition?: AcquisitionStamp
): ResultAsync<RegisterFinishOutcome, DomainError> {
  return completeRegistration({
    db: args.db,
    store: args.store,
    billingStores: args.billingStores,
    verificationStore: args.verificationStore,
    welcomeEmail: args.welcomeEmail,
    verificationEmail: args.verificationEmail,
    opaqueKek: args.secrets.opaqueKek,
    pending: consumed,
    registrationRecord: args.registrationRecord,
    accountPublicKey: args.accountPublicKey,
    passwordWrappedPrivateKey: args.passwordWrappedPrivateKey,
    recoveryWrappedPrivateKey: args.recoveryWrappedPrivateKey,
    recoveryPublicKey: args.recoveryPublicKey,
    now: args.now,
    acceptedTermsRevision: args.acceptedTermsRevision,
    ...(acquisition === undefined ? {} : { acquisition }),
  });
}
