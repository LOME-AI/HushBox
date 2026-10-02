import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import {
  decryptContentEnvelope,
  generateContentKey,
  generateEpochKeyPair,
  unwrapContentKeyFromEpoch,
  wrapContentKeyToEpoch,
} from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversations,
  createDb,
  messages,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { createChatStores } from '../../adapters/stores.js';
import { persistEncryptedMessage } from './message-write.js';
import { seedConversationWithEpoch } from '../../../../test-support/conversation-seed.js';
import type { WrappedSecret } from '@hushbox/crypto';
import type { PersistItem } from './message-write.js';

/**
 * The media persist path of the ONE message+content insert primitive: media
 * bytes are already encrypted in R2 by the time persist runs, so the media
 * branch writes the row straight from the pre-minted identity (item id bound
 * into the R2 key) under the pre-supplied wrapped content key — no fresh key,
 * no inline encryption — satisfying the `content_items_type_consistency` CHECK.
 */

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for chat message-write integration tests');
}
const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });

const BYTES = new Uint8Array([7, 7, 7]);

const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

function first<T>(rows: readonly T[], what: string): T {
  const row = rows[0];
  if (row === undefined) throw new Error(`expected a ${what} row`);
  return row;
}

interface Fixture {
  readonly userId: string;
  readonly conversationId: string;
  readonly epochPublicKey: ReturnType<typeof generateEpochKeyPair>['publicKey'];
  readonly epochPrivateKey: ReturnType<typeof generateEpochKeyPair>['privateKey'];
}

