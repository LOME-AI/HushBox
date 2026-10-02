import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { useModelStore } from '@/stores/model';
import { useTurnStreamCallbacks } from '@/hooks/chat/use-turn-stream-callbacks';
import type { useChatPageState } from '@/hooks/chat/use-chat-page';
import type { useOptimisticMessages } from '@/hooks/chat/use-optimistic-messages';
import type { Message } from '@/lib/api/api';
import type { Dispatch, SetStateAction } from 'react';

function createPageState(): ReturnType<typeof useChatPageState> {
  return {
    inputValue: '',
    setInputValue: vi.fn(),
    clearInput: vi.fn(),
    streamingMessageIds: new Set<string>(),
    streamingMessageIdsRef: { current: new Set<string>() },
    startStreaming: vi.fn(),
    stopStreaming: vi.fn(),
    persistingMessageIds: new Set<string>(),
    persistingMessageIdsRef: { current: new Set<string>() },
    stopPersisting: vi.fn(),
  };
}

function createOptimistic(): ReturnType<typeof useOptimisticMessages> {
  return {
    optimisticMessages: [],
    addOptimisticMessage: vi.fn(),
    removeOptimisticMessage: vi.fn(),
    setOptimisticMessageContent: vi.fn(),
    setOptimisticMessageError: vi.fn(),
    setOptimisticMessageReasoningTokens: vi.fn(),
    setOptimisticMessageReasoningEffort: vi.fn(),
    setOptimisticMessageSmartModelResolved: vi.fn(),
    setOptimisticMessageMediaStart: vi.fn(),
    setOptimisticMessageMediaProgress: vi.fn(),
    resetOptimisticMessageContent: vi.fn(),
    resetOptimisticMessages: vi.fn(),
  };
}

function createMessage(id: string): Message {
  return {
    id,
    conversationId: 'conv-1',
    role: 'assistant',
    content: '',
    createdAt: isoAt(TEST_DAY_START),
  };
}

function renderCallbacks(
  setLocalMessages: Dispatch<SetStateAction<Message[]>>,
  optimistic: ReturnType<typeof useOptimisticMessages> = createOptimistic()
): ReturnType<typeof useTurnStreamCallbacks> {
  const store = useModelStore.getState();
  const { result } = renderHook(() =>
    useTurnStreamCallbacks({
      state: createPageState(),
      conversationIdRef: { current: 'conv-1' },
      setLocalMessages,
      activeModality: 'text',
      imageConfig: store.imageConfig,
      videoConfig: store.videoConfig,
      optimistic,
    })
  );
  return result.current;
}

describe('useTurnStreamCallbacks optimistic callbacks', () => {
  it('writes a tile its streamed content through the optimistic store', () => {
    const optimistic = createOptimistic();
    const callbacks = renderCallbacks(vi.fn(), optimistic).createOptimisticStreamCallbacks(
      'conv-1'
    );

    act(() => {
      callbacks.onContent?.('built content', 'tile-a');
    });

    expect(optimistic.setOptimisticMessageContent).toHaveBeenCalledWith('tile-a', 'built content');
  });
});

describe('useTurnStreamCallbacks local-message handlers', () => {
  it('sets the streamed content on the tile it names and leaves the others untouched', () => {
    const setLocalMessages = vi.fn<Dispatch<SetStateAction<Message[]>>>();
    const handlers = renderCallbacks(setLocalMessages).localMessageHandlers;

    act(() => {
      handlers.onContent('built content', 'tile-a');
    });

    const updater = setLocalMessages.mock.calls[0]?.[0];
    if (typeof updater !== 'function') throw new Error('expected a functional state update');
    const untouched = createMessage('tile-b');
    const next = updater([createMessage('tile-a'), untouched]);
    expect(next).toEqual([{ ...createMessage('tile-a'), content: 'built content' }, untouched]);
    expect(next[1]).toBe(untouched);
  });

  it('stamps the reasoning token count on the tile it names and leaves the others untouched', () => {
    const setLocalMessages = vi.fn();
    const store = useModelStore.getState();
    const { result } = renderHook(() =>
      useTurnStreamCallbacks({
        state: createPageState(),
        conversationIdRef: { current: 'conv-1' },
        setLocalMessages,
        activeModality: 'text',
        imageConfig: store.imageConfig,
        videoConfig: store.videoConfig,
        optimistic: createOptimistic(),
      })
    );

    act(() => {
      result.current.localMessageHandlers.onReasoningTokens(42, 'tile-a');
    });

    expect(setLocalMessages).toHaveBeenCalledTimes(1);
    const updater = setLocalMessages.mock.calls[0]?.[0];
    if (typeof updater !== 'function') throw new Error('expected a functional state update');
    expect(updater([createMessage('tile-a'), createMessage('tile-b')])).toEqual([
      { ...createMessage('tile-a'), reasoningTokens: 42 },
      createMessage('tile-b'),
    ]);
  });
});
