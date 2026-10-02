import { afterAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { generateEpochKeyPair } from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  conversationForks,
  conversations,
  createDb,
  epochs,
  messages,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import {
  createConversationsStores,
  reserveSequenceBlockWithinTx,
  resolveForkTipWithinTx,
} from '../../../conversations/index.js';
import { createChatStores } from '../../adapters/stores.js';
import { saveUserOnlyMessage } from './user-message.js';
import { seedConversationWithEpoch } from '../../../../test-support/conversation-seed.js';
import type { EpochPublicKeyReader } from '../settlement/settlement.js';

/**
 * The AB/BA hazard between the two write paths that touch both the
 * conversation row and a fork row: a settling paid turn and the runless
 * user-only send on the SAME fork. Settlement takes the conversation row
 * first (its epoch-at-persist `FOR SHARE` gate) and the fork row second; the
 * send must take them in that same order or Postgres kills one transaction
 * after `deadlock_timeout`.
 *
 * Two independent pools = two real connections, so the two transactions
 * genuinely contend for the two rows rather than merely calling the locks in
 * some order. Two barriers pin the interleaving that produces the hazard, in
 * both directions: the send starts only once the settling side HOLDS its share
 * lock, and the settling side reaches for the fork only once the send has
 * issued its first row lock. Neither side may win by arriving first, which is
 * the ordering an accidental one — a cold pool on one side — would leave to
 * chance. The body runs repeatedly, because a lock-order hazard that shows up
 * once is a hazard that can hide once.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for chat user-message lock-order tests');
}

const dbSettling = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const dbSend = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const BYTES = new Uint8Array([9, 9, 9]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

function requireSeeded<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`${label} seed failed`);
  return value;
}

interface Fixture {
  readonly userId: string;
  readonly conversationId: string;
  readonly forkId: string;
  readonly tipMessageId: string;
}

async function seedFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await dbSettling
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@lock-order.test`,
        username: `lo${suffix}`,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = requireSeeded(userRows[0]?.id, 'user');
  createdUserIds.push(userId);

  const { conversationId } = await seedConversationWithEpoch(dbSettling, {
    userId,
    title: BYTES,
    epochPublicKey: generateEpochKeyPair().publicKey,
  });
  createdConversationIds.push(conversationId);

  const messageRows = await dbSettling
    .insert(messages)
    .values({
      conversationId,
      senderType: 'user',
      wrappedContentKey: BYTES,
      epochNumber: 1,
      sequenceNumber: 1,
    })
    .returning({ id: messages.id });
  const tipMessageId = requireSeeded(messageRows[0]?.id, 'message');

  const forkRows = await dbSettling
    .insert(conversationForks)
    .values({ conversationId, name: 'Branch', tipMessageId })
    .returning({ id: conversationForks.id });
  const forkId = requireSeeded(forkRows[0]?.id, 'fork');

  return { userId, conversationId, forkId, tipMessageId };
}

const readEpochPublicKey: EpochPublicKeyReader = async (tx, conversationId, epochNumber) => {
  const rows = await tx
    .select({ key: epochs.epochPublicKey })
    .from(epochs)
    .where(and(eq(epochs.conversationId, conversationId), eq(epochs.epochNumber, epochNumber)));
  return rows[0]?.key ?? null;
};

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await dbSettling.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await dbSettling.delete(users).where(inArray(users.id, createdUserIds));
  }
  await dbSettling.$client.end();
  await dbSend.$client.end();
});

describe('runless send vs settling turn lock order', () => {
  it('completes both transactions when a send lands on the fork a settlement is holding', async () => {
    // The pool the send runs on is warmed once: a cold connection would make
    // the send arrive late on its own, which is contention by accident rather
    // than by the barriers below.
    await dbSend.execute(sql`select 1`);

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const fixture = await seedFixture();

      let signalShareHeld!: () => void;
      const settlingHoldsShare = new Promise<void>((resolve) => {
        signalShareHeld = resolve;
      });
      let signalFirstLock!: () => void;
      const sendTookFirstLock = new Promise<void>((resolve) => {
        signalFirstLock = resolve;
      });

      const settling = dbSettling.transaction(async (tx) => {
        const stores = createConversationsStores(tx);
        // Settlement's epoch-at-persist gate: the conversation row FOR SHARE,
        // held to commit. Signalled only once it is HELD, so the send cannot
        // race ahead of it and take the conversation row first — the ordering
        // in which no cycle forms whatever the send does.
        const gated = await stores.conversations.lockForShare(fixture.conversationId);
        expect(gated._unsafeUnwrap()?.currentEpoch).toBe(1);
        signalShareHeld();
        await sendTookFirstLock;
        // Then the fork row FOR UPDATE, and finally the sequence reservation,
        // which upgrades the shared conversation lock to exclusive.
        const resolved = await resolveForkTipWithinTx(stores, {
          conversationId: fixture.conversationId,
          forkId: fixture.forkId,
        });
        expect(resolved._unsafeUnwrap().tipMessageId).toBe(fixture.tipMessageId);
        const reserved = await reserveSequenceBlockWithinTx(stores, {
          conversationId: fixture.conversationId,
          count: 1,
        });
        expect(reserved.isOk()).toBe(true);
      });

      const send = (async () => {
        await settlingHoldsShare;
        return dbSend.transaction(async (tx) =>
          saveUserOnlyMessage(
            {
              tx,
              stores: createChatStores(),
              readEpochPublicKey,
              newId: () => crypto.randomUUID(),
              conversationsStores: (tx) => {
                const real = createConversationsStores(tx);
                return {
                  ...real,
                  conversations: {
                    ...real.conversations,
                    // Signalled BEFORE the call, because this lock is the one that
                    // blocks on the settling side's share lock.
                    lockForUpdate: (conversationId) => {
                      signalFirstLock();
                      return real.conversations.lockForUpdate(conversationId);
                    },
                  },
                  forks: {
                    ...real.forks,
                    lockById: (conversationId, forkId) =>
                      real.forks.lockById(conversationId, forkId).map((fork) => {
                        signalFirstLock();
                        return fork;
                      }),
                  },
                };
              },
            },
            {
              conversationId: fixture.conversationId,
              senderId: fixture.userId,
              content: 'sent while a turn settles',
              forkId: fixture.forkId,
            }
          )
        );
      })();

      // Neither transaction is Postgres's deadlock victim: the settling side
      // commits, and the send persists at the next sequence.
      await expect(settling).resolves.toBeUndefined();
      // Unwrapped through a branch rather than `_unsafeUnwrap` so a regression
      // reports the refusal it actually got instead of an opaque throw.
      const sent = await send;
      expect(sent.isOk() ? sent.value : sent.error).toMatchObject({
        messageId: expect.any(String),
      });
      const messageId = sent._unsafeUnwrap().messageId;

      const persisted = await dbSettling
        .select({ sequenceNumber: messages.sequenceNumber })
        .from(messages)
        .where(eq(messages.id, messageId));
      expect(persisted).toHaveLength(1);
      const tip = await dbSettling
        .select({ tipMessageId: conversationForks.tipMessageId })
        .from(conversationForks)
        .where(eq(conversationForks.id, fixture.forkId));
      expect(tip[0]?.tipMessageId).toBe(messageId);
    }
  });
});
