import { describe, expect, it, vi } from 'vitest';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { errAsync, okAsync } from '../lib/result/index.js';
import { unavailableError } from '../lib/errors/index.js';
import { FINGERPRINT_CODES } from '../lib/telemetry/index.js';
import {
  createChatMessagePushNotify,
  createMembershipPushNotify,
  createRunCompletionPushNotify,
} from './push-notify.js';
import type { PushMembershipReader } from '../slices/conversations/adapters/push-membership-reader.js';
import type { Database } from '@hushbox/db';
import type { Bindings } from '../lib/context/app-env.js';
import type { Telemetry } from '../lib/telemetry/index.js';

/** Development env selects the in-process mock push sender (no real push). */
const ENV = { NODE_ENV: 'development', NOTIFICATION_TAG_SECRET: 'test-secret' } as Bindings;

/**
 * Must be a real uuid: the composite push sender validates the wire payload
 * against the shared schema and refuses to dispatch a malformed conversation
 * id, so a placeholder here would silently stop the pipeline short of `send`.
 */
const CONVERSATION_ID = testUuidV7(1);

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    captureError: noop,
  } as unknown as Telemetry;
}

/**
 * A fake DB whose `select().from().where()` yields the queued result sets in
 * order. The message pipeline reads (for an injected-membership caller) the
 * per-user preferences then, if any member survives, the device tokens; the
 * `select` spy's call count observes how far it got.
 */
function queuedDb(...resultSets: readonly unknown[][]): {
  db: Database;
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
} {
  const queue = [...resultSets];
  const select = vi.fn(() => ({
    from: () => ({ where: () => Promise.resolve(queue.shift() ?? []) }),
  }));
  // The delivery path refreshes `lastSeenAt` on every target the sender
  // accepted; the spy observes that write.
  const update = vi.fn(() => ({ set: () => ({ where: () => Promise.resolve([]) }) }));
  return { db: { select, update } as unknown as Database, select, update };
}

function membershipOf(
  members: readonly { readonly userId: string; readonly muted: boolean }[]
): PushMembershipReader {
  return { listActiveUserMembers: () => okAsync(members) };
}

describe('createRunCompletionPushNotify', () => {
  it('reads preferences then device tokens for an eligible absent member', async () => {
    // [prefs rows, token rows] — no prefs row means defaults; the token row
    // makes the surviving recipient reachable.
    const { db, select, update } = queuedDb(
      [],
      [{ platform: 'ios', userId: 'member-1', token: 'device-1' }]
    );
    const notify = createRunCompletionPushNotify({
      env: ENV,
      db,
      telemetry: noopTelemetry(),
      membership: membershipOf([{ userId: 'member-1', muted: false }]),
    });

    await notify({ conversationId: CONVERSATION_ID, senderUserId: 'sender-1', presentUserIds: [] });

    // Preferences read, then the token lookup for the surviving recipient.
    expect(select).toHaveBeenCalledTimes(2);
    // …and the delivered device's last-seen clock is refreshed.
    expect(update).toHaveBeenCalledTimes(1);
  });

  it('never looks up tokens when every member is suppressed', async () => {
    const { db, select } = queuedDb([]); // only the preferences read runs
    const notify = createRunCompletionPushNotify({
      env: ENV,
      db,
      telemetry: noopTelemetry(),
      membership: membershipOf([
        { userId: 'muted-member', muted: true },
        { userId: 'present-member', muted: false },
        { userId: 'sender-1', muted: false },
      ]),
    });

    await notify({
      conversationId: CONVERSATION_ID,
      senderUserId: 'sender-1',
      presentUserIds: ['present-member', 'sender-1'],
    });

    // Preferences are read over the candidates, but no member survives mute /
    // presence, so the token lookup never fires. A run completion does not
    // suppress its requester — only their watching the run does.
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('resolves without throwing when the membership read fails (best-effort)', async () => {
    const { db } = queuedDb();
    const notify = createRunCompletionPushNotify({
      env: ENV,
      db,
      telemetry: noopTelemetry(),
      membership: { listActiveUserMembers: () => errAsync(unavailableError('members down')) },
    });

    await expect(
      notify({ conversationId: CONVERSATION_ID, senderUserId: 'sender-1', presentUserIds: [] })
    ).resolves.toBeUndefined();
  });
});

describe('createChatMessagePushNotify', () => {
  it('reads active members, preferences, then device tokens for an eligible member', async () => {
    const { db, select } = queuedDb(
      [{ userId: 'member-1', muted: false }],
      [],
      [{ platform: 'ios', userId: 'member-1', token: 'device-1' }]
    );
    const notify = createChatMessagePushNotify(ENV, db, noopTelemetry());

    await expect(
      notify({ conversationId: CONVERSATION_ID, senderUserId: 'sender-1', presentUserIds: [] })
    ).resolves.toBeUndefined();

    // Members query, preferences query, then the token lookup.
    expect(select).toHaveBeenCalledTimes(3);
  });

  it('excludes a link-guest (null userId) member — no recipient, no further reads', async () => {
    const { db, select } = queuedDb([{ userId: null, muted: false }]);
    const notify = createChatMessagePushNotify(ENV, db, noopTelemetry());

    await expect(
      notify({ conversationId: CONVERSATION_ID, senderUserId: 'sender-1', presentUserIds: [] })
    ).resolves.toBeUndefined();

    // Only the member read runs: the null-userId row is dropped, leaving no
    // candidate, so neither the preferences nor the token lookup fires.
    expect(select).toHaveBeenCalledTimes(1);
  });

  it('resolves without throwing when the member read fails (best-effort)', async () => {
    const select = vi.fn(() => ({
      from: () => ({ where: () => Promise.reject(new Error('members down')) }),
    }));
    const db = { select } as unknown as Database;
    const notify = createChatMessagePushNotify(ENV, db, noopTelemetry());

    await expect(
      notify({ conversationId: CONVERSATION_ID, senderUserId: 'sender-1', presentUserIds: [] })
    ).resolves.toBeUndefined();
  });
});

/**
 * A revoked FCM service account, which is what the total-failure page exists
 * for: the credential is well-formed enough to construct the sender, so the
 * outage surfaces only when a send is attempted. Signing the OAuth assertion
 * with the unusable key fails before any request leaves the process, so the
 * native partition errors, folds to no delivery, and leaves the dispatched
 * target without a verdict — the shape `notifyEvent` pages on.
 */
const REVOKED_CREDENTIAL_ENV = {
  NODE_ENV: 'production',
  NOTIFICATION_TAG_SECRET: 'test-secret',
  FCM_PROJECT_ID: 'push-outage',
  FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
    client_email: 'revoked@push-outage.test',
    private_key: '-----BEGIN PRIVATE KEY-----\nrevoked\n-----END PRIVATE KEY-----\n',
  }),
  VAPID_PUBLIC_KEY: 'unused-public',
  VAPID_PRIVATE_KEY: 'unused-private',
  VAPID_SUBJECT: 'mailto:ops@push-outage.test',
} as unknown as Bindings;

