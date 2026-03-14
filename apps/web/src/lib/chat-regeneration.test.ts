import { describe, it, expect } from 'vitest';
import {
  canRegenerateMessage,
  buildMessagesForRegeneration,
  isMultiModelResponse,
  resolveRegenerateTarget,
} from './chat-regeneration.js';

interface TestMessage {
  id: string;
  role: string;
  senderId?: string | null;
}

describe('canRegenerateMessage', () => {
  describe('solo chat', () => {
    it('returns true for own user message', () => {
      const messages: TestMessage[] = [
        { id: 'm1', role: 'user', senderId: 'user-1' },
        { id: 'm2', role: 'assistant', senderId: null },
      ];

      expect(canRegenerateMessage(messages, 'm1', 'user-1', false)).toBe(true);
    });

    it('returns true for AI message', () => {
      const messages: TestMessage[] = [
        { id: 'm1', role: 'user', senderId: 'user-1' },
        { id: 'm2', role: 'assistant', senderId: null },
      ];

      expect(canRegenerateMessage(messages, 'm2', 'user-1', false)).toBe(true);
    });
  });

  describe('group chat', () => {
    it('returns true when no other user sent a message after the target', () => {
      const messages: TestMessage[] = [
        { id: 'm1', role: 'user', senderId: 'user-1' },
        { id: 'm2', role: 'assistant', senderId: null },
        { id: 'm3', role: 'user', senderId: 'user-1' },
      ];

      expect(canRegenerateMessage(messages, 'm1', 'user-1', true)).toBe(true);
    });

    it('returns false when another user sent a message after the target', () => {
      const messages: TestMessage[] = [
        { id: 'm1', role: 'user', senderId: 'user-1' },
        { id: 'm2', role: 'assistant', senderId: null },
        { id: 'm3', role: 'user', senderId: 'user-2' },
      ];

      expect(canRegenerateMessage(messages, 'm1', 'user-1', true)).toBe(false);
    });

    it('returns false when another user replied after AI response to target', () => {
      const messages: TestMessage[] = [
        { id: 'm1', role: 'user', senderId: 'user-1' },
        { id: 'm2', role: 'assistant', senderId: null },
        { id: 'm3', role: 'user', senderId: 'user-2' },
        { id: 'm4', role: 'assistant', senderId: null },
      ];

      expect(canRegenerateMessage(messages, 'm1', 'user-1', true)).toBe(false);
    });

    it('ignores AI messages when checking for other users', () => {
      const messages: TestMessage[] = [
        { id: 'm1', role: 'user', senderId: 'user-1' },
        { id: 'm2', role: 'assistant', senderId: null },
        { id: 'm3', role: 'assistant', senderId: null },
      ];

      expect(canRegenerateMessage(messages, 'm1', 'user-1', true)).toBe(true);
    });

    it('returns true for the last message (nothing after it)', () => {
      const messages: TestMessage[] = [
        { id: 'm1', role: 'user', senderId: 'user-1' },
        { id: 'm2', role: 'user', senderId: 'user-2' },
        { id: 'm3', role: 'assistant', senderId: null },
      ];

      expect(canRegenerateMessage(messages, 'm3', 'user-1', true)).toBe(true);
    });

    it('returns false when target is not own message', () => {
      const messages: TestMessage[] = [
        { id: 'm1', role: 'user', senderId: 'user-2' },
        { id: 'm2', role: 'assistant', senderId: null },
      ];

      expect(canRegenerateMessage(messages, 'm1', 'user-1', true)).toBe(false);
    });

    it('returns true when target message not found', () => {
      const messages: TestMessage[] = [{ id: 'm1', role: 'user', senderId: 'user-1' }];

      expect(canRegenerateMessage(messages, 'nonexistent', 'user-1', true)).toBe(true);
    });
  });
});

