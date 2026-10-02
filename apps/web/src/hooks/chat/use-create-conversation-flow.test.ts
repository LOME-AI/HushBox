import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { generateKeyPair } from '@hushbox/crypto';
import { isoAt, TEST_DAY_START } from '@hushbox/shared/test-time';
import { useModelStore } from '@/stores/model';
import { useChatErrorStore, MAIN_FORK_KEY } from '@/stores/chat/error';
import { ChatRunFailedError } from '@/hooks/chat/use-chat-stream';
import { useTurnStreamCallbacks } from '@/hooks/chat/use-turn-stream-callbacks';
import { useCreateConversationFlow } from '@/hooks/chat/use-create-conversation-flow';
import type { Dispatch, SetStateAction } from 'react';
import type { useNavigate } from '@tanstack/react-router';
import type { useChatPageState } from '@/hooks/chat/use-chat-page';
import type { useChatStream } from '@/hooks/chat/use-chat-stream';
import type { useCreateConversation } from '@/hooks/chat/chat';
import type { useOptimisticMessages } from '@/hooks/chat/use-optimistic-messages';
import type { Message } from '@/lib/api/api';

type StartStream = ReturnType<typeof useChatStream>['startStream'];
type CreateConversation = ReturnType<typeof useCreateConversation>['mutateAsync'];

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

/** Records every value passed through `setLocalMessages`, applying updaters in order. */
function createLocalMessagesRecorder(): {
  setLocalMessages: Dispatch<SetStateAction<Message[]>>;
  lastState: () => Message[];
} {
  let current: Message[] = [];
  return {
    setLocalMessages: (action) => {
      current = typeof action === 'function' ? action(current) : action;
    },
    lastState: () => current,
  };
}

const createConversation = vi.fn<CreateConversation>((request) =>
  Promise.resolve({
    conversation: {
      id: request.id,
      title: request.title ?? '',
      currentEpoch: 1,
      titleEpochNumber: 1,
      nextSequence: 0,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
    },
    created: true,
  })
);

/** Streams one model's `start`, then fails the run as the server's failure frame would. */
const startStreamThatFailsAfterStart = vi.fn<StartStream>((_request, options) => {
  options?.onStart?.({
    userMessageId: null,
    models: [{ modelId: 'openai/gpt-4o', assistantMessageId: 'a1' }],
  });
  return Promise.reject(new ChatRunFailedError('UNAVAILABLE'));
});

function renderCreateFlow(setLocalMessages: Dispatch<SetStateAction<Message[]>>): void {
  const store = useModelStore.getState();
  const state = createPageState();
  const conversationIdRef = { current: '' };
  const navigate: ReturnType<typeof useNavigate> = vi.fn();
  const queryClient = new QueryClient();
  const accountPrivateKey = generateKeyPair().privateKey;
  const clearPendingMessage = vi.fn();
  renderHook(() => {
    const { localMessageHandlers, recordSmartTiles } = useTurnStreamCallbacks({
      state,
      conversationIdRef,
      setLocalMessages,
      activeModality: 'text',
      imageConfig: store.imageConfig,
      videoConfig: store.videoConfig,
      optimistic: createOptimistic(),
    });
    useCreateConversationFlow({
      isCreateMode: true,
      pendingMessage: 'Hello',
      pendingFundingSource: null,
      accountPrivateKey,
      clearPendingMessage,
      callerId: 'user-1',
      activeRef: { current: true },
      conversationIdRef,
      createConversationRef: { current: createConversation },
      setLocalMessages,
      setLocalTitle: vi.fn(),
      setRealConversationId: vi.fn(),
      navigate,
      queryClient,
      state,
      startStream: startStreamThatFailsAfterStart,
      selectedModels: [{ id: 'openai/gpt-4o', name: 'GPT-4o' }],
      webSearchEnabled: false,
      reasoningEffort: undefined,
      customInstructions: null,
      isInstructionsReadUnresolved: false,
      activeModality: 'text',
      imageConfig: store.imageConfig,
      videoConfig: store.videoConfig,
      audioConfig: store.audioConfig,
      localMessageHandlers,
      recordSmartTiles,
      addOptimisticMessage: vi.fn(),
    });
  });
}

describe('useCreateConversationFlow first-turn failure', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    useChatErrorStore.setState({ errorsByFork: {} });
    consoleError = vi.spyOn(console, 'error').mockImplementation(vi.fn());
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('removes the assistant placeholder the failed run created', async () => {
    const recorder = createLocalMessagesRecorder();

    renderCreateFlow(recorder.setLocalMessages);

    await waitFor(() => {
      expect(useChatErrorStore.getState().getError(MAIN_FORK_KEY)).not.toBeNull();
    });
    expect(startStreamThatFailsAfterStart).toHaveBeenCalled();
    expect(recorder.lastState().map((m) => m.id)).not.toContain('a1');
  });

  it('keeps the user message above the failure', async () => {
    const recorder = createLocalMessagesRecorder();

    renderCreateFlow(recorder.setLocalMessages);

    await waitFor(() => {
      expect(useChatErrorStore.getState().getError(MAIN_FORK_KEY)).not.toBeNull();
    });
    expect(recorder.lastState().map((m) => ({ role: m.role, content: m.content }))).toEqual([
      { role: 'user', content: 'Hello' },
    ]);
  });
});
