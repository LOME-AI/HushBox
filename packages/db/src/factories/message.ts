import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { messages } from '../schema/messages';
import { placeholderBytes } from './helpers.js';

type Message = typeof messages.$inferSelect;

export const messageFactory = Factory.define<Message>(() => ({
  id: crypto.randomUUID(),
  conversationId: crypto.randomUUID(),
  encryptedBlob: placeholderBytes(64),
  senderType: faker.helpers.arrayElement(['user', 'ai']),
  senderId: crypto.randomUUID(),
  senderDisplayName: null,
  payerId: null,
  cost: null,
  epochNumber: 1,
  sequenceNumber: faker.number.int({ min: 1, max: 1000 }),
  createdAt: faker.date.recent(),
}));
