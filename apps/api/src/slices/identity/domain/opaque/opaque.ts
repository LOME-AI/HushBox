import { z } from 'zod';
import {
  OPAQUE_SERVER_IDENTIFIER,
  OpaqueKE1,
  OpaqueRegistrationRecord,
  OpaqueServerConfig,
  OpaqueServerRegistrationRequest,
  createOpaqueServer,
  deriveOpaqueKek,
  mintServerMaterial,
  opaqueKekFingerprint,
  sealServerMaterial,
} from '@hushbox/crypto';
import { textEncoder } from '@hushbox/shared';
import { Result, fromPromise } from '../../../../lib/result/index.js';
import { validationError } from '../../../../lib/errors/index.js';
import type { OpaqueKek } from '@hushbox/crypto';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { Bindings } from '../../../../lib/context/index.js';

/**
 * Upper bound on the length of every OPAQUE wire array a client may post. The
 * serialized messages are fixed, small sizes, so this caps parse cost against
 * an oversized array without touching a legitimate handshake. Those sizes
 * differ per message, so tightening this takes the largest of them, not the
 * one in front of you.
 */
export const MAX_KE_ARRAY_LENGTH = 1024;

/**
 * The one schema for every OPAQUE wire array. These fields are bytes, so a
 * value outside `[0,255]` or a fractional one is rejected at the boundary
 * rather than reaching a codec that would read it as a byte.
 */
export function opaqueByteArray(max: number): z.ZodArray<z.ZodNumber> {
  return z.array(z.number().int().min(0).max(255)).min(1).max(max);
}

/**
 * The OPAQUE wire deserializers throw on malformed bytes; malformed bytes
 * are expected external input (any client can post junk), so each codec is
 * wrapped into the typed `validation` channel here — a deserialize throw
 * must never surface as a 500 defect.
 */
function codec<T>(
  deserialize: (bytes: number[]) => T,
  what: string
): (bytes: number[]) => Result<T, DomainError> {
  return (bytes: number[]): Result<T, DomainError> =>
    Result.fromThrowable(
      () => deserialize(bytes),
      (cause) => validationError(`malformed OPAQUE ${what}`, cause)
    )();
}

export const deserializeRegistrationRequest = codec(
  (bytes) => OpaqueServerRegistrationRequest.deserialize(OpaqueServerConfig, bytes),
  'registration request'
);

export const deserializeRegistrationRecord = codec(
  (bytes) => OpaqueRegistrationRecord.deserialize(OpaqueServerConfig, bytes),
  'registration record'
);

export const deserializeKe1 = codec(
  (bytes) => OpaqueKE1.deserialize(OpaqueServerConfig, bytes),
  'KE1'
);

/**
 * The `@cloudflare/opaque-ts` server APIs report protocol failures as Error
 * VALUES, not rejections. Unwrapping through this guard converts them into
 * throws so the surrounding `fromPromise` maps them into the typed
 * validation channel — without it, an Error value would flow onward as a
 * success and be serialized into pending state.
 */
export function throwIfOpaqueError<T>(result: T | Error): T {
  if (result instanceof Error) throw result;
  return result;
}

/**
 * Rejection mapper for the OPAQUE server calls: protocol rejections are
 * client input (any client can post junk), so they land in the typed
 * `validation` channel, never as 500 defects.
 */
export function opaqueProtocolError(what: string): (cause: unknown) => DomainError {
  return (cause: unknown): DomainError => validationError(what, cause);
}

/**
 * What a new-password init round produces and its finish round writes: the
 * registerInit response for the client, and the freshly minted server material
 * the response was computed on, already sealed under the KEK with the KEK's
 * fingerprint. The finish round writes exactly these bytes — it never re-reads
 * the KEK — so a key swap between the two rounds can only refuse, never stamp
 * a record with material it was not produced under.
 */
export interface NewPasswordInit {
  readonly registrationResponse: number[];
  readonly serverMaterial: Uint8Array;
  readonly kekFingerprint: Uint8Array;
}

/**
 * Round one of a new password bound to the given credential identifier — the
 * half shared by the password-change and recovery-reset flows (registration
 * mints its own id and rides its own pending state, so it keeps a separate
 * composition). Fresh material every time: a password change also retires the
 * user's previous AKE key.
 */
