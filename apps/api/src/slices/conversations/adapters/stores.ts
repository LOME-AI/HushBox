import { createConversationsStore } from './conversations-store.js';
import { createEpochsStore } from './epochs-store.js';
import { createForksStore } from './forks-store.js';
import { createMembersStore } from './members-store.js';
import { createMessagesReader } from './messages-reader.js';
import { createSharedLinksStore } from './shared-links-store.js';
import { createSharedMessagesStore } from './shared-messages-store.js';
import { createUsersReader } from './users-reader.js';
import type { DbWriter } from '../../../lib/idempotency/index.js';
import type { ConversationsStores } from '../ports/index.js';

/**
 * Drizzle implementation of the slice's stores. Bound to the request client
 * or an open transaction; every method is a single statement (or read), so
 * atomicity boundaries stay with the domain orchestration that owns them.
 */
export function createConversationsStores(db: DbWriter): ConversationsStores {
  return {
    conversations: createConversationsStore(db),
    members: createMembersStore(db),
    epochs: createEpochsStore(db),
    users: createUsersReader(db),
    messages: createMessagesReader(db),
    forks: createForksStore(db),
    sharedLinks: createSharedLinksStore(db),
    sharedMessages: createSharedMessagesStore(db),
  };
}