function recordingTelemetry(): { telemetry: Telemetry; captureError: ReturnType<typeof vi.fn> } {
  const captureError = vi.fn();
  const noop = (): void => undefined;
  return {
    captureError,
    telemetry: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      captureError,
    } as unknown as Telemetry,
  };
}

/** Rows for the member read, the preferences read, then the device-token read. */
const OUTAGE_ROWS: readonly unknown[][] = [
  [{ userId: 'member-1', muted: false }],
  [],
  [{ platform: 'ios', userId: 'member-1', token: 'device-1' }],
];

/**
 * Every push side-band reports its outage to the telemetry its caller
 * composed. A private console sink is retained nowhere, so a side-band holding
 * one can fail every push for a conversation and page nobody.
 */
describe('push side-band telemetry', () => {
  it('reaches the composed sink from the run-completion side-band', async () => {
    const { telemetry, captureError } = recordingTelemetry();
    const { db } = queuedDb(...OUTAGE_ROWS.slice(1));
    const notify = createRunCompletionPushNotify({
      env: REVOKED_CREDENTIAL_ENV,
      db,
      telemetry,
      membership: membershipOf([{ userId: 'member-1', muted: false }]),
    });

    await notify({ conversationId: CONVERSATION_ID, senderUserId: 'sender-1', presentUserIds: [] });

    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      FINGERPRINT_CODES.pushDeliveryTotalFailure
    );
  });

  it('reaches the composed sink from the chat-message side-band', async () => {
    const { telemetry, captureError } = recordingTelemetry();
    const { db } = queuedDb(...OUTAGE_ROWS);
    const notify = createChatMessagePushNotify(REVOKED_CREDENTIAL_ENV, db, telemetry);

    await notify({ conversationId: CONVERSATION_ID, senderUserId: 'sender-1', presentUserIds: [] });

    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      FINGERPRINT_CODES.pushDeliveryTotalFailure
    );
  });

  it('reaches the composed sink from the membership side-band', async () => {
    const { telemetry, captureError } = recordingTelemetry();
    const { db } = queuedDb(...OUTAGE_ROWS);
    const notify = createMembershipPushNotify(REVOKED_CREDENTIAL_ENV, db, telemetry);

    await notify({
      conversationId: CONVERSATION_ID,
      actorUserId: 'sender-1',
      presentUserIds: [],
    });

    expect(captureError).toHaveBeenCalledWith(
      expect.any(Error),
      FINGERPRINT_CODES.pushDeliveryTotalFailure
    );
  });
});
