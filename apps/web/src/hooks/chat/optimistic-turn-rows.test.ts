import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { chatKeys } from '@/hooks/chat/chat';
import {
  addEditedUserOptimistic,
  adoptOptimisticUserRow,
  applyPrune,
} from '@/hooks/chat/optimistic-turn-rows';
import type * as React from 'react';
import type { Message, MessageResponse } from '@/lib/api/api';

function message(id: string, role: Message['role'] = 'user'): Message {
  return {
    id,
    conversationId: 'conv-1',
    role,
    content: `${id} text`,
    createdAt: isoAt(TEST_DAY_START),
  };
}

const THREAD: Message[] = [
  message('u1'),
  message('a1', 'assistant'),
  message('u2'),
  message('a2', 'assistant'),
];

describe('addEditedUserOptimistic', () => {
  it('parents the replacement to the message before the edited one', () => {
    const add = vi.fn<(m: Message) => void>();
    const row = addEditedUserOptimistic({
      allMsgs: THREAD,
      targetMessageId: 'u2',
      userContent: 'Edited',
      conversationId: 'conv-1',
      callerId: 'user-1',
      addOptimisticMessage: add,
    });
    expect(row.parentMessageId).toBe('a1');
  });

  it('gives the first message no parent', () => {
    const row = addEditedUserOptimistic({
      allMsgs: THREAD,
      targetMessageId: 'u1',
      userContent: 'Edited',
      conversationId: 'conv-1',
      callerId: undefined,
      addOptimisticMessage: vi.fn<(m: Message) => void>(),
    });
    expect(row.parentMessageId).toBeNull();
  });

  it('gives no parent when the edited message is not in the list', () => {
    const row = addEditedUserOptimistic({
      allMsgs: THREAD,
      targetMessageId: 'missing',
      userContent: 'Edited',
      conversationId: 'conv-1',
      callerId: undefined,
      addOptimisticMessage: vi.fn<(m: Message) => void>(),
    });
    expect(row.parentMessageId).toBeNull();
  });

  it('adds the replacement row it returns', () => {
    const add = vi.fn<(m: Message) => void>();
    const row = addEditedUserOptimistic({
      allMsgs: THREAD,
      targetMessageId: 'u2',
      userContent: 'Edited',
      conversationId: 'conv-1',
      callerId: 'user-1',
      addOptimisticMessage: add,
    });
    expect(add).toHaveBeenCalledWith(row);
    expect(row).toMatchObject({ role: 'user', content: 'Edited', senderId: 'user-1' });
  });
});

describe('adoptOptimisticUserRow', () => {
  it('leaves the row where it is when the run start names no id', () => {
    const ops = {
      addOptimisticMessage: vi.fn<(m: Message) => void>(),
      removeOptimisticMessage: vi.fn<(id: string) => void>(),
    };
    const row = message('local-1');
    expect(adoptOptimisticUserRow(row, null, ops)).toBe(row);
    expect(ops.removeOptimisticMessage).not.toHaveBeenCalled();
    expect(ops.addOptimisticMessage).not.toHaveBeenCalled();
  });

  it('moves the row onto the id the run start names', () => {
    const ops = {
      addOptimisticMessage: vi.fn<(m: Message) => void>(),
      removeOptimisticMessage: vi.fn<(id: string) => void>(),
    };
    const adopted = adoptOptimisticUserRow(message('local-1'), 'server-1', ops);
    expect(adopted.id).toBe('server-1');
    expect(ops.removeOptimisticMessage).toHaveBeenCalledWith('local-1');
    expect(ops.addOptimisticMessage).toHaveBeenCalledWith(adopted);
  });
});

describe('applyPrune', () => {
  function setup(): {
    queryClient: QueryClient;
    setRetryPrunedIds: ReturnType<
      typeof vi.fn<(value: React.SetStateAction<ReadonlySet<string>>) => void>
    >;
    local: { current: Message[] };
    setLocalMessages: (value: React.SetStateAction<Message[]>) => void;
  } {
    const queryClient = new QueryClient();
    const cached: MessageResponse[] = THREAD.map(
      (m): MessageResponse => ({ id: m.id }) as unknown as MessageResponse // the prune reads only ids
    );
    queryClient.setQueryData(chatKeys.messages('conv-1'), cached);
    const local = { current: [...THREAD] };
    return {
      queryClient,
      setRetryPrunedIds: vi.fn<(value: React.SetStateAction<ReadonlySet<string>>) => void>(),
      local,
      setLocalMessages: (value) => {
        local.current = typeof value === 'function' ? value(local.current) : value;
      },
    };
  }

  it('drops the rows after a retried message from the render layer, the cache and the local rows', () => {
    const { queryClient, setRetryPrunedIds, local, setLocalMessages } = setup();
    applyPrune({
      allMsgs: THREAD,
      targetMessageId: 'u2',
      action: 'retry',
      replaceAssistantId: undefined,
      conversationId: 'conv-1',
      setRetryPrunedIds,
      setLocalMessages,
      queryClient,
    });
    expect(setRetryPrunedIds).toHaveBeenCalledWith(new Set(['a2']));
    expect(
      queryClient.getQueryData<MessageResponse[]>(chatKeys.messages('conv-1'))?.map((m) => m.id)
    ).toEqual(['u1', 'a1', 'u2']);
    expect(local.current.map((m) => m.id)).toEqual(['u1', 'a1', 'u2']);
  });

  it('leaves an empty cache empty', () => {
    const { setRetryPrunedIds, setLocalMessages } = setup();
    const empty = new QueryClient();
    applyPrune({
      allMsgs: THREAD,
      targetMessageId: 'u2',
      action: 'edit',
      replaceAssistantId: undefined,
      conversationId: 'conv-1',
      setRetryPrunedIds,
      setLocalMessages,
      queryClient: empty,
    });
    expect(empty.getQueryData(chatKeys.messages('conv-1'))).toBeUndefined();
  });

  it('does nothing when nothing follows the target', () => {
    const { queryClient, setRetryPrunedIds, local, setLocalMessages } = setup();
    applyPrune({
      allMsgs: THREAD,
      targetMessageId: 'missing',
      action: 'retry',
      replaceAssistantId: undefined,
      conversationId: 'conv-1',
      setRetryPrunedIds,
      setLocalMessages,
      queryClient,
    });
    expect(setRetryPrunedIds).not.toHaveBeenCalled();
    expect(local.current).toHaveLength(4);
  });
});
