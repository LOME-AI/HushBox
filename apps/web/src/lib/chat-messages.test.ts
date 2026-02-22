import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createUserMessage,
  createAssistantMessage,
  createTrialMessage,
  appendTokenToMessage,
  type ChatErrorDisplay,
} from './chat-messages';

describe('chat-messages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2024-01-15T10:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('createUserMessage', () => {
    it('creates a user message with correct structure', () => {
      const message = createUserMessage('conv-123', 'Hello world');

      expect(message).toMatchObject({
        conversationId: 'conv-123',
        role: 'user',
        content: 'Hello world',
        createdAt: '2024-01-15T10:00:00.000Z',
      });
      expect(message.id).toBeDefined();
      expect(typeof message.id).toBe('string');
    });

    it('generates unique IDs for each message', () => {
      const message1 = createUserMessage('conv-123', 'First');
      const message2 = createUserMessage('conv-123', 'Second');

      expect(message1.id).not.toBe(message2.id);
    });

    it('includes senderId when provided', () => {
      const message = createUserMessage('conv-123', 'Hello', 'user-42');

      expect(message.senderId).toBe('user-42');
    });

    it('omits senderId when not provided', () => {
      const message = createUserMessage('conv-123', 'Hello');

      expect(message.senderId).toBeUndefined();
    });
  });

  describe('createAssistantMessage', () => {
    it('creates an assistant message with empty content', () => {
      const message = createAssistantMessage('conv-456', 'assistant-msg-id');

      expect(message).toEqual({
        id: 'assistant-msg-id',
        conversationId: 'conv-456',
        role: 'assistant',
        content: '',
        createdAt: '2024-01-15T10:00:00.000Z',
      });
    });

    it('uses the provided assistant message ID', () => {
      const message = createAssistantMessage('conv-789', 'custom-id-123');

      expect(message.id).toBe('custom-id-123');
    });
  });

  describe('createTrialMessage', () => {
    it('creates a trial user message with generated ID', () => {
      const message = createTrialMessage('user', 'Hello from guest');

      expect(message).toMatchObject({
        conversationId: 'trial',
        role: 'user',
        content: 'Hello from guest',
        createdAt: '2024-01-15T10:00:00.000Z',
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
        createdAt: '2024-01-15T10:00:00.000Z',
      });
    });

    it('generates ID when not provided', () => {
      const message1 = createTrialMessage('user', 'Test');
      const message2 = createTrialMessage('user', 'Test');

      expect(message1.id).not.toBe(message2.id);
    });
  });

  describe('ChatErrorDisplay', () => {
    it('has the correct shape', () => {
      const errorDisplay: ChatErrorDisplay = {
        id: 'err-1',
        role: 'assistant',
        content: 'Error message',
        retryable: true,
        isError: true,
      };

      expect(errorDisplay.role).toBe('assistant');
      expect(errorDisplay.isError).toBe(true);
      expect(errorDisplay.retryable).toBe(true);
    });
  });

  describe('appendTokenToMessage', () => {
    it('appends token to the correct message', () => {
      const messages = [
        { id: 'msg-1', content: 'Hello' },
        { id: 'msg-2', content: 'World' },
      ];

      const result = appendTokenToMessage(messages, 'msg-1', ' there');

      expect(result).toEqual([
        { id: 'msg-1', content: 'Hello there' },
        { id: 'msg-2', content: 'World' },
      ]);
    });

    it('does not modify original array', () => {
      const messages = [{ id: 'msg-1', content: 'Original' }];

      appendTokenToMessage(messages, 'msg-1', ' suffix');

      expect(messages[0]?.content).toBe('Original');
    });

    it('returns unchanged array if message not found', () => {
      const messages = [{ id: 'msg-1', content: 'Hello' }];

      const result = appendTokenToMessage(messages, 'nonexistent', ' token');

      expect(result).toEqual(messages);
    });

    it('works with empty messages array', () => {
      const result = appendTokenToMessage([], 'msg-1', 'token');

      expect(result).toEqual([]);
    });

    it('handles multiple consecutive appends', () => {
      let messages = [{ id: 'msg-1', content: '' }];
      messages = appendTokenToMessage(messages, 'msg-1', 'Hello');
      messages = appendTokenToMessage(messages, 'msg-1', ' ');
      messages = appendTokenToMessage(messages, 'msg-1', 'World');

      expect(messages[0]?.content).toBe('Hello World');
    });
  });
});
