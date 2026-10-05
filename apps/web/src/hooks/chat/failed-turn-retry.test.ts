import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { turnNoticeForCode } from '@/lib/chat/turn-notice';
import {
  useChatErrorStore,
  createChatError,
  MAIN_FORK_KEY,
  type FailedTurn,
  type FailedTurnRetry,
} from '@/stores/chat/error';
import {
  dispatchFailedTurnRetry,
  mergeStoredIds,
  recordFailedTurn,
  useFailedTurnReconcile,
  type FailedTurnExecutors,
} from '@/hooks/chat/failed-turn-retry';
import { ChatRequestError, ChatRunFailedError } from '@/hooks/chat/use-chat-stream';
import { billingKeys } from '@/hooks/billing/billing';
import type * as React from 'react';
import type { Message } from '@/lib/api/api';
import type { PromptInputRef } from '@/components/chat/message/types';

// The handoff is a module-level listener registry the conversation page's
// maintenance hook subscribes to; spying on the entry point stands in for it.
const mockRequestEpochMaintenance = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/crypto/use-epoch-maintenance', () => ({
  requestEpochMaintenanceOnRefusal: (conversationId: string, error: unknown): void => {
    mockRequestEpochMaintenance(conversationId, error);
  },
}));

function message(id: string, role: 'user' | 'assistant' = 'user'): Message {
  return {
    id,
    conversationId: 'conv-1',
    role,
    content: `c-${id}`,
    createdAt: isoAt(TEST_DAY_START),
  };
}

const SEND: FailedTurnRetry = {
  kind: 'send',
  request: {
    conversationId: 'conv-1',
    models: ['model-a'],
    userMessage: { content: 'c-q9' },
    messagesForInference: [{ role: 'user', content: 'c-q9' }],
    fundingSource: 'personal_balance',
  },
  turn: {},
  question: message('q9'),
};

const REGENERATE: FailedTurnRetry = {
  kind: 'regenerate',
  request: {
    conversationId: 'conv-1',
    targetMessageId: 'u1',
    action: 'retry',
    models: ['model-a'],
    userMessage: { content: 'c-u1' },
    messagesForInference: [{ role: 'user', content: 'c-u1' }],
    fundingSource: 'personal_balance',
  },
  turn: {},
  question: null,
};

function storeFailure(failedTurn?: FailedTurn): ReturnType<typeof createChatError> {
  const record = createChatError({
    notice: turnNoticeForCode('CHAT_STREAM_FAILED'),
    failedContent: 'c-q9',
    ...(failedTurn !== undefined && { failedTurn }),
  });
  useChatErrorStore.getState().setError(MAIN_FORK_KEY, record);
  return record;
}

function executors(): FailedTurnExecutors & {
  send: ReturnType<typeof vi.fn<FailedTurnExecutors['send']>>;
  regenerate: ReturnType<typeof vi.fn<FailedTurnExecutors['regenerate']>>;
} {
  return {
    send: vi.fn<FailedTurnExecutors['send']>(),
    regenerate: vi.fn<FailedTurnExecutors['regenerate']>(),
  };
}

describe('useFailedTurnReconcile', () => {
  beforeEach(() => {
    useChatErrorStore.setState({ errorsByFork: {} });
  });

  it('clears the notice once the stored history holds a row the failed turn would have stored', () => {
    const record = storeFailure({ retry: SEND, storedIds: ['q9', 'a9'] });

    renderHook(() => {
      useFailedTurnReconcile(record, MAIN_FORK_KEY, [message('u1'), message('a9', 'assistant')]);
    });

    expect(useChatErrorStore.getState().getError(MAIN_FORK_KEY)).toBeNull();
  });

  it('keeps the notice while the stored history holds none of those rows', () => {
    const record = storeFailure({ retry: SEND, storedIds: ['q9', 'a9'] });

    renderHook(() => {
      useFailedTurnReconcile(record, MAIN_FORK_KEY, [message('u1'), message('a1', 'assistant')]);
    });

    expect(useChatErrorStore.getState().getError(MAIN_FORK_KEY)).toBe(record);
  });

  it('keeps a notice that carries no failed turn', () => {
    const record = storeFailure();

    renderHook(() => {
      useFailedTurnReconcile(record, MAIN_FORK_KEY, [message('q9')]);
    });

    expect(useChatErrorStore.getState().getError(MAIN_FORK_KEY)).toBe(record);
  });

  it('clears the notice when a refetch brings the stored row in later', () => {
    const record = storeFailure({ retry: REGENERATE, storedIds: ['regen-9'] });
    const { rerender } = renderHook(
      ({ stored }: { stored: Message[] }) => {
        useFailedTurnReconcile(record, MAIN_FORK_KEY, stored);
      },
      { initialProps: { stored: [message('u1')] } }
    );

    rerender({ stored: [message('u1'), message('regen-9', 'assistant')] });

    expect(useChatErrorStore.getState().getError(MAIN_FORK_KEY)).toBeNull();
  });
});

