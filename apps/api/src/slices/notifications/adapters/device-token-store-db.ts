import { and, desc, eq, inArray, notInArray, or } from 'drizzle-orm';
import { deviceTokens } from '@hushbox/db';
import { errAsync, fromPromise, okAsync } from '../../../lib/result/index.js';
import { conflictError, unavailableError } from '../../../lib/errors/index.js';
import type { Database } from '@hushbox/db';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type {
  DeviceTokenRegistration,
  DeviceTokenStore,
  PushDeviceRef,
  PushRecipient,
} from '../ports/index.js';

/**
 * The ceiling on `device_tokens` rows one user may hold. Push fan-out width is
 * members times devices, so an uncapped row count leaves that width in the
 * users' hands; the cap turns it into a bound. Set well clear of any real
 * multi-device user — a handset, a tablet, and one row per browser profile,
 * which a subscription change replaces — so eviction reaches only rows a
 * device has stopped renewing.
 */
export const MAX_DEVICE_TOKENS_PER_USER = 20;

/**
 * The `device_tokens` single-writer. Error messages never carry the token
 * value or a subscription endpoint — both are credentials. A `web` row stores
 * the Web Push endpoint in `token` and its keys in `p256dh`/`auth`; native
 * rows leave the key columns null (the DB CHECK binds key presence to `web`).
 */
export function createDeviceTokenStore(db: Database): DeviceTokenStore {
  /**
   * Trims the caller back to the cap by dropping its least recently seen rows.
   * Registration never fails on the cap — it is a path a user cannot retry
   * from — so the newest registration always survives; `lastSeenAt` ties break
   * on the time-ordered id, and the row just written is the newest on both.
   */
  const evictOverCap = (userId: string): ResultAsync<void, DomainError> => {
    const keep = db
      .select({ id: deviceTokens.id })
      .from(deviceTokens)
      .where(eq(deviceTokens.userId, userId))
      .orderBy(desc(deviceTokens.lastSeenAt), desc(deviceTokens.id))
      .limit(MAX_DEVICE_TOKENS_PER_USER);
    return fromPromise(
      db
        .delete(deviceTokens)
        .where(and(eq(deviceTokens.userId, userId), notInArray(deviceTokens.id, keep))),
      (cause) => unavailableError('device-token cap eviction failed', cause)
    ).map((): void => undefined);
  };

  return {
    upsert(registration: DeviceTokenRegistration): ResultAsync<void, DomainError> {
      const p256dh = registration.p256dh ?? null;
      const auth = registration.auth ?? null;
      return fromPromise(
        db
          .insert(deviceTokens)
          .values({
            userId: registration.userId,
            token: registration.token,
            platform: registration.platform,
            p256dh,
            auth,
          })
          .onConflictDoUpdate({
            target: deviceTokens.token,
            // The ownership predicate every other operation on this table
            // already carries. Without it any authenticated caller could claim
            // a token it merely knows, and the victim's device would keep
            // receiving pushes it can no longer decrypt. A device
            // re-registering its own token arrives under the same userId, so
            // the legitimate case still converges on the one row; a row held
            // by someone else matches nothing and the insert reports zero rows.
            setWhere: eq(deviceTokens.userId, registration.userId),
            set: {
              // Necessarily the caller's own id under the predicate above, and
              // written anyway so the SET states the whole row a
              // re-registration converges on rather than a subset of it.
              userId: registration.userId,
              platform: registration.platform,
              p256dh,
              auth,
              updatedAt: new Date(),
              // Re-registration is proof of life: it must advance the
              // retention clock, or an app that re-registers on every launch
              // still ages out of `device_tokens`.
              lastSeenAt: new Date(),
            },
          })
          .returning({ id: deviceTokens.id }),
        (cause) => unavailableError('device-token upsert failed', cause)
      ).andThen((rows) => {
        if (rows.length === 0) {
          // Deliberately says nothing about who holds it: the token is a
          // credential and the caller learns only that this one is taken.
          return errAsync(conflictError('device token is registered to another account'));
        }
        return evictOverCap(registration.userId);
      });
    },

    deleteByToken(userId: string, token: string): ResultAsync<true | null, DomainError> {
      return fromPromise(
        db
          .delete(deviceTokens)
          .where(and(eq(deviceTokens.userId, userId), eq(deviceTokens.token, token)))
          .returning({ id: deviceTokens.id }),
        (cause) => unavailableError('device-token delete failed', cause)
      ).map((rows) => (rows.length > 0 ? true : null));
    },

    listTokensForUsers(
      userIds: readonly string[]
    ): ResultAsync<readonly PushRecipient[], DomainError> {
      if (userIds.length === 0) {
        return okAsync([]);
      }
      return fromPromise(
        db
          .select({
            userId: deviceTokens.userId,
            token: deviceTokens.token,
            platform: deviceTokens.platform,
            p256dh: deviceTokens.p256dh,
            auth: deviceTokens.auth,
          })
          .from(deviceTokens)
          .where(inArray(deviceTokens.userId, [...userIds])),
        (cause) => unavailableError('device-token lookup failed', cause)
      ).map((rows) => rows.flatMap((row) => toRecipients(row)));
    },

    touchLastSeen(references: readonly PushDeviceRef[]): ResultAsync<void, DomainError> {
      if (references.length === 0) {
        return okAsync();
      }
      // Each ref is matched as a (userId, token) pair rather than by two
      // independent IN lists, so a target can never refresh a row it does not
      // own.
      const owned = references.map((reference) =>
        and(eq(deviceTokens.userId, reference.userId), eq(deviceTokens.token, reference.token))
      );
      return fromPromise(
        db
          .update(deviceTokens)
          .set({ lastSeenAt: new Date() })
          .where(or(...owned)),
        (cause) => unavailableError('device-token last-seen touch failed', cause)
      ).map((): void => undefined);
    },
  };
}

interface DeviceTokenRow {
  readonly userId: string;
  readonly token: string;
  readonly platform: 'ios' | 'android' | 'web';
  readonly p256dh: string | null;
  readonly auth: string | null;
}

/**
 * Widens a stored row into a platform-tagged push target. A `web` row's
 * `token` is its endpoint and its keys are non-null by the DB CHECK; a web row
 * missing a key is dropped rather than shipped as a malformed web target (a
 * subscription with no keys cannot be encrypted to).
 */
function toRecipients(row: DeviceTokenRow): readonly PushRecipient[] {
  if (row.platform === 'web') {
    if (row.p256dh === null || row.auth === null) {
      return [];
    }
    return [
      {
        platform: 'web',
        userId: row.userId,
        endpoint: row.token,
        p256dh: row.p256dh,
        auth: row.auth,
      },
    ];
  }
  return [{ platform: row.platform, userId: row.userId, token: row.token }];
}
