import { z } from 'zod';
import {
  KEY_BYTES,
  RESET_CHALLENGE_NONCE_BYTES,
  asServerSecret,
  asWrappingPublicKey,
  deriveDummyRecoveryPublicKey,
  deriveDummyRecoveryWrappedKey,
  sealResetChallenge,
  verifyResetProof,
} from '@hushbox/crypto';
import { canonicalIdentifier, fromBase64, toBase64 } from '@hushbox/shared';
import { Result, ResultAsync, errAsync, okAsync } from '../../../../lib/result/index.js';
import { redisGetDel, redisSet } from '../../../../lib/redis/index.js';
import { rotatePasswordCredentials } from '../opaque/credentials.js';
import {
  decodeBase64Field,
  decodeRecoveryPublicKeyField,
  decodeWrappedKeyField,
  getReferenceWrappedKey,
} from '../guards.js';
import { consumeLayers } from '../../../../lib/rate-limit/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { IDENTITY_KEYS, recoveryNetworkLockoutId } from '../keys.js';
import {
  MAX_KE_ARRAY_LENGTH,
  deserializeRegistrationRequest,
  opaqueByteArray,
  runNewPasswordRegisterInit,
} from '../opaque/opaque.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type {
  EvictUserPort,
  IdentityUserRecord,
  IdentityUsersStore,
  PasswordResetEmailPort,
} from '../../ports/index.js';
import type { WrappingPublicKey } from '@hushbox/crypto';
import type { IdentitySecrets, OpaqueFinishFlow } from '../opaque/opaque.js';
import type { RedisClient } from '../keys.js';

export const recoveryGetKeyBodySchema = z.object({
  identifier: z.string().min(1).max(254),
});

export const recoveryResetInitBodySchema = z.object({
  identifier: z.string().min(1).max(254),
  newRegistrationRequest: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
});

export const recoveryResetFinishBodySchema = z.object({
  identifier: z.string().min(1).max(254),
  newRegistrationRecord: opaqueByteArray(MAX_KE_ARRAY_LENGTH),
  newPasswordWrappedPrivateKey: z.string().min(1),
  recoverySessionId: z.uuid(),
  /** Base64 proof that the caller opened the sealed challenge — the phrase gate. */
  resetProof: z.string().min(1),
});

/**
 * Deterministic per-identifier dummy for unknown accounts on the public
 * wrapped-key endpoint — the enumeration-safe defense. The derivation (HKDF
 * over the server secret, bound to the canonical identifier, format-tracked
 * against the reference blob) lives in `@hushbox/crypto` so it can never drift
 * from the audited byte layout.
 */
function dummyWrappedKey(decoySecret: Uint8Array, canonicalId: string): Uint8Array {
  return deriveDummyRecoveryWrappedKey(
    asServerSecret(decoySecret),
    canonicalId,
    getReferenceWrappedKey()
  );
}

function lookup(
  store: IdentityUsersStore,
  identifier: string
): ResultAsync<IdentityUserRecord | null, DomainError> {
  const canonical = canonicalIdentifier(identifier);
  return identifier.includes('@') ? store.findByEmail(canonical) : store.findByUsername(canonical);
}

/**
 * What each recovery round's per-network window counts: the identifier the
 * caller named, composited with the network it named it from.
 *
 * A caller whose network did not resolve is refused here rather than keyed on
 * a sentinel: one window shared by every caller behind an edge fault caps the
 * whole fault at one caller's allowance, which is the denial channel the
 * per-network layer exists to close. The refusal is the generic `unavailable`
 * and never the limiter's own wire code — that code is the money guard's proof
 * that a card charge was never dispatched, and the arch rule
 * `money-guard-codes-come-from-the-pipeline` keeps it inside the pipeline stage
 * for exactly that reason.
 *
 * Shared by both rounds, which is as far as sharing goes: each round names its
 * own two entries at its own {@link consumeLayers} call, because the citation
 * walk in `whole-app/app-flow-counter-citations.test.ts` attributes an entry to
 * a route by reading the expression that names it, and an entry reaching the
 * primitive through a parameter is one no route's citation can be checked
 * against.
 */
function recoveryNetworkId(
  canonical: string,
  callerNetworkId: string | null
): ResultAsync<string, DomainError> {
  if (callerNetworkId === null) {
    return errAsync<string, DomainError>(
      unavailableError('recovery lockout has no caller network to key on')
    );
  }
  return ResultAsync.fromSafePromise(recoveryNetworkLockoutId(canonical, callerNetworkId));
}

