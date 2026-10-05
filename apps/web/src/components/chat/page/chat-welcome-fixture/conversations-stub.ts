import * as React from 'react';
import { DAY_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import type { ConversationListItem } from '@hushbox/shared';

/** The fields of a conversation the Continue list reads. */
type ContinueConversation = Pick<ConversationListItem, 'id' | 'title' | 'updatedAt' | 'accepted'>;

/**
 * Three recent conversations, one titled long enough to wrap on a phone, as the mobile
 * first-screen check seeds them.
 */
const RECENT: readonly ContinueConversation[] = [
  {
    id: 'conversation-rail-trip',
    title:
      'Planning a two-week rail trip through northern Italy with stops for food, hiking and museums',
    updatedAt: new Date(TEST_DAY_START).toISOString(),
    accepted: true,
  },
  {
    id: 'conversation-tax',
    title: 'Tax questions',
    updatedAt: new Date(TEST_DAY_START - DAY_MS).toISOString(),
    accepted: true,
  },
  {
    id: 'conversation-sourdough',
    title: 'Sourdough starter',
    updatedAt: new Date(TEST_DAY_START - 2 * DAY_MS).toISOString(),
    accepted: true,
  },
];

let conversations: readonly ContinueConversation[] | undefined;
const listeners = new Set<() => void>();

/** Answers the conversation list query, as the network does once the page has painted. */
export function resolveConversations(): void {
  conversations = RECENT;
  for (const listener of listeners) listener();
}

/** Puts the conversation list query back in flight, for a fresh mount. */
export function resetConversations(): void {
  conversations = undefined;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Stands in for the decrypted conversation list inside `chat-welcome.browser.test.ts`'s
 * fixture, for the Continue list alone: in flight until the test resolves it.
 * @toolContract
 */
export function useDecryptedConversations(): { data: readonly ContinueConversation[] | undefined } {
  const data = React.useSyncExternalStore(subscribe, () => conversations);
  return { data };
}
