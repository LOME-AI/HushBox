import { describe, it, expect } from 'vitest';
import {
  canRegenerateMessage,
  buildMessagesForRegeneration,
  inferRegenerateModality,
  isMultiModelResponse,
  getMultiModelMessageIds,
  resolveRegenerateTarget,
  resolveRegenerateModels,
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

    expect(isMultiModelResponse(messages, 'a1')).toBe(true);
    expect(isMultiModelResponse(messages, 'a2')).toBe(true);
    expect(isMultiModelResponse(messages, 'u1')).toBe(true);
    expect(isMultiModelResponse(messages, 'a3')).toBe(false);
    expect(isMultiModelResponse(messages, 'u2')).toBe(false);
  });
});

describe('getMultiModelMessageIds', () => {
  interface TestMsg {
    id: string;
    role: string;
    parentMessageId?: string | null;
  }

  it('returns empty set when no multi-model groups exist', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
    ];

    expect(getMultiModelMessageIds(messages)).toEqual(new Set());
  });

  it('marks both siblings and the parent user message for a multi-model group', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
      { id: 'a2', role: 'assistant', parentMessageId: 'u1' },
    ];

    expect(getMultiModelMessageIds(messages)).toEqual(new Set(['u1', 'a1', 'a2']));
  });

  it('handles multiple independent groups in one pass', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
      { id: 'a2', role: 'assistant', parentMessageId: 'u1' },
      { id: 'u2', role: 'user', parentMessageId: 'a2' },
      { id: 'a3', role: 'assistant', parentMessageId: 'u2' },
      { id: 'u3', role: 'user', parentMessageId: 'a3' },
      { id: 'a4', role: 'assistant', parentMessageId: 'u3' },
      { id: 'a5', role: 'assistant', parentMessageId: 'u3' },
      { id: 'a6', role: 'assistant', parentMessageId: 'u3' },
    ];

    expect(getMultiModelMessageIds(messages)).toEqual(
      new Set(['u1', 'a1', 'a2', 'u3', 'a4', 'a5', 'a6'])
    );
  });

  it('agrees with isMultiModelResponse for every message', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
      { id: 'a2', role: 'assistant', parentMessageId: 'u1' },
      { id: 'u2', role: 'user', parentMessageId: 'a2' },
      { id: 'a3', role: 'assistant', parentMessageId: 'u2' },
    ];
    const ids = getMultiModelMessageIds(messages);
    for (const m of messages) {
      expect(ids.has(m.id)).toBe(isMultiModelResponse(messages, m.id));
    }
  });

  it('returns empty set for an empty list', () => {
    expect(getMultiModelMessageIds([])).toEqual(new Set());
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
    const messages: TestMsg[] = [{ id: 'a1', role: 'assistant', parentMessageId: null }];

    const result = resolveRegenerateTarget(messages, 'a1');
    expect(result).toEqual({ targetMessageId: 'a1', action: 'retry' });
  });

  it('returns the same ID when message is not found', () => {
    const messages: TestMsg[] = [{ id: 'u1', role: 'user', parentMessageId: null }];

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

  describe('multi-model click semantics', () => {
    it('clicking a single-model assistant does NOT set replaceAssistantId (retry-all is equivalent)', () => {
      const messages: TestMsg[] = [
        { id: 'u1', role: 'user', parentMessageId: null },
        { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
      ];

      const result = resolveRegenerateTarget(messages, 'a1');
      expect(result).toEqual({ targetMessageId: 'u1', action: 'retry' });
      expect('replaceAssistantId' in result).toBe(false);
    });

    it('clicking ONE assistant tile in a multi-model group sets replaceAssistantId to that tile', () => {
      const messages: TestMsg[] = [
        { id: 'u1', role: 'user', parentMessageId: null },
        { id: 'm1', role: 'assistant', parentMessageId: 'u1' },
        { id: 'm2', role: 'assistant', parentMessageId: 'u1' },
        { id: 'm3', role: 'assistant', parentMessageId: 'u1' },
      ];

      expect(resolveRegenerateTarget(messages, 'm2')).toEqual({
        targetMessageId: 'u1',
        action: 'retry',
        replaceAssistantId: 'm2',
      });
    });

    it('clicking the user message of a multi-model group does NOT set replaceAssistantId (retry-all)', () => {
      const messages: TestMsg[] = [
        { id: 'u1', role: 'user', parentMessageId: null },
        { id: 'm1', role: 'assistant', parentMessageId: 'u1' },
        { id: 'm2', role: 'assistant', parentMessageId: 'u1' },
      ];

      const result = resolveRegenerateTarget(messages, 'u1');
      expect(result.targetMessageId).toBe('u1');
      expect(result.action).toBe('retry');
      expect('replaceAssistantId' in result).toBe(false);
    });
  });
});

describe('resolveRegenerateModels', () => {
  interface TestMsg {
    id: string;
    role: string;
    parentMessageId?: string | null;
    modelName?: string | null;
  }

  it('returns [modelName of replaceAssistantId] when replaceAssistantId is set (regenerate-one)', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'm1', role: 'assistant', parentMessageId: 'u1', modelName: 'gpt-4o' },
      { id: 'm2', role: 'assistant', parentMessageId: 'u1', modelName: 'claude-3-5-sonnet' },
    ];

    expect(resolveRegenerateModels(messages, 'u1', 'm2', 'fallback-model')).toEqual([
      'claude-3-5-sonnet',
    ]);
  });

  it('returns ALL sibling models when replaceAssistantId is undefined (retry-all)', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'm1', role: 'assistant', parentMessageId: 'u1', modelName: 'gpt-4o' },
      { id: 'm2', role: 'assistant', parentMessageId: 'u1', modelName: 'claude-3-5-sonnet' },
      { id: 'm3', role: 'assistant', parentMessageId: 'u1', modelName: 'gemini-1.5-pro' },
    ];

    expect(resolveRegenerateModels(messages, 'u1', undefined, 'fallback-model')).toEqual([
      'gpt-4o',
      'claude-3-5-sonnet',
      'gemini-1.5-pro',
    ]);
  });

  it('returns fallback when target has no assistant children (fresh send, retry-all)', () => {
    const messages: TestMsg[] = [{ id: 'u1', role: 'user', parentMessageId: null }];

    expect(resolveRegenerateModels(messages, 'u1', undefined, 'fallback-model')).toEqual([
      'fallback-model',
    ]);
  });

  it('returns fallback when replaceAssistantId has no modelName', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'm1', role: 'assistant', parentMessageId: 'u1', modelName: null },
    ];

    expect(resolveRegenerateModels(messages, 'u1', 'm1', 'fallback-model')).toEqual([
      'fallback-model',
    ]);
  });

  it('returns fallback when replaceAssistantId does not exist', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'm1', role: 'assistant', parentMessageId: 'u1', modelName: 'gpt-4o' },
    ];

    expect(resolveRegenerateModels(messages, 'u1', 'nonexistent', 'fallback-model')).toEqual([
      'fallback-model',
    ]);
  });

  it('skips siblings without modelName when collecting retry-all models', () => {
    const messages: TestMsg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'm1', role: 'assistant', parentMessageId: 'u1', modelName: 'gpt-4o' },
      { id: 'm2', role: 'assistant', parentMessageId: 'u1', modelName: null },
    ];

    expect(resolveRegenerateModels(messages, 'u1', undefined, 'fallback-model')).toEqual([
      'gpt-4o',
    ]);
  });

  describe('Smart Model preservation', () => {
    interface SmartTestMsg {
      id: string;
      role: string;
      parentMessageId?: string | null;
      modelName?: string | null;
      isSmartModel?: boolean;
    }

    it("emits 'smart-model' for regenerate-one of a Smart Model tile, not the resolved id", () => {
      const messages: SmartTestMsg[] = [
        { id: 'u1', role: 'user', parentMessageId: null },
        {
          id: 'm1',
          role: 'assistant',
          parentMessageId: 'u1',
          modelName: 'anthropic/claude-sonnet-4.6',
          isSmartModel: true,
        },
      ];

      expect(resolveRegenerateModels(messages, 'u1', 'm1', 'fallback-model')).toEqual([
        'smart-model',
      ]);
    });

    it("emits 'smart-model' for retry-all when target has a Smart Model child", () => {
      const messages: SmartTestMsg[] = [
        { id: 'u1', role: 'user', parentMessageId: null },
        {
          id: 'm1',
          role: 'assistant',
          parentMessageId: 'u1',
          modelName: 'anthropic/claude-sonnet-4.6',
          isSmartModel: true,
        },
      ];

      expect(resolveRegenerateModels(messages, 'u1', undefined, 'fallback-model')).toEqual([
        'smart-model',
      ]);
    });

    it('preserves Smart Model in mixed retry-all sibling sets', () => {
      const messages: SmartTestMsg[] = [
        { id: 'u1', role: 'user', parentMessageId: null },
        {
          id: 'm1',
          role: 'assistant',
          parentMessageId: 'u1',
          modelName: 'anthropic/claude-sonnet-4.6',
          isSmartModel: true,
        },
        {
          id: 'm2',
          role: 'assistant',
          parentMessageId: 'u1',
          modelName: 'openai/gpt-4o',
          isSmartModel: false,
        },
      ];

      expect(resolveRegenerateModels(messages, 'u1', undefined, 'fallback-model')).toEqual([
        'smart-model',
        'openai/gpt-4o',
      ]);
    });

    it('does not emit smart-model for non-Smart-Model messages even with same resolved id', () => {
      const messages: SmartTestMsg[] = [
        { id: 'u1', role: 'user', parentMessageId: null },
        {
          id: 'm1',
          role: 'assistant',
          parentMessageId: 'u1',
          modelName: 'anthropic/claude-sonnet-4.6',
          isSmartModel: false,
        },
      ];

      expect(resolveRegenerateModels(messages, 'u1', 'm1', 'fallback-model')).toEqual([
        'anthropic/claude-sonnet-4.6',
      ]);
    });
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
      const result = buildMessagesForRegeneration([userMsg, assistantMsg], 'nonexistent', 'retry');

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

describe('inferRegenerateModality', () => {
  interface Msg {
    id: string;
    role: string;
    parentMessageId?: string | null;
    mediaItems?: { contentType: 'image' | 'audio' | 'video' }[] | undefined;
  }

  it('returns the AI childs first mediaItem contentType for image', () => {
    const messages: Msg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      {
        id: 'a1',
        role: 'assistant',
        parentMessageId: 'u1',
        mediaItems: [{ contentType: 'image' }],
      },
    ];

    expect(inferRegenerateModality('u1', messages)).toBe('image');
  });

  it('returns video when the AI child has a video mediaItem', () => {
    const messages: Msg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      {
        id: 'a1',
        role: 'assistant',
        parentMessageId: 'u1',
        mediaItems: [{ contentType: 'video' }],
      },
    ];

    expect(inferRegenerateModality('u1', messages)).toBe('video');
  });

  it('returns audio when the AI child has an audio mediaItem', () => {
    const messages: Msg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      {
        id: 'a1',
        role: 'assistant',
        parentMessageId: 'u1',
        mediaItems: [{ contentType: 'audio' }],
      },
    ];

    expect(inferRegenerateModality('u1', messages)).toBe('audio');
  });

  it('returns text when the AI child has no mediaItems (text reply)', () => {
    const messages: Msg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'a1', role: 'assistant', parentMessageId: 'u1' },
    ];

    expect(inferRegenerateModality('u1', messages)).toBe('text');
  });

  it('returns text when the user message has no AI child yet', () => {
    const messages: Msg[] = [{ id: 'u1', role: 'user', parentMessageId: null }];

    expect(inferRegenerateModality('u1', messages)).toBe('text');
  });

  it('returns text when the target id is not found', () => {
    const messages: Msg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      {
        id: 'a1',
        role: 'assistant',
        parentMessageId: 'u1',
        mediaItems: [{ contentType: 'image' }],
      },
    ];

    expect(inferRegenerateModality('nonexistent', messages)).toBe('text');
  });

  it('ignores user messages with the same parent (only checks assistant role)', () => {
    const messages: Msg[] = [
      { id: 'u1', role: 'user', parentMessageId: null },
      { id: 'u2', role: 'user', parentMessageId: 'u1', mediaItems: [{ contentType: 'image' }] },
    ];

    expect(inferRegenerateModality('u1', messages)).toBe('text');
  });
});
