import { describe, it, expect } from 'vitest';

import { messageFactory } from './index';

describe('messageFactory', () => {
  it('builds a complete message object', () => {
    const message = messageFactory.build();

    expect(message.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(message.conversationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(['user', 'assistant', 'system']).toContain(message.role);
    expect(message.content).toBeTruthy();
    expect(message.createdAt).toBeInstanceOf(Date);
  });

  it('allows field overrides', () => {
    const message = messageFactory.build({ role: 'system', content: 'Custom content' });
    expect(message.role).toBe('system');
    expect(message.content).toBe('Custom content');
  });

  it('builds a list with unique IDs', () => {
    const messageList = messageFactory.buildList(3);
    expect(messageList).toHaveLength(3);
    const ids = new Set(messageList.map((m) => m.id));
    expect(ids.size).toBe(3);
  });
});