export function runNewPasswordRegisterInit(
  kek: OpaqueKek,
  credentialIdentifier: string,
  request: OpaqueServerRegistrationRequest
): ResultAsync<NewPasswordInit, DomainError> {
  return fromPromise(
    (async (): Promise<NewPasswordInit> => {
      const material = await mintServerMaterial();
      const server = createOpaqueServer(material, OPAQUE_SERVER_IDENTIFIER);
      const response = throwIfOpaqueError(await server.registerInit(request, credentialIdentifier));
      return {
        registrationResponse: response.serialize(),
        serverMaterial: sealServerMaterial(kek, credentialIdentifier, material),
        kekFingerprint: opaqueKekFingerprint(kek),
      };
    })(),
    opaqueProtocolError('OPAQUE registerInit rejected the new registration request')
  );
}

/**
 * The claim/execute/duplicate triple an `opaque-protocol` route composes
 * into `idempotent.byEventId`: the handshake id is the event id, and the
 * single-use consume of the pending Redis state — an atomic GETDEL, so
 * exactly one concurrent delivery wins it — is the first-delivery claim.
 */
export interface OpaqueFinishFlow<TOutcome> {
  readonly claim: () => ResultAsync<boolean, DomainError>;
  readonly execute: () => ResultAsync<TOutcome, DomainError>;
  readonly onDuplicate: () => ResultAsync<TOutcome, DomainError>;
}

/**
 * The `opaque-protocol` init rounds mint the event id (the handshake id)
 * server-side inside the mutation — a fresh uuid per request — so the first
 * delivery wins the `byEventId` claim by construction and a duplicate
 * delivery cannot occur; reaching this is a defect, never a client outcome.
 */
export function duplicateFreshHandshakeDefect(): never {
  throw new Error('identity: duplicate byEventId claim on a server-minted handshake id');
}

/**
 * The three secrets the identity slice's flows draw on, resolved once per
 * request from the bindings. Each has its own lifecycle, so none is derived
 * from another: the KEK seals every user's OPAQUE server material, the TOTP
 * secret seals stored second factors, and the decoy secret derives the fake
 * record and recovery dummies served to unknown identifiers.
 */
export interface IdentitySecrets {
  readonly opaqueKek: OpaqueKek;
  readonly totpEncryptionSecret: Uint8Array;
  readonly enumerationDecoySecret: Uint8Array;
}

type IdentitySecretBinding = 'OPAQUE_KEK' | 'TOTP_ENCRYPTION_SECRET' | 'ENUMERATION_DECOY_SECRET';

/**
 * Slice-owned fail-fast for the bindings the pipeline's required-bindings gate
 * deliberately does not cover (surfaces that never touch OPAQUE — and their
 * test environments — don't carry them). Missing here is a deployment
 * misconfiguration: a thrown defect, never a degraded auth path.
 */
function requireIdentityBinding<TName extends IdentitySecretBinding>(
  env: Pick<Bindings, TName>,
  name: TName
): string {
  const secret: string | undefined = env[name];
  if (secret === undefined || secret === '') {
    throw new Error(
      `identity: missing required binding ${name}. ` +
        'Set it in wrangler config / .dev.vars — auth fails fast instead of degrading.'
    );
  }
  return secret;
}

export function requireOpaqueKek(env: Pick<Bindings, 'OPAQUE_KEK'>): string {
  return requireIdentityBinding(env, 'OPAQUE_KEK');
}

export function requireTotpEncryptionSecret(env: Pick<Bindings, 'TOTP_ENCRYPTION_SECRET'>): string {
  return requireIdentityBinding(env, 'TOTP_ENCRYPTION_SECRET');
}

export function requireEnumerationDecoySecret(
  env: Pick<Bindings, 'ENUMERATION_DECOY_SECRET'>
): string {
  return requireIdentityBinding(env, 'ENUMERATION_DECOY_SECRET');
}

/**
 * Whether the fingerprint a flow pinned at its init round names the KEK this
 * request holds. Both are non-secret, so a plain comparison is the right one.
 */
export function kekFingerprintMatches(pinned: Uint8Array, kek: OpaqueKek): boolean {
  const live = opaqueKekFingerprint(kek);
  return pinned.length === live.length && pinned.every((byte, index) => byte === live[index]);
}

export function identitySecretsFromEnv(
  env: Pick<Bindings, 'OPAQUE_KEK' | 'TOTP_ENCRYPTION_SECRET' | 'ENUMERATION_DECOY_SECRET'>
): IdentitySecrets {
  return {
    opaqueKek: deriveOpaqueKek(textEncoder.encode(requireOpaqueKek(env))),
    totpEncryptionSecret: textEncoder.encode(requireTotpEncryptionSecret(env)),
    enumerationDecoySecret: textEncoder.encode(requireEnumerationDecoySecret(env)),
  };
}
