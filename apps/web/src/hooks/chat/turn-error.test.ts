import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { ChatRequestError, ChatRunFailedError } from '@/hooks/chat/use-chat-stream';
import { handleTurnError, turnErrorContent, turnNoticeOf } from '@/hooks/chat/turn-error';
import { turnNoticeForCode, turnNoticeText } from '@/lib/chat/turn-notice';
import { useChatErrorStore, type FailedTurn } from '@/stores/chat/error';
import type * as React from 'react';
import type { Message } from '@/lib/api/api';
import type { PromptInputRef } from '@/components/chat/message/types';

function inputRef(focus: () => void = vi.fn()): React.RefObject<PromptInputRef | null> {
  const input: PromptInputRef = { focus };
  return { current: input };
}

const TEST_INSTANT = isoAt(TEST_DAY_START);

function failedSend(content: string): FailedTurn {
  const question: Message = {
    id: 'q1',
    conversationId: 'conv-1',
    role: 'user',
    content,
    createdAt: TEST_INSTANT,
  };
  return {
    retry: {
      kind: 'send',
      request: {
        conversationId: 'conv-1',
        models: ['model-a'],
        userMessage: { content },
        messagesForInference: [{ role: 'user', content }],
        fundingSource: 'personal_balance',
      },
      turn: {},
      question,
    },
    storedIds: ['q1'],
  };
}

describe('handleTurnError', () => {
  beforeEach(() => {
    useChatErrorStore.setState({ errorsByFork: {} });
  });

  it('stores a rate-limit refusal as a notice worded with its wait', () => {
    handleTurnError(
      new ChatRequestError('RATE_LIMITED', { retryAfterSeconds: 3 }),
      failedSend('Hello'),
      'fork-1',
      inputRef()
    );

    const stored = useChatErrorStore.getState().getError('fork-1');
    if (stored === null) throw new Error('no chat error was stored');
    expect(turnNoticeText(stored.notice)).toBe('Too many attempts. Try again in 3 seconds.');
  });

  it('stores the failed content beside the notice', () => {
    handleTurnError(
      new ChatRunFailedError('UNAVAILABLE'),
      failedSend('My message'),
      'main',
      inputRef()
    );

    expect(useChatErrorStore.getState().getError('main')?.failedUserMessage.content).toBe(
      'My message'
    );
  });

  it('stores the failed turn beside the notice', () => {
    const failedTurn = failedSend('My message');

    handleTurnError(new ChatRunFailedError('UNAVAILABLE'), failedTurn, 'main', inputRef());

    expect(useChatErrorStore.getState().getError('main')?.failedTurn).toBe(failedTurn);
  });

  it('reports an unexpected failure and refocuses the composer', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(vi.fn());
    const focus = vi.fn();
    const failure = new Error('boom');

    handleTurnError(failure, failedSend('Hello'), 'main', inputRef(focus));

    expect(consoleError).toHaveBeenCalledWith('Turn failed:', failure);
    expect(focus).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('leaves the composer focus alone for a wire refusal', () => {
    const focus = vi.fn();

    handleTurnError(
      new ChatRequestError('CONCURRENT_RUN'),
      failedSend('Hello'),
      'main',
      inputRef(focus)
    );

    expect(focus).not.toHaveBeenCalled();
  });
});

describe('turnNoticeOf', () => {
  it('reads a refusal from its wire code and details', () => {
    const notice = turnNoticeOf(new ChatRequestError('RATE_LIMITED', { retryAfterSeconds: 3 }));

    expect(turnNoticeText(notice)).toBe('Too many attempts. Try again in 3 seconds.');
  });

  it('reads a run failure from its wire code', () => {
    expect(turnNoticeOf(new ChatRunFailedError('MODEL_OUTPUT_INVALID'))).toEqual(
      turnNoticeForCode('MODEL_OUTPUT_INVALID')
    );
  });

  it('reads anything else as an internal failure', () => {
    expect(turnNoticeOf(new Error('boom'))).toEqual(turnNoticeForCode('INTERNAL'));
  });
});

describe('turnErrorContent', () => {
  it.each([
    new ChatRequestError('RATE_LIMITED', { retryAfterSeconds: 3 }),
    new ChatRunFailedError('CHAT_STREAM_FAILED'),
    new Error('boom'),
  ])('reads as the plain sentence of the notice the error becomes (%s)', (error) => {
    expect(turnErrorContent(error).content).toBe(turnNoticeText(turnNoticeOf(error)));
  });
});
