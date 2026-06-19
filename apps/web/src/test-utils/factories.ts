import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';
import type { Message } from '@/lib/api';

/**
 * Group-chat member as the frontend renders it (see `GroupChatProps.members`
 * in chat-layout and the inline `{ id, userId, username, privilege }` shape
 * repeated across chat components). Kept local because the frontend display
 * shape has no exported named type.
 */
export interface GroupMember {
  id: string;
  userId: string;
  username: string;
  privilege: string;
}

const PRIVILEGES = ['read', 'write', 'admin', 'owner'] as const;

/**
 * Frontend test factories with `id` and `userId` (or `senderId`) seeded to
 * DISTINCT values by default. A swapped id/userId is a whole class of bug that
 * stays invisible when both fields carry the same fixture string; distinct
 * defaults make the swap fail a test instead of passing silently.
 */
export const memberFactory = Factory.define<GroupMember>(({ sequence }) => ({
  id: `member-${String(sequence)}`,
  userId: `user-${String(sequence)}`,
  username: faker.internet.username(),
  privilege: faker.helpers.arrayElement(PRIVILEGES),
}));

export const messageFactory = Factory.define<Message>(({ sequence }) => ({
  id: `message-${String(sequence)}`,
  conversationId: `conversation-${String(sequence)}`,
  role: faker.helpers.arrayElement(['user', 'assistant'] as const),
  content: faker.lorem.sentence(),
  createdAt: faker.date.recent().toISOString(),
  senderId: `sender-${String(sequence)}`,
}));

export interface ConversationListItemFixture {
  id: string;
  userId: string;
  title: string;
  currentEpoch: number;
  titleEpochNumber: number;
  nextSequence: number;
  createdAt: string;
  updatedAt: string;
  accepted: boolean;
  invitedByUsername: string | null;
  privilege: string;
  muted: boolean;
  pinned: boolean;
}

export const conversationFactory = Factory.define<ConversationListItemFixture>(({ sequence }) => ({
  id: `conversation-${String(sequence)}`,
  userId: `user-${String(sequence)}`,
  title: faker.lorem.words(3),
  currentEpoch: 1,
  titleEpochNumber: 1,
  nextSequence: 1,
  createdAt: faker.date.recent().toISOString(),
  updatedAt: faker.date.recent().toISOString(),
  accepted: true,
  invitedByUsername: null,
  privilege: faker.helpers.arrayElement(PRIVILEGES),
  muted: false,
  pinned: false,
}));
