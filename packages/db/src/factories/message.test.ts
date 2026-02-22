import { describe, it, expect } from 'vitest';

import { messageFactory } from './index';

describe('messageFactory', () => {
  it('builds a complete message object', () => {
    const message = messageFactory.build();

    expect(message.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(message.conversationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(['user', 'ai']).toContain(message.senderType);
    expect(message.encryptedBlob).toBeInstanceOf(Uint8Array);
    expect(message.encryptedBlob.length).toBeGreaterThan(0);
    expect(message.createdAt).toBeInstanceOf(Date);
  });

  it('generates epoch and sequence fields', () => {
    const message = messageFactory.build();

    expect(message.epochNumber).toBe(1);
    expect(message.sequenceNumber).toBeGreaterThanOrEqual(1);
  });

  it('generates nullable fields', () => {
    const message = messageFactory.build();

    expect(message.senderDisplayName).toBeNull();
    expect(message.payerId).toBeNull();
  });

  it('generates senderId as UUID', () => {
    const message = messageFactory.build();

    expect(message.senderId).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it('allows field overrides', () => {
    const customBlob = new TextEncoder().encode('Custom content');
    const message = messageFactory.build({ senderType: 'ai', encryptedBlob: customBlob });
    expect(message.senderType).toBe('ai');
    expect(message.encryptedBlob).toEqual(customBlob);
  });

  it('builds a list with unique IDs', () => {
    const messageList = messageFactory.buildList(3);
    expect(messageList).toHaveLength(3);
    const ids = new Set(messageList.map((m) => m.id));
    expect(ids.size).toBe(3);
  });
});
