import { describe, it, expect, afterAll } from 'vitest';
import { inArray } from 'drizzle-orm';
import { createDb, LOCAL_NEON_DEV_CONFIG, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { okAsync } from '../../../../lib/result/index.js';
import { createDeviceTokenStore } from '../device-token-store-db.js';
import { createNotificationPreferencesStore } from '../notification-preferences-store-db.js';
import { createWebPushSender } from '../push-webpush.js';
import { notifyEvent } from '../../domain/notify-event.js';
import type { Telemetry } from '../../../../lib/telemetry/index.js';
import type { MembershipReader } from '../../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for web push integration tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const deviceTokens = createDeviceTokenStore(db);
const preferences = createNotificationPreferencesStore(db);
const CONVERSATION_ID = testUuidV7(1);

// RFC 8291 Appendix A UA public key + auth secret: a valid P-256 point and 16
// bytes, so the send reaches the push service (the stubbed fetch) rather than
// failing at encryption.
const SUBSCRIPTION_KEYS = {
  p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg', // gitleaks:allow
};

/** A throwaway VAPID pair; nothing here is signed for a real push service. */
const VAPID = {
  subject: 'mailto:test@hushbox.ai',
  publicKey:
    'BOeIadxzr8jCEiJstuK2__fGtYo6wWP0HMZDdYl-RWBXoSB9O1Bs4Dd4gPtm5WijJcYxrmH-i1QTCTzaj9xJ4tE',
  privateKey: 'SQ6hnT9IQ-46JeC7tl_zN_tJjH0v76csKdFBGcCYTx0', // gitleaks:allow
} as const;

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  captureError: () => {},
} as unknown as Telemetry;

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const [row] = await db.insert(users).values(userFactory.build()).returning({ id: users.id });
  if (row === undefined) throw new Error('user insert returned no row');
  createdUserIds.push(row.id);
  return row.id;
}

async function subscribe(userId: string, endpoint: string): Promise<void> {
  const seeded = await deviceTokens.upsert({
    userId,
    token: endpoint,
    platform: 'web',
    ...SUBSCRIPTION_KEYS,
  });
  seeded._unsafeUnwrap();
}

function membershipOf(userIds: readonly string[]): MembershipReader {
  return {
    listActiveUserMembers: () => okAsync(userIds.map((userId) => ({ userId, muted: false }))),
  };
}

/** A push service answering every send with one status, recording the endpoints it saw. */
function pushServiceAnswering(status: number): { fetchImpl: typeof fetch; endpoints: string[] } {
  const endpoints: string[] = [];
  const fetchImpl = ((url: string) => {
    endpoints.push(url);
    return Promise.resolve(new Response(null, { status }));
  }) as unknown as typeof fetch;
  return { fetchImpl, endpoints };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

describe('web push over the real device-token store', () => {
  it('prunes the subscription row when the push service answers 403', async () => {
    const sender = await createUser();
    const subscriber = await createUser();
    const endpoint = `https://push.example.net/push/${crypto.randomUUID()}`;
    await subscribe(subscriber, endpoint);
    const pushService = pushServiceAnswering(403);

    const result = await notifyEvent(
      {
        membership: membershipOf([sender, subscriber]),
        preferences,
        deviceTokens,
        push: createWebPushSender({ vapid: VAPID, fetchImpl: pushService.fetchImpl }),
        logger: silentLogger,
      },
      {
        category: 'message',
        conversationId: CONVERSATION_ID,
        actorUserId: sender,
        presentUserIds: [],
      }
    );

    expect(result.isOk()).toBe(true);
    expect(pushService.endpoints).toEqual([endpoint]);
    const remaining = await deviceTokens.listTokensForUsers([subscriber]);
    expect(remaining._unsafeUnwrap()).toEqual([]);
  });
});