export interface RecoveryGetKeyArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly secrets: Pick<IdentitySecrets, 'enumerationDecoySecret'>;
  readonly identifier: string;
  /**
   * The caller's network identity, half of what the per-network lockout counts,
   * or null where production carried no address to derive one from (see
   * {@link recoveryNetworkId}).
   */
  readonly callerNetworkId: string | null;
}

export type RecoveryGetKeyOutcome =
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  | { readonly kind: 'ok'; readonly recoveryWrappedPrivateKey: string };

/**
 * Enumeration-safe wrapped-key retrieval: a known account returns its stored
 * recovery-wrapped key; an unknown one returns a fixed-length dummy of the
 * same response shape, so neither the status nor the body distinguishes the
 * two. The recovery phrase never reaches the server — the client rewraps
 * locally with the returned blob.
 *
 * The returned blob is offline-attackable ciphertext, so retrieval is a
 * secret-guessing surface: the attempt is reserved BEFORE the lookup, in one
 * atomic check that admits at most each window's cap even under concurrency.
 * The lockout wraps OUTSIDE the enumeration-safe body — known and unknown
 * identifiers share one code path from here down, so the limiter adds no
 * distinguisher.
 *
 * That budget is spent by anyone who can NAME the identifier, which is the
 * other half of the reasoning: a reservation spent before anything is looked
 * up is also a DENIAL lever, and a budget one address can drain is a way to
 * hold an account out of recovery — the route its owner reaches for when
 * already locked out of login. The bound is therefore two windows in one
 * all-or-nothing check: what one network may spend, and what the identifier may
 * spend across every network. Two calls could not express that — a refusal on
 * the second would leave the first's increment standing, so an attacker's
 * REFUSED requests would drain the sibling window.
 */
