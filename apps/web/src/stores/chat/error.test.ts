import { describe, it, expect, beforeEach, vi } from 'vitest';
import { turnNoticeForCode } from '@/lib/chat/turn-notice';
import { useChatErrorStore, createChatError, MAIN_FORK_KEY } from './error';

describe('useChatErrorStore', () => {
  beforeEach(() => {
    useChatErrorStore.setState({ errorsByFork: {} });
  });

  it('starts with no errors for any fork', () => {
    expect(useChatErrorStore.getState().getError(MAIN_FORK_KEY)).toBeNull();
    expect(useChatErrorStore.getState().getError('fork-1')).toBeNull();
  });

  it('sets an error scoped to a fork key', () => {
    const error = createChatError({
      notice: turnNoticeForCode('INTERNAL'),
      failedContent: 'Hello world',
    });

    useChatErrorStore.getState().setError('fork-1', error);

    expect(useChatErrorStore.getState().getError('fork-1')).toBe(error);
    expect(useChatErrorStore.getState().getError(MAIN_FORK_KEY)).toBeNull();
  });

  it('does not leak errors across fork keys', () => {
    const mainError = createChatError({
      notice: turnNoticeForCode('INTERNAL'),
      failedContent: 'Main message',
    });

    useChatErrorStore.getState().setError(MAIN_FORK_KEY, mainError);

    // Reading other forks must return null — the regression that motivated
    // this store is a Main-fork regenerate error showing up on Fork 1.
    expect(useChatErrorStore.getState().getError(MAIN_FORK_KEY)).toBe(mainError);
    expect(useChatErrorStore.getState().getError('fork-1')).toBeNull();
    expect(useChatErrorStore.getState().getError('fork-2')).toBeNull();
  });

  it('clears the error for a specific fork', () => {
    const error = createChatError({
      notice: turnNoticeForCode('INTERNAL'),
      failedContent: 'test',
    });

    useChatErrorStore.getState().setError('fork-1', error);
    useChatErrorStore.getState().clearError('fork-1');

    expect(useChatErrorStore.getState().getError('fork-1')).toBeNull();
  });

  it('clearError is a no-op (same state reference) for a fork with no error', () => {
    const before = useChatErrorStore.getState().errorsByFork;
    useChatErrorStore.getState().clearError('never-set');
    // The guard short-circuits and returns the existing state object unchanged.
    expect(useChatErrorStore.getState().errorsByFork).toBe(before);
  });

  it('clearError on one fork preserves errors on other forks', () => {
    const errA = createChatError({
      notice: turnNoticeForCode('INTERNAL'),
      failedContent: 'a',
    });
    const errB = createChatError({
      notice: turnNoticeForCode('RATE_LIMITED'),
      failedContent: 'b',
    });

    useChatErrorStore.getState().setError(MAIN_FORK_KEY, errA);
    useChatErrorStore.getState().setError('fork-1', errB);
    useChatErrorStore.getState().clearError(MAIN_FORK_KEY);

    expect(useChatErrorStore.getState().getError(MAIN_FORK_KEY)).toBeNull();
    expect(useChatErrorStore.getState().getError('fork-1')).toBe(errB);
  });

  it('clearAll removes errors for every fork', () => {
    const errA = createChatError({
      notice: turnNoticeForCode('INTERNAL'),
      failedContent: 'a',
    });
    const errB = createChatError({
      notice: turnNoticeForCode('RATE_LIMITED'),
      failedContent: 'b',
    });

    useChatErrorStore.getState().setError(MAIN_FORK_KEY, errA);
    useChatErrorStore.getState().setError('fork-1', errB);
    useChatErrorStore.getState().clearAll();

    expect(useChatErrorStore.getState().getError(MAIN_FORK_KEY)).toBeNull();
    expect(useChatErrorStore.getState().getError('fork-1')).toBeNull();
  });

  it('replaces an existing error for the same fork when setError is called again', () => {
    const error1 = createChatError({
      notice: turnNoticeForCode('INTERNAL'),
      failedContent: 'msg1',
    });
    const error2 = createChatError({
      notice: turnNoticeForCode('RATE_LIMITED'),
      failedContent: 'msg2',
    });

    useChatErrorStore.getState().setError('fork-1', error1);
    useChatErrorStore.getState().setError('fork-1', error2);

    expect(useChatErrorStore.getState().getError('fork-1')).toBe(error2);
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
      notice: turnNoticeForCode('INTERNAL'),
      failedContent: 'Hello',
    });

    expect(error.id).toBe('mock-uuid-123');
  });

  it('carries the notice it was given', () => {
    const notice = turnNoticeForCode('CONCURRENT_RUN');
    const error = createChatError({ notice, failedContent: 'Hello' });

    expect(error.notice).toBe(notice);
  });

  it('carries no retry flag', () => {
    const error = createChatError({ notice: turnNoticeForCode('INTERNAL'), failedContent: 'msg' });

    expect(error).not.toHaveProperty('retryable');
  });

  it('embeds the failed user message with id and content', () => {
    const error = createChatError({
      notice: turnNoticeForCode('INTERNAL'),
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
      notice: turnNoticeForCode('INTERNAL'),
      failedContent: 'msg1',
    });
    const error2 = createChatError({
      notice: turnNoticeForCode('RATE_LIMITED'),
      failedContent: 'msg2',
    });

    expect(error1.id).not.toBe(error2.id);
  });
});
