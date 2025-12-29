import { describe, it, expect } from 'vitest';

import { conversationFactory } from './index';

describe('conversationFactory', () => {
  it('builds a complete conversation object', () => {
    const conversation = conversationFactory.build();

    expect(conversation.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(conversation.userId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(conversation.title).toBeTruthy();
    expect(conversation.createdAt).toBeInstanceOf(Date);
    expect(conversation.updatedAt).toBeInstanceOf(Date);
  });

  it('allows field overrides', () => {
    const conversation = conversationFactory.build({ title: 'Custom Title' });
    expect(conversation.title).toBe('Custom Title');
  });

  it('builds a list with unique IDs', () => {
    const conversationList = conversationFactory.buildList(3);
    expect(conversationList).toHaveLength(3);
    const ids = new Set(conversationList.map((c) => c.id));
    expect(ids.size).toBe(3);
  });
});