async function seedFixture(): Promise<Fixture> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const userRows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${suffix}@msg-write.test`,
        username: `mw${suffix}`,
        opaqueRegistration: BYTES,
        publicKey: BYTES,
        passwordWrappedPrivateKey: BYTES,
        recoveryWrappedPrivateKey: BYTES,
        recoveryPublicKey: BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = first(userRows, 'user').id;
  createdUserIds.push(userId);

  const keyPair = generateEpochKeyPair();
  const { conversationId } = await seedConversationWithEpoch(db, {
    userId,
    title: BYTES,
    epochPublicKey: keyPair.publicKey,
  });
  createdConversationIds.push(conversationId);
  return {
    userId,
    conversationId,
    epochPublicKey: keyPair.publicKey,
    epochPrivateKey: keyPair.privateKey,
  };
}

interface MediaPersistArgs {
  readonly fixture: Fixture;
  readonly items: readonly PersistItem[];
  readonly wrappedContentKey: WrappedSecret;
  readonly messageId: string;
}

/** A run-start wrapped content key, as the media path pre-supplies it. */
function mintWrappedKey(fixture: Fixture): WrappedSecret {
  return wrapContentKeyToEpoch(fixture.epochPublicKey, generateContentKey());
}

async function persistWithMedia(args: MediaPersistArgs): Promise<string[]> {
  const stores = createChatStores();
  return db.transaction(async (tx) =>
    persistEncryptedMessage(
      tx,
      {
        stores,
        conversationId: args.fixture.conversationId,
        epochNumber: 1,
        newId: () => crypto.randomUUID(),
      },
      {
        messageId: args.messageId,
        epochPublicKey: args.fixture.epochPublicKey,
        senderType: 'assistant',
        senderId: args.fixture.userId,
        sequenceNumber: 1,
        parentMessageId: null,
        batchId: crypto.randomUUID(),
        wrappedContentKey: args.wrappedContentKey,
        items: args.items,
      }
    )
  );
}

describe('persistEncryptedMessage media items', () => {
  it('persists a media item straight from pre-minted fields under the pre-supplied wrapped key', async () => {
    const fixture = await seedFixture();
    const messageId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();
    const wrappedContentKey = mintWrappedKey(fixture);

    const ids = await persistWithMedia({
      fixture,
      messageId,
      wrappedContentKey,
      items: [
        {
          contentType: 'image',
          id: contentItemId,
          storageKey: `media/${fixture.conversationId}/${messageId}/${contentItemId}`,
          mimeType: 'image/png',
          sizeBytes: 2048,
          width: 1024,
          height: 768,
          modelId: 'openai/gpt-image-1',
          providerName: 'openai',
          cost: 42n,
          isSmartModel: false,
        },
      ],
    });

    expect(ids).toEqual([contentItemId]);

    const messageRows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(new Uint8Array(first(messageRows, 'message').wrappedContentKey)).toEqual(
      wrappedContentKey
    );

    const itemRows = await db.select().from(contentItems).where(eq(contentItems.id, contentItemId));
    const row = first(itemRows, 'content item');
    expect(row).toMatchObject({
      contentType: 'image',
      position: 0,
      storageKey: `media/${fixture.conversationId}/${messageId}/${contentItemId}`,
      mimeType: 'image/png',
      sizeBytes: 2048,
      width: 1024,
      height: 768,
      durationMs: null,
      modelId: 'openai/gpt-image-1',
      providerName: 'openai',
      costNanoUsd: 42n,
      isSmartModel: false,
    });
    expect(row.encryptedBlob).toBeNull();
  });

  it('writes NULL width/height/durationMs when the media item omits them', async () => {
    const fixture = await seedFixture();
    const messageId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    await persistWithMedia({
      fixture,
      messageId,
      wrappedContentKey: mintWrappedKey(fixture),
      items: [
        {
          contentType: 'video',
          id: contentItemId,
          storageKey: `media/${fixture.conversationId}/${messageId}/${contentItemId}`,
          mimeType: 'video/mp4',
          sizeBytes: 4096,
          modelId: 'google/veo-3',
          providerName: 'google',
          cost: 7n,
          isSmartModel: false,
        },
      ],
    });

    const itemRows = await db.select().from(contentItems).where(eq(contentItems.id, contentItemId));
    expect(first(itemRows, 'content item')).toMatchObject({
      width: null,
      height: null,
      durationMs: null,
    });
  });

  it('persists supplied video dimensions and duration', async () => {
    const fixture = await seedFixture();
    const messageId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    await persistWithMedia({
      fixture,
      messageId,
      wrappedContentKey: mintWrappedKey(fixture),
      items: [
        {
          contentType: 'video',
          id: contentItemId,
          storageKey: `media/${fixture.conversationId}/${messageId}/${contentItemId}`,
          mimeType: 'video/mp4',
          sizeBytes: 8192,
          width: 1280,
          height: 720,
          durationMs: 6000,
          modelId: 'google/veo-3',
          providerName: 'google',
          cost: 9n,
          isSmartModel: false,
        },
      ],
    });

    const itemRows = await db.select().from(contentItems).where(eq(contentItems.id, contentItemId));
    expect(first(itemRows, 'content item')).toMatchObject({
      contentType: 'video',
      width: 1280,
      height: 720,
      durationMs: 6000,
    });
  });

  it('defaults isSmartModel to false when a text insert omits it (dev-seed caller shape)', async () => {
    const fixture = await seedFixture();
    const stores = createChatStores();
    const messageId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    await db.transaction(async (tx) => {
      await stores.insertMessageWithinTx(tx, {
        id: messageId,
        conversationId: fixture.conversationId,
        senderType: 'user',
        senderId: fixture.userId,
        wrappedContentKey: mintWrappedKey(fixture),
        epochNumber: 1,
        sequenceNumber: 1,
        parentMessageId: null,
        batchId: crypto.randomUUID(),
      });
      await stores.insertContentItemWithinTx(tx, {
        id: contentItemId,
        messageId,
        position: 0,
        encryptedBlob: BYTES,
        modelId: null,
        providerName: null,
        costNanoUsd: null,
      });
    });

    const itemRows = await db.select().from(contentItems).where(eq(contentItems.id, contentItemId));
    expect(first(itemRows, 'content item').isSmartModel).toBe(false);
  });

  it('throws when the storage key is not exactly the expected media key for this location', async () => {
    const fixture = await seedFixture();
    // Every key ends in the item's id but is not the expected
    // `media/{conversationId}/{messageId}/{objectId}` for THIS location.
    const badKeyFor = (contentItemId: string): string[] => [
      `evil/${contentItemId}`,
      contentItemId,
      `media/${crypto.randomUUID()}/${crypto.randomUUID()}/${contentItemId}`,
      `media/${fixture.conversationId}/${crypto.randomUUID()}/${contentItemId}`,
    ];
    for (let caseIndex = 0; caseIndex < 4; caseIndex += 1) {
      // Fresh ids per case so a wrongly-successful insert cannot collide.
      const messageId = crypto.randomUUID();
      const contentItemId = crypto.randomUUID();
      const storageKey = badKeyFor(contentItemId)[caseIndex];
      if (storageKey === undefined) throw new Error('missing bad-key case');
      await expect(
        persistWithMedia({
          fixture,
          messageId,
          wrappedContentKey: mintWrappedKey(fixture),
          items: [
            {
              contentType: 'image',
              id: contentItemId,
              storageKey,
              mimeType: 'image/png',
              sizeBytes: 1,
              modelId: null,
              providerName: null,
              cost: null,
              isSmartModel: false,
            },
          ],
        })
      ).rejects.toThrow('storage key');
    }
  });

  it('throws when the storage key does not end in the pre-minted content item id', async () => {
    const fixture = await seedFixture();
    const messageId = crypto.randomUUID();
    const contentItemId = crypto.randomUUID();

    await expect(
      persistWithMedia({
        fixture,
        messageId,
        wrappedContentKey: mintWrappedKey(fixture),
        items: [
          {
            contentType: 'image',
            id: contentItemId,
            storageKey: `media/${fixture.conversationId}/${messageId}/${crypto.randomUUID()}`,
            mimeType: 'image/png',
            sizeBytes: 1,
            modelId: null,
            providerName: null,
            cost: null,
            isSmartModel: false,
          },
        ],
      })
    ).rejects.toThrow('storage key');

    const messageRows = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(messageRows).toHaveLength(0);
  });

  it('throws when a text item arrives with a pre-supplied wrapped key (no content key to encrypt under)', async () => {
    const fixture = await seedFixture();
    const messageId = crypto.randomUUID();

    await expect(
      persistWithMedia({
        fixture,
        messageId,
        wrappedContentKey: mintWrappedKey(fixture),
        items: [
          {
            text: 'cannot be encrypted',
            modelId: null,
            providerName: null,
            cost: null,
            isSmartModel: false,
          },
        ],
      })
    ).rejects.toThrow('content key');
  });
});

describe('persistEncryptedMessage text items', () => {
  it('stores an assistant answer deflated, round-tripping to the exact text', async () => {
    const fixture = await seedFixture();
    const stores = createChatStores();
    const messageId = crypto.randomUUID();
    const answer = (
      'A run killed at any earlier moment leaves an expiring hold and nothing ' +
      'else, so saved and billed hold together by construction rather than by ' +
      'a cleanup pass that has to have run. '
    ).repeat(4);

    const [contentItemId] = await db.transaction(async (tx) =>
      persistEncryptedMessage(
        tx,
        {
          stores,
          conversationId: fixture.conversationId,
          epochNumber: 1,
          newId: () => crypto.randomUUID(),
        },
        {
          messageId,
          epochPublicKey: fixture.epochPublicKey,
          senderType: 'assistant',
          senderId: fixture.userId,
          sequenceNumber: 1,
          parentMessageId: null,
          batchId: crypto.randomUUID(),
          items: [
            { text: answer, modelId: null, providerName: null, cost: null, isSmartModel: false },
          ],
        }
      )
    );
    if (contentItemId === undefined) throw new Error('expected a content item id');

    const itemRow = first(
      await db.select().from(contentItems).where(eq(contentItems.id, contentItemId)),
      'content item'
    );
    const messageRow = first(
      await db.select().from(messages).where(eq(messages.id, messageId)),
      'message'
    );
    const blob = itemRow.encryptedBlob;
    if (blob === null) throw new Error('expected an encrypted blob');
    const plaintextBytes = new TextEncoder().encode(answer).length;

    expect(blob.length).toBeLessThan(plaintextBytes * 0.75);
    const contentKey = unwrapContentKeyFromEpoch(
      fixture.epochPrivateKey,
      messageRow.wrappedContentKey as WrappedSecret
    );
    const decrypted = decryptContentEnvelope(
      contentKey,
      messageRow.wrappedContentKey as WrappedSecret,
      {
        conversationId: fixture.conversationId,
        messageId,
        contentItemId,
        position: 0,
        epochNumber: 1,
        senderId: fixture.userId,
      },
      blob
    );
    expect(new TextDecoder().decode(decrypted)).toBe(answer);
  });
});
