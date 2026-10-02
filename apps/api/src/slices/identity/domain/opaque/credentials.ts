import { redisSet } from '../../../../lib/redis/index.js';
import { okAsync } from '../../../../lib/result/index.js';
import { decodeWrappedKeyField } from '../guards.js';
import { IDENTITY_KEYS } from '../keys.js';
import { deserializeRegistrationRecord, kekFingerprintMatches } from './opaque.js';
import { evictUserBestEffort } from '../session/session.js';
import type { OpaqueKek } from '@hushbox/crypto';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { EvictUserPort, IdentityUsersStore } from '../../ports/index.js';
import type { RedisClient } from '../keys.js';

/**
 * The best-effort security notice dispatched after a credential rotation
 * commits. Injected so the shared rotate helper stays agnostic to which notice
 * it sends: a password change sends the "changed" notification, a
 * recovery-phrase reset the distinct "reset" one.
 */
type CredentialRotationNotice = (args: {
  readonly to: string;
  readonly userName?: string;
}) => ResultAsync<void, DomainError>;

interface RotateCredentialsArgs {
  readonly redis: RedisClient;
  readonly store: IdentityUsersStore;
  readonly notify: CredentialRotationNotice;
  readonly logger: Telemetry;
  readonly userId: string;
  /** Read only to check the pinned fingerprint against it — never to seal. */
  readonly opaqueKek: OpaqueKek;
  /** The record the flow observed at init; the store compare-and-swaps on it. */
  readonly observedRegistration: Uint8Array;
  /** The init round's pin: the material the new record was produced on, sealed, and its KEK fingerprint. */
  readonly serverMaterial: Uint8Array;
  readonly kekFingerprint: Uint8Array;
  readonly newRegistrationRecord: number[];
  readonly newPasswordWrappedPrivateKey: string;
  readonly now: number;
  /**
   * Realtime eviction fan-out, invoked best-effort after the pw-changed
   * watermark stales the user's sessions. Optional: absent until the worker
   * wires it (ARCHITECTURE §Streaming & realtime).
   */
  readonly evictUser?: EvictUserPort;
}

/**
 * `kek-rotated`: the KEK changed between the flow's rounds, so the pinned
 * material cannot be written. `credential-conflict`: the stored record was no
 * longer the observed one — a racing rotation won — and nothing was written.
 */
type RotateCredentialsOutcome = 'rotated' | 'kek-rotated' | 'credential-conflict';

/**
 * Rotates the OPAQUE record, the password-wrapped key and the sealed server
 * material in one compare-and-swap store update, then stamps the pw-changed
 * watermark staling every session issued before now — the shared back half of
 * a password change and a recovery reset. Both refusals are typed values the
 * client shows: the losing client has already persisted an export key that no
 * longer opens the stored wrap, so a silent success would strand it.
 *
 * The revocation watermark lands in Redis only after the rotate commits, and
 * a watermark failure propagates: the request errors even though the store
 * already rotated — accepted, because the security notification must never
 * outrun session staling. Only the tail is best-effort: the realtime eviction
 * fan-out (which closes the staled sessions' live sockets) then the
 * password-changed notification (recipient lookup + send).
 */
export function rotatePasswordCredentials(
  args: RotateCredentialsArgs
): ResultAsync<RotateCredentialsOutcome, DomainError> {
  if (!kekFingerprintMatches(args.kekFingerprint, args.opaqueKek)) {
    return okAsync<RotateCredentialsOutcome, DomainError>('kek-rotated');
  }
  return deserializeRegistrationRecord(args.newRegistrationRecord)
    .andThen((record) =>
      decodeWrappedKeyField(args.newPasswordWrappedPrivateKey, 'newPasswordWrappedPrivateKey').map(
        (wrapped) => ({ recordBytes: new Uint8Array(record.serialize()), wrapped })
      )
    )
    .asyncAndThen((decoded) =>
      args.store.rotatePassword({
        userId: args.userId,
        observedRegistration: args.observedRegistration,
        opaqueRegistration: decoded.recordBytes,
        passwordWrappedPrivateKey: decoded.wrapped,
        opaqueServerMaterial: args.serverMaterial,
        opaqueKekFingerprint: args.kekFingerprint,
      })
    )
    .andThen((outcome) =>
      outcome === 'conflict'
        ? okAsync<RotateCredentialsOutcome, DomainError>('credential-conflict')
        : staleSessionsAndNotify(args)
    );
}

function staleSessionsAndNotify(
  args: RotateCredentialsArgs
): ResultAsync<RotateCredentialsOutcome, DomainError> {
  return redisSet(args.redis, IDENTITY_KEYS.passwordChangedAt, args.now, args.userId)
    .andThen(() => evictUserBestEffort(args.evictUser, args.userId))
    .andThen(() => notifyCredentialRotation(args))
    .map((): RotateCredentialsOutcome => 'rotated');
}

/**
 * The credential-rotation security notification, dispatched only after the
 * rotation (and its revocation watermark) committed. Best-effort end to end:
 * neither a lookup nor a send failure fails a rotation the store already
 * committed. A failed recipient lookup is warned here (code only, never the
 * address); send-failure observability lives with the adapter behind the
 * injected notice.
 */
function notifyCredentialRotation(args: RotateCredentialsArgs): ResultAsync<void, DomainError> {
  return args.store
    .findById(args.userId)
    .orElse((error) => {
      args.logger.warn('credential-rotation email recipient lookup failed', {
        errorCode: error.code,
      });
      return okAsync(null);
    })
    .andThen((user) =>
      user === null ? okAsync() : args.notify({ to: user.email, userName: user.username })
    )
    .orElse(() => okAsync());
}
