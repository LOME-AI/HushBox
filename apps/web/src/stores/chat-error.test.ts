import { describe, it, expect, beforeEach, vi } from 'vitest';
import { friendlyErrorMessage, customUserMessage } from '@hushbox/shared';
import { useChatErrorStore, createChatError } from './chat-error';

describe('useChatErrorStore', () => {
  beforeEach(() => {
    useChatErrorStore.setState({ error: null });
  });

  it('starts with no error', () => {
    expect(useChatErrorStore.getState().error).toBeNull();
  });

  it('sets an error', () => {
    const error = createChatError({
      content: friendlyErrorMessage('INTERNAL'),
      retryable: true,
      failedContent: 'Hello world',
    });

    useChatErrorStore.getState().setError(error);

    expect(useChatErrorStore.getState().error).toBe(error);
  });

  it('clears the error', () => {
    const error = createChatError({
      content: friendlyErrorMessage('INTERNAL'),
      retryable: false,
      failedContent: 'test',
    });

    useChatErrorStore.getState().setError(error);
    useChatErrorStore.getState().clearError();

    expect(useChatErrorStore.getState().error).toBeNull();
  });

  it('replaces an existing error when setError is called again', () => {
    const error1 = createChatError({
      content: friendlyErrorMessage('INTERNAL'),
      retryable: true,
      failedContent: 'msg1',
    });
    const error2 = createChatError({
      content: friendlyErrorMessage('RATE_LIMITED'),
      retryable: false,
      failedContent: 'msg2',
    });

    useChatErrorStore.getState().setError(error1);
    useChatErrorStore.getState().setError(error2);

    expect(useChatErrorStore.getState().error).toBe(error2);
  });
});

describe('createChatError', () => {
  beforeEach(() => {
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn().mockReturnValue('mock-uuid-123'),
    });
  });

  it('creates an error with a unique id', () => {
    const error = createChatError({
      content: friendlyErrorMessage('INTERNAL'),
      retryable: true,
      failedContent: 'Hello',
    });

    expect(error.id).toBe('mock-uuid-123');
  });

  it('passes content through unchanged', () => {
    const message = friendlyErrorMessage('BALANCE_RESERVED');
    const error = createChatError({
      content: message,
      retryable: true,
      failedContent: 'Hello',
    });

    expect(error.content).toBe(
      'Please wait for your current messages to finish before starting more.'
    );
  });

  it('preserves custom user messages unchanged', () => {
    const error = createChatError({
      content: customUserMessage('Custom [link](/signup) message.'),
      retryable: false,
      failedContent: 'Hello',
    });

    expect(error.content).toBe('Custom [link](/signup) message.');
  });

  it('stores the retryable flag', () => {
    const retryable = createChatError({
      content: friendlyErrorMessage('INTERNAL'),
      retryable: true,
      failedContent: 'msg',
    });
    const notRetryable = createChatError({
      content: friendlyErrorMessage('INTERNAL'),
      retryable: false,
      failedContent: 'msg',
    });

    expect(retryable.retryable).toBe(true);
    expect(notRetryable.retryable).toBe(false);
  });

  it('embeds the failed user message with id and content', () => {
    const error = createChatError({
      content: friendlyErrorMessage('INTERNAL'),
      retryable: true,
      failedContent: 'My original message',
    });

    expect(error.failedUserMessage.id).toBe('mock-uuid-123');
    expect(error.failedUserMessage.content).toBe('My original message');
  });

  it('generates different IDs for each call', () => {
    let callCount = 0;
    vi.stubGlobal('crypto', {
      randomUUID: vi.fn().mockImplementation(() => `uuid-${String(++callCount)}`),
    });

    const error1 = createChatError({
      content: friendlyErrorMessage('INTERNAL'),
      retryable: true,
      failedContent: 'msg1',
    });
    const error2 = createChatError({
      content: friendlyErrorMessage('RATE_LIMITED'),
      retryable: true,
      failedContent: 'msg2',
    });

    expect(error1.id).not.toBe(error2.id);
  });
});
