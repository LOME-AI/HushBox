import { z } from 'zod';
import { fromBase64 } from '@hushbox/shared';
import { devicePlatformEnum } from '@hushbox/db';
import { okAsync } from '../../../lib/result/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ByTransitionParams } from '../../../lib/idempotency/index.js';
import type { DeviceTokenStore } from '../ports/index.js';

export const registerDeviceTokenSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(devicePlatformEnum.enumValues),
});

type RegisterDeviceTokenInput = z.infer<typeof registerDeviceTokenSchema>;

/** RFC 8291: the subscription public key is a 65-byte uncompressed P-256 point. */
const P256DH_BYTES = 65;
/** RFC 8291: the auth secret is 16 bytes. */
const AUTH_BYTES = 16;
/** SEC1 tag byte that marks an uncompressed elliptic-curve point. */
const UNCOMPRESSED_POINT_TAG = 0x04;

const BASE64URL_ALPHABET = /^[A-Za-z0-9_-]+$/;

/** Characters an unpadded base64url encoding of `bytes` bytes occupies. */
function encodedLength(bytes: number): number {
  return Math.ceil((bytes * 4) / 3);
}

/**
 * Decodes base64url key material of exactly `bytes` bytes, or `null`. The
 * character and length checks run first so the decoder — which throws on an
 * out-of-alphabet character or an orphan trailing character — is only ever
 * handed input it can decode.
 */
function decodeFixedLength(value: string, bytes: number): Uint8Array | null {
  const stripped = value.replace(/=+$/, '');
  if (!BASE64URL_ALPHABET.test(stripped) || stripped.length !== encodedLength(bytes)) {
    return null;
  }
  return fromBase64(stripped);
}

/**
 * A browser Web Push subscription: the endpoint URL plus the two encryption
 * keys `PushManager.subscribe` returns. Stored as a `web` device-token row
 * (endpoint in `token`, keys in `p256dh`/`auth`).
 *
 * The key material is validated to its exact RFC 8291 shape here, at the
 * boundary. Both values are load-bearing at send time and neither failure is
 * visible from delivery: a malformed `p256dh` makes encryption throw, which
 * counts as a transient failure and never prunes, and a well-formed but wrong
 * `auth` encrypts and is accepted by the push service, so the row keeps
 * renewing its own liveness clock while the browser can never decrypt.
 * Existing rows predating this check are left to the retention sweep.
 */
export const registerWebSubscriptionSchema = z.strictObject({
  endpoint: z.url().max(2048),
  keys: z.object({
    p256dh: z
      .string()
      .refine(
        (value) => decodeFixedLength(value, P256DH_BYTES)?.[0] === UNCOMPRESSED_POINT_TAG,
        'p256dh must be a base64url 65-byte uncompressed P-256 point'
      ),
    auth: z
      .string()
      .refine(
        (value) => decodeFixedLength(value, AUTH_BYTES) !== null,
        'auth must be a base64url 16-byte secret'
      ),
  }),
});

type RegisterWebSubscriptionInput = z.infer<typeof registerWebSubscriptionSchema>;

/**
 * One `INSERT … ON CONFLICT` through the store — the token unique constraint
 * arbitrates duplicates (`idempotent.byUpsert` at the route seam).
 */
export function registerDeviceToken(
  store: DeviceTokenStore,
  userId: string,
  input: RegisterDeviceTokenInput
): ResultAsync<void, DomainError> {
  return store.upsert({ userId, token: input.token, platform: input.platform });
}

/**
 * Registers a browser Web Push subscription for the owning user as a `web`
 * device-token row, keyed by its endpoint (the token unique constraint is the
 * `idempotent.byUpsert` guard — re-subscribing converges on one row).
 */
export function registerWebSubscription(
  store: DeviceTokenStore,
  userId: string,
  input: RegisterWebSubscriptionInput
): ResultAsync<void, DomainError> {
  return store.upsert({
    userId,
    token: input.endpoint,
    platform: 'web',
    p256dh: input.keys.p256dh,
    auth: input.keys.auth,
  });
}

/**
 * The `idempotent.byTransition` contract for unregistration: the conditional
 * DELETE either wins (`true`) or matched nothing (`null`), and zero rows
 * disambiguates to the already-deleted no-op (`false`) — repeating the call
 * converges on the same absent end-state.
 */
export function unregisterDeviceToken(
  store: DeviceTokenStore,
  userId: string,
  token: string
): ByTransitionParams<boolean, DomainError> {
  return {
    transition: () => store.deleteByToken(userId, token),
    onZeroRows: () => okAsync(false),
  };
}