describe('isMultiModelResponse', () => {
  interface TestMsg {
    id: string;
    role: string;
    parentMessageId?: string | null;
  }

  it('returns false for a single assistant response', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
    ];

    expect(isMultiModelResponse(messages, 'a1')).toBe(false);
  });

  it('returns true for an assistant message with a sibling sharing the same parentMessageId', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
      { id: 'a2', role: 'assistant', parentMessageId: 'u1' },
    ];

    expect(isMultiModelResponse(messages, 'a1')).toBe(true);
    expect(isMultiModelResponse(messages, 'a2')).toBe(true);
  });

  it('returns true for a user message with multiple assistant children', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
      { id: 'a2', role: 'assistant', parentMessageId: 'u1' },
    ];

    expect(isMultiModelResponse(messages, 'u1')).toBe(true);
  });

  it('returns false for a user message with only one assistant child', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
    ];

    expect(isMultiModelResponse(messages, 'u1')).toBe(false);
  });

  it('returns false when target message is not found', () => {
    const messages: TestMsg[] = [{ id: 'u1', role: 'user', parentMessageId: null }];

    expect(isMultiModelResponse(messages, 'nonexistent')).toBe(false);
  });

  it('returns false for assistant message without parentMessageId', () => {
    const messages: TestMsg[] = [{ id: 'a1', role: 'assistant', parentMessageId: null }];

    expect(isMultiModelResponse(messages, 'a1')).toBe(false);
  });

  it('does not count user messages as siblings', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
      { id: 'u2', role: 'user', parentMessageId: 'u1' },
    ];

    expect(isMultiModelResponse(messages, 'a1')).toBe(false);
  });

  it('handles multiple conversation turns independently', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
      { id: 'a2', role: 'assistant', parentMessageId: 'u1' },
      { id: 'u2', role: 'user', parentMessageId: 'a2' },
      { id: 'a3', role: 'assistant', parentMessageId: 'u2' },
    ];

    // Multi-model turn
    expect(isMultiModelResponse(messages, 'a1')).toBe(true);
    expect(isMultiModelResponse(messages, 'a2')).toBe(true);
    expect(isMultiModelResponse(messages, 'u1')).toBe(true);
    // Single-model turn
    expect(isMultiModelResponse(messages, 'a3')).toBe(false);
    expect(isMultiModelResponse(messages, 'u2')).toBe(false);
  });
});

describe('resolveRegenerateTarget', () => {
  interface TestMsg {
    id: string;
    role: string;
    parentMessageId?: string | null;
  }

  it('resolves assistant message to its parent user message with action retry', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
    ];

    const result = resolveRegenerateTarget(messages, 'a1');
    expect(result).toEqual({ targetMessageId: 'u1', action: 'retry' });
  });

  it('returns the same ID for a user message', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
    ];

    const result = resolveRegenerateTarget(messages, 'u1');
    expect(result).toEqual({ targetMessageId: 'u1', action: 'retry' });
  });

  it('falls back to same ID when assistant has no parentMessageId', () => {
    const messages: TestMsg[] = [
      { id: 'a1', role: 'assistant', parentMessageId: null },
    ];

    const result = resolveRegenerateTarget(messages, 'a1');
    expect(result).toEqual({ targetMessageId: 'a1', action: 'retry' });
  });

  it('returns the same ID when message is not found', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
    ];

    const result = resolveRegenerateTarget(messages, 'nonexistent');
    expect(result).toEqual({ targetMessageId: 'nonexistent', action: 'retry' });
  });

  it('resolves correctly in a multi-turn conversation', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
      { id: 'u2', role: 'user', parentMessageId: 'a1' },
      { id: 'a2', role: 'assistant', parentMessageId: 'u2' },
    ];

    const result = resolveRegenerateTarget(messages, 'a2');
    expect(result).toEqual({ targetMessageId: 'u2', action: 'retry' });
  });
});

describe('buildMessagesForRegeneration', () => {
  const userMsg = { id: 'm1', role: 'user' as const, content: 'Hello' };
  const assistantMsg = { id: 'm2', role: 'assistant' as const, content: 'Hi there' };
  const userMsg2 = { id: 'm3', role: 'user' as const, content: 'Follow up' };
  const assistantMsg2 = { id: 'm4', role: 'assistant' as const, content: 'Sure thing' };

  describe('retry action (target is user message — unified for retry and regenerate)', () => {
    it('includes the target user message', () => {
      const result = buildMessagesForRegeneration([userMsg, assistantMsg], 'm1', 'retry');

      expect(result).toEqual([{ role: 'user', content: 'Hello' }]);
    });

    it('includes target user message in longer conversation', () => {
      const result = buildMessagesForRegeneration(
        [userMsg, assistantMsg, userMsg2, assistantMsg2],
        'm3',
        'retry'
      );

      expect(result).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'Follow up' },
      ]);
    });

    it('last message in result is always the target user message', () => {
      const result = buildMessagesForRegeneration([userMsg, assistantMsg], 'm1', 'retry');

      expect(result.at(-1)?.role).toBe('user');
    });
  });

  describe('edit action', () => {
    it('excludes target message and appends edited content', () => {
      const result = buildMessagesForRegeneration(
        [userMsg, assistantMsg],
        'm1',
        'edit',
        'Edited hello'
      );

      expect(result).toEqual([{ role: 'user', content: 'Edited hello' }]);
    });

    it('preserves messages before the target', () => {
      const result = buildMessagesForRegeneration(
        [userMsg, assistantMsg, userMsg2, assistantMsg2],
        'm3',
        'edit',
        'New follow up'
      );

      expect(result).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
        { role: 'user', content: 'New follow up' },
      ]);
    });
  });

  describe('edge cases', () => {
    it('returns all messages when target not found', () => {
      const result = buildMessagesForRegeneration(
        [userMsg, assistantMsg],
        'nonexistent',
        'retry'
      );

      expect(result).toEqual([
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there' },
      ]);
    });

    it('returns empty array when no messages', () => {
      const result = buildMessagesForRegeneration([], 'm1', 'retry');

      expect(result).toEqual([]);
    });
  });
});
