import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createUserMessage,
  createAssistantMessage,
  createGuestMessage,
  appendTokenToMessage,
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

  describe('createGuestMessage', () => {
    it('creates a guest user message with generated ID', () => {
      const message = createGuestMessage('user', 'Hello from guest');

      expect(message).toMatchObject({
        conversationId: 'guest',
        role: 'user',
        content: 'Hello from guest',
        createdAt: '2024-01-15T10:00:00.000Z',
      });
      expect(message.id).toBeDefined();
    });

    it('creates a guest assistant message with provided ID', () => {
      const message = createGuestMessage('assistant', '', 'provided-id');

      expect(message).toEqual({
        id: 'provided-id',
        conversationId: 'guest',
        role: 'assistant',
        content: '',
        createdAt: '2024-01-15T10:00:00.000Z',
      });
    });

    it('generates ID when not provided', () => {
      const message1 = createGuestMessage('user', 'Test');
      const message2 = createGuestMessage('user', 'Test');

      expect(message1.id).not.toBe(message2.id);
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
