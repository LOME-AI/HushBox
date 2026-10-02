import { eq } from 'drizzle-orm';
import { messages, sharedMessages } from '@hushbox/db';
import { fromPromise, okAsync } from '../../../lib/result/index.js';
import { storeFailure } from './store-failure.js';
import { contentItemsByMessage } from './content-item-reads.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { SharedMessagesStore, SharedMessageRecord } from '../ports/stores.js';

export function createSharedMessagesStore(db: DbWriter): SharedMessagesStore {
  return {
    insert: ({ messageId, createdBy, wrappedContentKey }) =>
      fromPromise(
        db
          .insert(sharedMessages)
          .values({ messageId, createdBy, wrappedContentKey })
          .returning({ id: sharedMessages.id, createdAt: sharedMessages.createdAt }),
        storeFailure
      ).map((rows) => {
        const row = rows[0];
        if (row === undefined)
          throw new Error('conversations: shared message insert returned no row');
        return row;
      }),

    byId: (shareId) => selectSharedMessage(db, shareId),
  };
}

/** One standalone share by id, with its message's content items attached. */
function selectSharedMessage(
  db: DbWriter,
  shareId: string
): ResultAsync<SharedMessageRecord | null, DomainError> {
  return fromPromise(
    db
      .select({
        id: sharedMessages.id,
        messageId: sharedMessages.messageId,
        wrappedContentKey: sharedMessages.wrappedContentKey,
        createdAt: sharedMessages.createdAt,
        messageCreatedAt: messages.createdAt,
        conversationId: messages.conversationId,
        epochNumber: messages.epochNumber,
        senderId: messages.senderId,
        epochWrappedContentKey: messages.wrappedContentKey,
        deletedAt: messages.deletedAt,
      })
      .from(sharedMessages)
      // The shared message's own row carries the location fields and the epoch
      // wrap that every content item's envelope AAD binds; without them the
      // visitor holds the content key and still cannot open the ciphertext.
      .innerJoin(messages, eq(messages.id, sharedMessages.messageId))
      .where(eq(sharedMessages.id, shareId)),
    storeFailure
  ).andThen((rows) => {
    const row = rows[0];
    if (row === undefined) return okAsync<SharedMessageRecord | null, DomainError>(null);
    return contentItemsByMessage(db, [row.messageId]).map((byMessage) => ({
      ...row,
      contentItems: byMessage.get(row.messageId) ?? [],
    }));
  });
}
