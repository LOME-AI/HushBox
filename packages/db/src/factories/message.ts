import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { messages } from '../schema/messages';
import { placeholderBytes } from './helpers.js';

type Message = typeof messages.$inferSelect;

export const messageFactory = Factory.define<Message>(({ params }) => {
  const senderType = params.senderType ?? faker.helpers.arrayElement(['user', 'ai'] as const);
  return {
    id: crypto.randomUUID(),
    conversationId: crypto.randomUUID(),
    encryptedBlob: placeholderBytes(64),
    senderType,
    senderId: crypto.randomUUID(),
    modelName:
      senderType === 'ai'
        ? faker.helpers.arrayElement(['GPT-4o', 'Claude 3.5 Sonnet', 'Gemini Pro'])
        : null,
    payerId: null,
    cost: null,
    epochNumber: 1,
    sequenceNumber: faker.number.int({ min: 1, max: 1000 }),
    parentMessageId: null,
    createdAt: faker.date.recent(),
  };
});