export function getRecoveryWrappedKey(
  args: RecoveryGetKeyArgs
): ResultAsync<RecoveryGetKeyOutcome, DomainError> {
  const canonical = canonicalIdentifier(args.identifier);
  return recoveryNetworkId(canonical, args.callerNetworkId)
    .andThen((networkKeyedId) =>
      consumeLayers(args.redis, [
        { definition: IDENTITY_KEYS.recoveryGetKeyLockout, id: canonical },
        { definition: IDENTITY_KEYS.recoveryGetKeyLockoutPerNetwork, id: networkKeyedId },
      ])
    )
    .andThen((decision) => {
      if (!decision.allowed) {
        return okAsync<RecoveryGetKeyOutcome, DomainError>({
          kind: 'rate-limited',
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
      return lookup(args.store, args.identifier).andThen((user) => {
        const bytes =
          user === null
            ? okAsync<Uint8Array, DomainError>(
                dummyWrappedKey(args.secrets.enumerationDecoySecret, canonical)
              )
            : okAsync<Uint8Array, DomainError>(user.recoveryWrappedPrivateKey);
        return bytes.map(
          (blob): RecoveryGetKeyOutcome => ({
            kind: 'ok',
            recoveryWrappedPrivateKey: toBase64(blob),
          })
        );
      });
    });
}

export interface SaveRecoveryKeyArgs {
  readonly store: IdentityUsersStore;
  readonly userId: string;
  readonly recoveryWrappedPrivateKey: string;
  readonly recoveryPublicKey: string;
}

/**
 * Persists the client's recovery-wrapped private key and flags the recovery
 * phrase acknowledged. The write is a convergent UPDATE — safe to replay, so
 * the route composes it under `idempotent.byUpsert`. A malformed base64 body
 * is a validation Result (400), never a partial write.
 *
 * Blob and public key are two halves of one phrase's keypair and are decoded
 * together, so a malformed half rejects both: storing one against the other's
 * phrase leaves an account whose reset challenge no phrase can open.
 */
export function saveRecoveryKey(args: SaveRecoveryKeyArgs): ResultAsync<void, DomainError> {
  return Result.combine([
    decodeWrappedKeyField(args.recoveryWrappedPrivateKey, 'recoveryWrappedPrivateKey'),
    decodeRecoveryPublicKeyField(args.recoveryPublicKey),
  ]).asyncAndThen(([wrappedPrivateKey, publicKey]) =>
    args.store.saveRecoveryKey(args.userId, wrappedPrivateKey, publicKey)
  );
}

export interface RecoveryResetInitArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly secrets: Pick<IdentitySecrets, 'opaqueKek' | 'enumerationDecoySecret'>;
  readonly identifier: string;
  readonly newRegistrationRequest: number[];
  /** The caller's network identity (see {@link RecoveryGetKeyArgs}). */
  readonly callerNetworkId: string | null;
}

export type RecoveryResetInitOutcome =
  | { readonly kind: 'rate-limited'; readonly retryAfterSeconds: number }
  | {
      readonly kind: 'started';
      readonly newRegistrationResponse: number[];
      readonly recoverySessionId: string;
      /** Base64 challenge only the recovery phrase's private half can open. */
      readonly sealedChallenge: string;
    };

/**
 * Round one of a recovery reset: the layered attempt reservation (the atomic
 * increment gates BEFORE anything runs — a secret-guessing surface, and a
 * denial lever anyone who can name the identifier could otherwise pull from
 * one address), then a new-password
 * registerInit against the account's id when known, or a throwaway id when
 * not — the response shape and stored pending state are identical either way,
 * so nothing distinguishes a real identifier from an unknown one.
 */
export function startRecoveryReset(
  args: RecoveryResetInitArgs
): ResultAsync<RecoveryResetInitOutcome, DomainError> {
  const canonical = canonicalIdentifier(args.identifier);
  return recoveryNetworkId(canonical, args.callerNetworkId)
    .andThen((networkKeyedId) =>
      consumeLayers(args.redis, [
        { definition: IDENTITY_KEYS.recoveryResetLockout, id: canonical },
        { definition: IDENTITY_KEYS.recoveryResetLockoutPerNetwork, id: networkKeyedId },
      ])
    )
    .andThen((decision) => {
      if (!decision.allowed) {
        return okAsync<RecoveryResetInitOutcome, DomainError>({
          kind: 'rate-limited',
          retryAfterSeconds: decision.retryAfterSeconds,
        });
      }
      return lookup(args.store, args.identifier).andThen((user) =>
        beginReset(args, user, canonical)
      );
    });
}

/**
 * The recipient the challenge is sealed to: the account's stored recovery
 * public key, or — for an unknown identifier — a decoy derived from the server
 * secret, so the response is a genuine wrap either way and distinguishes
 * nothing. A key of any other length cannot be an X25519 recipient at all, so
 * it takes the decoy too: on a public route an unusable stored key must fail
 * the reset closed rather than become a 500 and an existence oracle.
 */
function challengeRecipient(
  decoySecret: Uint8Array,
  canonical: string,
  storedPublicKey: Uint8Array | undefined
): WrappingPublicKey {
  return asWrappingPublicKey(
    storedPublicKey?.length === KEY_BYTES
      ? storedPublicKey
      : deriveDummyRecoveryPublicKey(asServerSecret(decoySecret), canonical)
  );
}

function beginReset(
  args: RecoveryResetInitArgs,
  user: IdentityUserRecord | null,
  canonical: string
): ResultAsync<RecoveryResetInitOutcome, DomainError> {
  return deserializeRegistrationRequest(args.newRegistrationRequest)
    .asyncAndThen((request) =>
      runNewPasswordRegisterInit(args.secrets.opaqueKek, user?.id ?? crypto.randomUUID(), request)
    )
    .andThen((init) => {
      const nonce = crypto.getRandomValues(new Uint8Array(RESET_CHALLENGE_NONCE_BYTES));
      const sealedChallenge = sealResetChallenge(
        challengeRecipient(args.secrets.enumerationDecoySecret, canonical, user?.recoveryPublicKey),
        nonce
      );
      const recoverySessionId = crypto.randomUUID();
      return redisSet(
        args.redis,
        IDENTITY_KEYS.opaquePendingRecoveryReset,
        {
          identifier: canonical,
          nonce: toBase64(nonce),
          serverMaterial: [...init.serverMaterial],
          kekFingerprint: [...init.kekFingerprint],
        },
        recoverySessionId
      ).map(
        (): RecoveryResetInitOutcome => ({
          kind: 'started',
          newRegistrationResponse: init.registrationResponse,
          recoverySessionId,
          sealedChallenge: toBase64(sealedChallenge),
        })
      );
    });
}

export interface RecoveryResetFinishArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly secrets: Pick<IdentitySecrets, 'opaqueKek'>;
  readonly emailPort: PasswordResetEmailPort;
  readonly logger: Telemetry;
  readonly identifier: string;
  readonly newRegistrationRecord: number[];
  readonly newPasswordWrappedPrivateKey: string;
  readonly recoverySessionId: string;
  /** Base64 proof derived from the challenge nonce over this exact request. */
  readonly resetProof: string;
  readonly now: number;
  /**
   * Realtime eviction fan-out, forwarded to `rotatePasswordCredentials` so the
   * reset's staled sessions have their live sockets closed best-effort.
   * Optional: absent until the worker wires it (ARCHITECTURE §Streaming & realtime).
   */
  readonly evictUser?: EvictUserPort;
}

export type RecoveryResetOutcome =
  | { readonly kind: 'no-pending' }
  | { readonly kind: 'reset' }
  | { readonly kind: 'kek-rotated' }
  | { readonly kind: 'credential-conflict' };

/**
 * The pending handshake the claim consumes: the identifier, its single-use
 * nonce, and the init round's pin — the sealed material the new record was
 * produced on and the KEK fingerprint it was sealed under.
 */
interface PendingReset {
  readonly identifier: string;
  readonly nonce: string;
  readonly serverMaterial: number[];
  readonly kekFingerprint: number[];
}

/**
 * Round two: consuming the pending handshake (atomic GETDEL) is the
 * first-delivery claim. A mismatched identifier, an unproven phrase and a
 * vanished account all collapse onto `no-pending`, so a replay, a stolen
 * handshake id and an unknown account reveal nothing and are indistinguishable
 * from each other. On success the OPAQUE record + wrapped key are rotated and
 * the pw-changed watermark stales every prior session. The rotation is a
 * compare-and-swap on the record read here, just before the write: a reset
 * racing another rotation loses with a typed conflict rather than overwriting.
 */
export function createRecoveryResetFinishFlow(
  args: RecoveryResetFinishArgs
): OpaqueFinishFlow<RecoveryResetOutcome> {
  let pending: PendingReset | null = null;
  return {
    claim: () =>
      redisGetDel(args.redis, IDENTITY_KEYS.opaquePendingRecoveryReset, args.recoverySessionId).map(
        (state) => {
          pending = state;
          return state !== null;
        }
      ),
    execute: () => executeReset(args, pending),
    onDuplicate: () => okAsync<RecoveryResetOutcome, DomainError>({ kind: 'no-pending' }),
  };
}

/**
 * The phrase gate. The proof is recomputed from the nonce carried by the
 * handshake the claim just consumed and compared in constant time, so a wrong
 * proof has already burned the nonce by the time it is judged — there is no
 * live challenge left to guess against, and a retry costs a fresh `/init`,
 * which the reset reservation counts.
 */
function proofHolds(
  args: RecoveryResetFinishArgs,
  pending: PendingReset,
  canonical: string,
  proof: Uint8Array
): boolean {
  return verifyResetProof(
    fromBase64(pending.nonce),
    {
      recoverySessionId: args.recoverySessionId,
      canonicalIdentifier: canonical,
      newRegistrationRecord: Uint8Array.from(args.newRegistrationRecord),
      newPasswordWrappedPrivateKey: args.newPasswordWrappedPrivateKey,
    },
    proof
  );
}

function executeReset(
  args: RecoveryResetFinishArgs,
  pending: PendingReset | null
): ResultAsync<RecoveryResetOutcome, DomainError> {
  if (pending === null) {
    throw new Error('identity: recovery reset executed without a claimed handshake');
  }
  const canonical = canonicalIdentifier(args.identifier);
  return decodeBase64Field(args.resetProof, 'resetProof').asyncAndThen((proof) => {
    if (pending.identifier !== canonical || !proofHolds(args, pending, canonical, proof)) {
      return okAsync<RecoveryResetOutcome, DomainError>({ kind: 'no-pending' });
    }
    return lookup(args.store, args.identifier).andThen((user) => {
      if (user === null) return okAsync<RecoveryResetOutcome, DomainError>({ kind: 'no-pending' });
      return rotatePasswordCredentials({
        ...args,
        userId: user.id,
        opaqueKek: args.secrets.opaqueKek,
        observedRegistration: user.opaqueRegistration,
        serverMaterial: new Uint8Array(pending.serverMaterial),
        kekFingerprint: new Uint8Array(pending.kekFingerprint),
        notify: (notice) => args.emailPort.sendPasswordResetEmail(notice),
      }).map(
        (outcome): RecoveryResetOutcome => ({ kind: outcome === 'rotated' ? 'reset' : outcome })
      );
    });
  });
}