describe('dispatchFailedTurnRetry', () => {
  it('re-posts a failed send through the send executor', () => {
    const run = executors();

    dispatchFailedTurnRetry({ retry: SEND, storedIds: [] }, run);

    expect(run.send).toHaveBeenCalledWith(SEND, []);
  });

  it('never re-posts a failed send as a regenerate', () => {
    const run = executors();

    dispatchFailedTurnRetry({ retry: SEND, storedIds: [] }, run);

    expect(run.regenerate).not.toHaveBeenCalled();
  });

  it('re-posts a failed regenerate through the regenerate executor', () => {
    const run = executors();

    dispatchFailedTurnRetry({ retry: REGENERATE, storedIds: [] }, run);

    expect(run.regenerate).toHaveBeenCalledWith(REGENERATE, []);
  });

  it('never re-posts a failed regenerate as a send', () => {
    const run = executors();

    dispatchFailedTurnRetry({ retry: REGENERATE, storedIds: [] }, run);

    expect(run.send).not.toHaveBeenCalled();
  });

  it("hands the executor the ids the earlier attempts' rows would carry", () => {
    const run = executors();

    dispatchFailedTurnRetry({ retry: REGENERATE, storedIds: ['a9'] }, run);

    expect(run.regenerate).toHaveBeenCalledWith(REGENERATE, ['a9']);
  });

  it('re-posts nothing for a notice that carries no failed turn', () => {
    const run = executors();

    dispatchFailedTurnRetry(undefined, run);

    expect([run.send.mock.calls, run.regenerate.mock.calls]).toEqual([[], []]);
  });
});

describe('recordFailedTurn', () => {
  const failedTurn: FailedTurn = { retry: SEND, storedIds: ['q9'] };
  const promptInputRef: React.RefObject<PromptInputRef | null> = { current: null };

  function context(): { queryClient: QueryClient; invalidated: unknown[] } {
    const queryClient = new QueryClient();
    const invalidated: unknown[] = [];
    vi.spyOn(queryClient, 'invalidateQueries').mockImplementation((filters) => {
      invalidated.push(filters?.queryKey);
      return Promise.resolve();
    });
    return { queryClient, invalidated };
  }

  beforeEach(() => {
    useChatErrorStore.setState({ errorsByFork: {} });
    mockRequestEpochMaintenance.mockClear();
  });

  it('records the failed turn beside its notice on its fork', async () => {
    const { queryClient } = context();

    await recordFailedTurn(new ChatRunFailedError('CHAT_STREAM_FAILED'), failedTurn, {
      forkKey: 'fork-1',
      queryClient,
      promptInputRef,
    });

    expect(useChatErrorStore.getState().getError('fork-1')).toMatchObject({
      notice: turnNoticeForCode('CHAT_STREAM_FAILED'),
      failedTurn,
    });
  });

  it('refreshes the balance on a refusal over money the client saw stale', async () => {
    const { queryClient, invalidated } = context();

    await recordFailedTurn(new ChatRequestError('INSUFFICIENT_ADMISSION'), failedTurn, {
      forkKey: MAIN_FORK_KEY,
      queryClient,
      promptInputRef,
    });

    expect(invalidated).toEqual([billingKeys.balance()]);
  });

  it('leaves the balance alone for a failure that says nothing about money', async () => {
    const { queryClient, invalidated } = context();

    await recordFailedTurn(new ChatRunFailedError('CHAT_STREAM_FAILED'), failedTurn, {
      forkKey: MAIN_FORK_KEY,
      queryClient,
      promptInputRef,
    });

    expect(invalidated).toEqual([]);
  });

  it("hands the refusal to its conversation's epoch maintenance", async () => {
    const { queryClient } = context();
    const refusal = new ChatRequestError('ROTATION_PENDING');

    await recordFailedTurn(refusal, failedTurn, {
      forkKey: MAIN_FORK_KEY,
      queryClient,
      promptInputRef,
    });

    expect(mockRequestEpochMaintenance).toHaveBeenCalledWith('conv-1', refusal);
  });
});

describe('mergeStoredIds', () => {
  it("keeps an earlier attempt's ids beside the latest attempt's", () => {
    expect(mergeStoredIds(['a9'], ['a10'])).toEqual(['a9', 'a10']);
  });

  it('names an id both attempts carry once', () => {
    expect(mergeStoredIds(['u9', 'a9'], ['u9', 'a10'])).toEqual(['u9', 'a9', 'a10']);
  });
});
