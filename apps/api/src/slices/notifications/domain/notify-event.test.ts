import { describe, it, expect } from 'vitest';
import { HOUR_MS, TEST_DAY_START, testUuidV7 } from '@hushbox/shared/test-time';
import { okAsync, errAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { notifyEvent } from './notify-event.js';
import { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
import { DEFAULT_NOTIFICATION_PREFERENCES } from '../ports/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { SafeLogFields, Telemetry } from '../../../lib/telemetry/index.js';
import type {
  ConversationMemberView,
  MembershipReader,
  NotificationPreferences,
  NotificationPreferencesStore,
  PushDelivery,
  PushDeviceRef,
  PushMessage,
  PushRecipient,
  PushSender,
} from '../ports/index.js';

const NOON_UTC = new Date(TEST_DAY_START + 12 * HOUR_MS);

function membershipOf(members: readonly ConversationMemberView[]): MembershipReader {
  return { listActiveUserMembers: () => okAsync(members) };
}

function prefsReaderOf(
  entries: readonly (readonly [string, NotificationPreferences])[]
): Pick<NotificationPreferencesStore, 'readForUsers'> {
  return { readForUsers: () => okAsync(new Map(entries)) };
}

interface RecordingTokenStore {
  listTokensForUsers(
    userIds: readonly string[]
  ): ResultAsync<readonly PushRecipient[], DomainError>;
  deleteByToken(userId: string, token: string): ResultAsync<true | null, DomainError>;
  touchLastSeen(references: readonly PushDeviceRef[]): ResultAsync<void, DomainError>;
  readonly deleted: PushDeviceRef[];
  readonly touched: PushDeviceRef[];
}

function tokenStoreOf(byUser: Record<string, readonly PushRecipient[]>): RecordingTokenStore {
  const deleted: PushDeviceRef[] = [];
  const touched: PushDeviceRef[] = [];
  return {
    deleted,
    touched,
    listTokensForUsers: (userIds) => okAsync(userIds.flatMap((id) => byUser[id] ?? [])),
    deleteByToken: (userId, token) => {
      deleted.push({ userId, token });
      return okAsync(true);
    },
    touchLastSeen: (references) => {
      touched.push(...references);
      return okAsync();
    },
  };
}

function recordingPush(delivery: PushDelivery): { push: PushSender; sent: PushMessage[] } {
  const sent: PushMessage[] = [];
  return {
    sent,
    push: {
      send: (message) => {
        sent.push(message);
        return okAsync(delivery);
      },
    },
  };
}

function silentLogger(): Telemetry {
  return {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    captureError: () => {},
  } as unknown as Telemetry;
}

interface RecordedTelemetry {
  readonly logger: Telemetry;
  readonly errors: { msg: string; fields: SafeLogFields }[];
  readonly captured: string[];
}

function recordingLogger(): RecordedTelemetry {
  const errors: { msg: string; fields: SafeLogFields }[] = [];
  const captured: string[] = [];
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: (msg: string, fields: SafeLogFields) => errors.push({ msg, fields }),
    captureError: (_error: Error, errorCode: string) => captured.push(errorCode),
  } as unknown as Telemetry;
  return { logger, errors, captured };
}

const iosToken = (userId: string, token: string): PushRecipient => ({
  platform: 'ios',
  userId,
  token,
});

describe('notifyEvent', () => {
  it('sends the generic payload to an eligible member', async () => {
    const { push, sent } = recordingPush({ successCount: 1, failureCount: 0 });
    const result = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] }),
        push,
        logger: silentLogger(),
      },
      {
        category: 'runCompletion',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result._unsafeUnwrap()).toEqual({ successCount: 1, failureCount: 0 });
    expect(sent[0]?.payload).toEqual({
      category: 'runCompletion',
      conversationId: testUuidV7(1),
    });
    expect(sent[0]?.recipients).toEqual([iosToken('u1', 'tok-1')]);
  });

  it('never sets a raw conversationId as the collapse key (composite derives it)', async () => {
    const { push, sent } = recordingPush({ successCount: 1, failureCount: 0 });
    const delivery = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] }),
        push,
        logger: silentLogger(),
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(delivery.isOk()).toBe(true);
    expect(sent[0]?.collapseKey).toBeUndefined();
  });

  it('narrows to recipientUserIds when given, keeping their mute flags', async () => {
    const { push, sent } = recordingPush({ successCount: 1, failureCount: 0 });
    const delivery = await notifyEvent(
      {
        membership: membershipOf([
          { userId: 'u1', muted: false },
          { userId: 'u2', muted: false },
        ]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({
          u1: [iosToken('u1', 'tok-1')],
          u2: [iosToken('u2', 'tok-2')],
        }),
        push,
        logger: silentLogger(),
      },
      {
        category: 'membership',
        conversationId: testUuidV7(1),
        actorUserId: null,
        recipientUserIds: ['u2'],
        presentUserIds: [],
      }
    );
    expect(delivery.isOk()).toBe(true);
    expect(sent[0]?.recipients).toEqual([iosToken('u2', 'tok-2')]);
  });

  it('resolves without a send when no member is eligible', async () => {
    const { push, sent } = recordingPush({ successCount: 1, failureCount: 0 });
    const result = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: true }]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] }),
        push,
        logger: silentLogger(),
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result._unsafeUnwrap()).toEqual({ successCount: 0, failureCount: 0 });
    expect(sent).toEqual([]);
  });

  it('resolves without a send when eligible members carry no device tokens', async () => {
    const { push, sent } = recordingPush({ successCount: 1, failureCount: 0 });
    const result = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({}),
        push,
        logger: silentLogger(),
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result._unsafeUnwrap()).toEqual({ successCount: 0, failureCount: 0 });
    expect(sent).toEqual([]);
  });

  it('prunes every dead token the sender reports', async () => {
    const { push } = recordingPush({
      successCount: 0,
      failureCount: 1,
      deadTokens: [{ userId: 'u1', token: 'tok-1' }],
    });
    const store = tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] });
    const delivery = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: store,
        push,
        logger: silentLogger(),
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(delivery.isOk()).toBe(true);
    expect(store.deleted).toEqual([{ userId: 'u1', token: 'tok-1' }]);
  });

  it('touches last-seen for every target the sender delivered to', async () => {
    const { push } = recordingPush({
      successCount: 1,
      failureCount: 0,
      deliveredTokens: [{ userId: 'u1', token: 'tok-1' }],
    });
    const store = tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] });
    const delivery = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: store,
        push,
        logger: silentLogger(),
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(delivery.isOk()).toBe(true);
    expect(store.touched).toEqual([{ userId: 'u1', token: 'tok-1' }]);
  });

  it('never touches last-seen for a target the sender failed to reach', async () => {
    const { push } = recordingPush({
      successCount: 1,
      failureCount: 1,
      deliveredTokens: [{ userId: 'u1', token: 'tok-1' }],
      deadTokens: [{ userId: 'u2', token: 'tok-2' }],
    });
    const store = tokenStoreOf({
      u1: [iosToken('u1', 'tok-1')],
      u2: [iosToken('u2', 'tok-2')],
    });
    const delivery = await notifyEvent(
      {
        membership: membershipOf([
          { userId: 'u1', muted: false },
          { userId: 'u2', muted: false },
        ]),
        preferences: prefsReaderOf([]),
        deviceTokens: store,
        push,
        logger: silentLogger(),
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(delivery.isOk()).toBe(true);
    expect(store.touched).toEqual([{ userId: 'u1', token: 'tok-1' }]);
  });

  it('applies quiet hours through the injected clock', async () => {
    const { push, sent } = recordingPush({ successCount: 1, failureCount: 0 });
    const quiet: NotificationPreferences = {
      ...DEFAULT_NOTIFICATION_PREFERENCES,
      quietHoursStartMinutes: 6 * 60,
      quietHoursEndMinutes: 8 * 60,
      timezone: 'America/New_York',
    };
    const result = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([['u1', quiet]]),
        deviceTokens: tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] }),
        push,
        logger: silentLogger(),
        now: () => NOON_UTC, // morning in New York → inside the window
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result._unsafeUnwrap()).toEqual({ successCount: 0, failureCount: 0 });
    expect(sent).toEqual([]);
  });

  it('records the counts when a send is rejected by every target', async () => {
    const { logger, errors } = recordingLogger();
    const { push } = recordingPush({ successCount: 0, failureCount: 2 });
    const conversationId = testUuidV7(1);
    const result = await notifyEvent(
      {
        membership: membershipOf([
          { userId: 'u1', muted: false },
          { userId: 'u2', muted: false },
        ]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({
          u1: [iosToken('u1', 'tok-1')],
          u2: [iosToken('u2', 'tok-2')],
        }),
        push,
        logger,
      },
      { category: 'message', conversationId, actorUserId: null, presentUserIds: [] }
    );
    expect(result.isOk()).toBe(true);
    expect(errors).toEqual([
      {
        msg: 'push delivery reached no target of a send',
        fields: {
          conversationId,
          successCount: 0,
          failureCount: 2,
          errorCode: 'push_delivery_total_failure',
        },
      },
    ]);
  });

  it('raises one Sentry event when a fan-out reaches no target', async () => {
    const { logger, captured } = recordingLogger();
    const { push } = recordingPush({ successCount: 0, failureCount: 2 });
    const result = await notifyEvent(
      {
        membership: membershipOf([
          { userId: 'u1', muted: false },
          { userId: 'u2', muted: false },
        ]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({
          u1: [iosToken('u1', 'tok-1')],
          u2: [iosToken('u2', 'tok-2')],
        }),
        push,
        logger,
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result.isOk()).toBe(true);
    expect(captured).toEqual([FINGERPRINT_CODES.pushDeliveryTotalFailure]);
  });

  it('logs but never pages when the send had a single rejected target', async () => {
    const { logger, errors, captured } = recordingLogger();
    const { push } = recordingPush({ successCount: 0, failureCount: 1 });
    const result = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({ u1: [iosToken('u1', 'tok-1')] }),
        push,
        logger,
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result.isOk()).toBe(true);
    expect(errors).toHaveLength(1);
    expect(captured).toEqual([]);
  });

  it('emits nothing when the send reached at least one target', async () => {
    const { logger, errors, captured } = recordingLogger();
    const { push } = recordingPush({ successCount: 1, failureCount: 3 });
    const result = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({
          u1: [
            iosToken('u1', 'tok-1'),
            iosToken('u1', 'tok-2'),
            iosToken('u1', 'tok-3'),
            iosToken('u1', 'tok-4'),
          ],
        }),
        push,
        logger,
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result.isOk()).toBe(true);
    expect(errors).toEqual([]);
    expect(captured).toEqual([]);
  });

  it('logs but never pages when every rejected target was merely stale', async () => {
    const { logger, errors, captured } = recordingLogger();
    const { push } = recordingPush({
      successCount: 0,
      failureCount: 2,
      deadTokens: [
        { userId: 'u1', token: 'tok-1' },
        { userId: 'u2', token: 'tok-2' },
      ],
    });
    const result = await notifyEvent(
      {
        membership: membershipOf([
          { userId: 'u1', muted: false },
          { userId: 'u2', muted: false },
        ]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({
          u1: [iosToken('u1', 'tok-1')],
          u2: [iosToken('u2', 'tok-2')],
        }),
        push,
        logger,
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result.isOk()).toBe(true);
    expect(errors).toHaveLength(1);
    expect(captured).toEqual([]);
  });

  it('pages when the transport returned no verdict for the targets it dispatched', async () => {
    // A revoked service account fails the token mint, so the whole partition
    // errors before any per-target result exists and the composite folds it to
    // no delivery — counts of zero against targets that were dispatched.
    const { logger, errors, captured } = recordingLogger();
    const { push } = recordingPush({ successCount: 0, failureCount: 0 });
    const conversationId = testUuidV7(1);
    const result = await notifyEvent(
      {
        membership: membershipOf([
          { userId: 'u1', muted: false },
          { userId: 'u2', muted: false },
        ]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({
          u1: [iosToken('u1', 'tok-1')],
          u2: [iosToken('u2', 'tok-2')],
        }),
        push,
        logger,
      },
      { category: 'message', conversationId, actorUserId: null, presentUserIds: [] }
    );
    expect(result.isOk()).toBe(true);
    expect(errors).toEqual([
      {
        msg: 'push delivery dispatched targets the transport returned no verdict for',
        fields: {
          conversationId,
          successCount: 0,
          failureCount: 0,
          errorCode: 'push_delivery_total_failure',
        },
      },
    ]);
    expect(captured).toEqual([FINGERPRINT_CODES.pushDeliveryTotalFailure]);
  });

  it('pages when one partition dies and the other still delivers', async () => {
    // The mixed-platform shape of the same outage: the native partition errors
    // outright and folds to no delivery while the web partition succeeds, so
    // the send has a verdict for one dispatched target and none for the other.
    const { logger, captured } = recordingLogger();
    const { push } = recordingPush({
      successCount: 1,
      failureCount: 0,
      deliveredTokens: [{ userId: 'u1', token: 'tok-web' }],
    });
    const result = await notifyEvent(
      {
        membership: membershipOf([{ userId: 'u1', muted: false }]),
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({
          u1: [iosToken('u1', 'tok-native'), iosToken('u1', 'tok-web')],
        }),
        push,
        logger,
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result.isOk()).toBe(true);
    expect(captured).toEqual([FINGERPRINT_CODES.pushDeliveryTotalFailure]);
  });

  it('logs and returns the error when a downstream read fails', async () => {
    const logged: { msg: string; fields: SafeLogFields }[] = [];
    const logger = {
      debug: () => {},
      info: () => {},
      warn: (msg: string, fields: SafeLogFields) => logged.push({ msg, fields }),
      error: () => {},
    } as unknown as Telemetry;
    const failing: MembershipReader = {
      listActiveUserMembers: () => errAsync(unavailableError('membership read failed')),
    };
    const result = await notifyEvent(
      {
        membership: failing,
        preferences: prefsReaderOf([]),
        deviceTokens: tokenStoreOf({}),
        push: recordingPush({ successCount: 0, failureCount: 0 }).push,
        logger,
      },
      {
        category: 'message',
        conversationId: testUuidV7(1),
        actorUserId: null,
        presentUserIds: [],
      }
    );
    expect(result.isErr()).toBe(true);
    expect(logged[0]?.msg).toBe('push.delivery.degraded');
  });
});
