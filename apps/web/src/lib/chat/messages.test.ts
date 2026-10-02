import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TEST_DAY_START, freezeClock, isoAt } from '@hushbox/shared/test-time';
import {
  adoptServerMessageId,
  adoptServerMessageIdIn,
  createUserMessage,
  createAssistantMessage,
  createTrialMessage,
} from './messages';

describe('chat/messages', () => {
  beforeEach(() => {
    freezeClock(TEST_DAY_START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('adoptServerMessageId', () => {
    it('re-keys an optimistic row to the id the server stored it under', () => {
      const optimistic = createUserMessage('conv-123', 'Hello', 'user-42', 'parent-msg-id');

      const adopted = adoptServerMessageId(optimistic, 'server-id');

      expect(adopted).toEqual({ ...optimistic, id: 'server-id' });
    });

    it('leaves the optimistic row itself untouched', () => {
      const optimistic = createUserMessage('conv-123', 'Hello', undefined, null);
      const localKey = optimistic.id;

      adoptServerMessageId(optimistic, 'server-id');

      expect(optimistic.id).toBe(localKey);
    });
  });

  describe('adoptServerMessageIdIn', () => {
    it('re-keys only the row under the local key, leaving every other row as it was', () => {
      const earlier = createUserMessage('conv-123', 'Earlier', undefined, null);
      const optimistic = createUserMessage('conv-123', 'Now', undefined, earlier.id);

      const adopted = adoptServerMessageIdIn([earlier, optimistic], optimistic.id, 'server-id');

      expect(adopted).toEqual([earlier, { ...optimistic, id: 'server-id' }]);
      expect(adopted[0]).toBe(earlier);
    });

    it('moves the rows parented to the re-keyed row onto its new id', () => {
      const userRow = createUserMessage('conv-123', 'Now', undefined, null);
      const tile = createAssistantMessage('conv-123', 'assistant-1', 'model-a', userRow.id);

      const adopted = adoptServerMessageIdIn([userRow, tile], userRow.id, 'server-id');

      expect(adopted).toEqual([
        { ...userRow, id: 'server-id' },
        { ...tile, parentMessageId: 'server-id' },
      ]);
    });
  });

  describe('createUserMessage', () => {
    it('creates a user message with correct structure', () => {
      const message = createUserMessage('conv-123', 'Hello world', undefined, null);

      expect(message).toMatchObject({
        conversationId: 'conv-123',
        role: 'user',
        content: 'Hello world',
        createdAt: isoAt(TEST_DAY_START),
        parentMessageId: null,
      });
      expect(message.id).toBeDefined();
      expect(typeof message.id).toBe('string');
    });

    it('generates unique IDs for each message', () => {
      const message1 = createUserMessage('conv-123', 'First', undefined, null);
      const message2 = createUserMessage('conv-123', 'Second', undefined, null);

      expect(message1.id).not.toBe(message2.id);
    });

    it('includes senderId when provided', () => {
      const message = createUserMessage('conv-123', 'Hello', 'user-42', null);

      expect(message.senderId).toBe('user-42');
    });

    it('omits senderId when not provided', () => {
      const message = createUserMessage('conv-123', 'Hello', undefined, null);

      expect(message.senderId).toBeUndefined();
    });

    it('includes parentMessageId when provided', () => {
      const message = createUserMessage('conv-123', 'Hello', 'user-42', 'parent-msg-id');

      expect(message.parentMessageId).toBe('parent-msg-id');
    });

    it('sets parentMessageId to null when not provided', () => {
      const message = createUserMessage('conv-123', 'Hello', undefined, null);

      expect(message.parentMessageId).toBeNull();
    });
  });

  describe('createAssistantMessage', () => {
    it('creates an assistant message with empty content', () => {
      const message = createAssistantMessage('conv-456', 'assistant-msg-id', undefined, null);

      expect(message).toEqual({
        id: 'assistant-msg-id',
        conversationId: 'conv-456',
        role: 'assistant',
        content: '',
        createdAt: isoAt(TEST_DAY_START),
        parentMessageId: null,
      });
    });

    it('uses the provided assistant message ID', () => {
      const message = createAssistantMessage('conv-789', 'custom-id-123', undefined, null);

      expect(message.id).toBe('custom-id-123');
    });

    it('includes modelName when provided', () => {
      const message = createAssistantMessage('conv-456', 'msg-id', 'GPT-4o', null);

      expect(message.modelName).toBe('GPT-4o');
    });

    it('omits modelName when not provided', () => {
      const message = createAssistantMessage('conv-456', 'msg-id', undefined, null);

      expect(message.modelName).toBeUndefined();
    });

    it('includes parentMessageId when provided', () => {
      const message = createAssistantMessage('conv-456', 'msg-id', 'GPT-4o', 'parent-msg-id');

      expect(message.parentMessageId).toBe('parent-msg-id');
    });

    it('sets parentMessageId to null when not provided', () => {
      const message = createAssistantMessage('conv-456', 'msg-id', undefined, null);

      expect(message.parentMessageId).toBeNull();
    });
  });

  describe('createTrialMessage', () => {
    it('creates a trial user message with generated ID', () => {
      const message = createTrialMessage('user', 'Hello from guest');

      expect(message).toMatchObject({
        conversationId: 'trial',
        role: 'user',
        content: 'Hello from guest',
        createdAt: isoAt(TEST_DAY_START),
      });
      expect(message.id).toBeDefined();
    });

    it('creates a trial assistant message with provided ID', () => {
      const message = createTrialMessage('assistant', '', 'provided-id');

      expect(message).toEqual({
        id: 'provided-id',
        conversationId: 'trial',
        role: 'assistant',
        content: '',
        createdAt: isoAt(TEST_DAY_START),
      });
    });

    it('generates ID when not provided', () => {
      const message1 = createTrialMessage('user', 'Test');
      const message2 = createTrialMessage('user', 'Test');

      expect(message1.id).not.toBe(message2.id);
    });

    it('includes modelName when provided', () => {
      const message = createTrialMessage('assistant', '', 'msg-id', 'smart-model');

      expect(message.modelName).toBe('smart-model');
    });

    it('omits modelName when not provided', () => {
      const message = createTrialMessage('assistant', '', 'msg-id');

      expect(message.modelName).toBeUndefined();
    });
  });
});
