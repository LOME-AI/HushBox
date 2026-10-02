import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { serializeSegments } from '@hushbox/shared';
import { ChatRequestError, ChatRunFailedError } from '@/hooks/chat/use-chat-stream';
import { trialRefusalFor } from '@/lib/chat/trial-refusals';
import { turnNoticeForCode, turnNoticeText, type TurnNotice } from '@/lib/chat/turn-notice';
import { useChatEditStore } from '@/stores/chat/edit';
import { createModelStoreStub } from '@/test-utils/model-store-mock';
import { TrialChatPage } from '@/components/chat/page/trial-chat-page';
import type { FormFactor } from '@hushbox/ui/platform';
import type { Message } from '@/lib/api/api';
import type { TrialMessage } from '@/stores/chat/trial-chat';

vi.mock('@/lib/api/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
}));

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  Navigate: ({ to }: { to: string }) => {
    mockNavigate(to);
    return <div data-testid="navigate" data-to={to} />;
  },
}));

let capturedMessages: Message[] = [];
let capturedOnRegenerate: ((messageId: string) => void) | undefined;
let capturedOnEdit: ((messageId: string, content: string) => void) | undefined;
let capturedOnCancelEdit: (() => void) | undefined;

vi.mock('@/components/chat/layout/chat-layout', () => ({
  ChatLayout: ({
    messages,
    onSubmit,
    inputValue,
    onInputChange,
    inputDisabled,
    isProcessing,
    historyCharacters,
    onRegenerate,
    onEdit,
    onCancelEdit,
    isEditing,
    isAuthenticated,
  }: {
    messages: Message[];
    onSubmit: () => void;
    inputValue: string;
    onInputChange: (v: string) => void;
    inputDisabled: boolean;
    isProcessing: boolean;
    historyCharacters: number;
    onRegenerate?: (messageId: string) => void;
    onEdit?: (messageId: string, content: string) => void;
    onCancelEdit?: () => void;
    isEditing?: boolean;
    isAuthenticated: boolean;
  }) => {
    capturedMessages = messages;
    capturedOnRegenerate = onRegenerate;
    capturedOnEdit = onEdit;
    capturedOnCancelEdit = onCancelEdit;
    return (
      <div data-testid="chat-layout">
        <div data-testid="message-count">{messages.length}</div>
        <div data-testid="history-characters">{historyCharacters}</div>
        <div data-testid="input-disabled">{String(inputDisabled)}</div>
        <div data-testid="is-processing">{String(isProcessing)}</div>
        <div data-testid="is-editing">{String(isEditing)}</div>
        <div data-testid="is-authenticated">{String(isAuthenticated)}</div>
        <div data-testid="has-on-regenerate">{String(onRegenerate !== undefined)}</div>
        <input
          data-testid="input"
          value={inputValue}
          onChange={(event) => {
            onInputChange(event.target.value);
          }}
        />
        <button data-testid="submit" onClick={onSubmit}>
          Submit
        </button>
      </div>
    );
  },
}));

interface ChatPageStateMock {
  inputValue: string;
  setInputValue: ReturnType<typeof vi.fn>;
  clearInput: ReturnType<typeof vi.fn>;
  streamingMessageIds: Set<string>;
  streamingMessageIdsRef: { current: Set<string> };
  startStreaming: ReturnType<typeof vi.fn>;
  stopStreaming: ReturnType<typeof vi.fn>;
  persistingMessageIds: Set<string>;
  persistingMessageIdsRef: { current: Set<string> };
  stopPersisting: ReturnType<typeof vi.fn>;
}

const mockUseChatPageState = vi.fn<() => ChatPageStateMock>();
vi.mock('@/hooks/chat/use-chat-page', () => ({
  useChatPageState: (): ChatPageStateMock => mockUseChatPageState(),
}));

const mockBand = vi.fn<() => FormFactor['band']>();
vi.mock('@hushbox/ui/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@hushbox/ui/platform')>()),
  useFormFactor: (): FormFactor => ({ band: mockBand(), pointer: 'fine' }),
}));

interface SessionMock {
  data: { user: { id: string } } | null;
  isPending: boolean;
}

const mockUseSession = vi.fn<() => SessionMock>();
vi.mock('@/lib/auth/auth', () => ({
  useSession: (): SessionMock => mockUseSession(),
}));

import type { ModelStoreStub } from '@/test-utils/model-store-mock';

const mockUseModelStore = vi.fn<() => ModelStoreStub>();
vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  return {
    ...actual,
    useModelStore: (selector?: (state: ModelStoreStub) => unknown) => {
      const state = mockUseModelStore();
      return selector ? selector(state) : state;
    },
  };
});

interface ChatStreamMock {
  isStreaming: boolean;
  startStream: ReturnType<typeof vi.fn>;
}

const mockUseChatStream = vi.fn<() => ChatStreamMock>();
vi.mock('@/hooks/chat/use-chat-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/chat/use-chat-stream')>();
  return {
    ...actual,
    useChatStream: (): ChatStreamMock => mockUseChatStream(),
  };
});

const mockTrialChatStore = {
  messages: [] as TrialMessage[],
  pendingMessage: null as string | null,
  isRateLimited: false,
  addMessage: vi.fn(),
  updateMessageContent: vi.fn(),
  clearPendingMessage: vi.fn(),
  setRateLimited: vi.fn(),
  removeMessagesAfter: vi.fn(),
  removeMessage: vi.fn(),
  setMessageSmartModelResolved: vi.fn(),
};

interface TrialChatStoreMock {
  messages: TrialMessage[];
  pendingMessage: string | null;
  isRateLimited: boolean;
  addMessage: ReturnType<typeof vi.fn>;
  updateMessageContent: ReturnType<typeof vi.fn>;
  clearPendingMessage: ReturnType<typeof vi.fn>;
  setRateLimited: ReturnType<typeof vi.fn>;
  removeMessagesAfter: ReturnType<typeof vi.fn>;
  removeMessage: ReturnType<typeof vi.fn>;
  setMessageSmartModelResolved: ReturnType<typeof vi.fn>;
}

const mockUseTrialChatStore = vi.fn<() => TrialChatStoreMock>();
let mockReasoningEffective: string | undefined;
vi.mock('@/hooks/chat/use-reasoning-effort', () => ({
  useReasoningEffort: () => ({ effective: mockReasoningEffective }),
}));

vi.mock('@/stores/chat/trial-chat', () => ({
  useTrialChatStore: (): TrialChatStoreMock => mockUseTrialChatStore(),
}));

const mockOpenSignupModal = vi.fn();
vi.mock('@/stores/ui/modals', () => ({
  useUIModalsStore: {
    getState: () => ({
      openSignupModal: mockOpenSignupModal,
    }),
  },
}));

const mockSetError = vi.fn();
const mockClearError = vi.fn();
const mockClearAll = vi.fn();
interface MockChatError {
  id: string;
  notice: TurnNotice;
  failedUserMessage: { id: string; content: string };
}
const mockChatErrorState: { errorsByFork: Record<string, MockChatError | null> } = {
  errorsByFork: {},
};
vi.mock('@/stores/chat/error', () => ({
  MAIN_FORK_KEY: 'main',
  useChatErrorStore: Object.assign(
    (selector?: (state: typeof mockChatErrorState) => unknown) =>
      selector ? selector(mockChatErrorState) : mockChatErrorState,
    {
      getState: () => ({
        ...mockChatErrorState,
        setError: mockSetError,
        clearError: mockClearError,
        clearAll: mockClearAll,
      }),
    }
  ),
  createChatError: vi.fn(
    (params: { notice: TurnNotice; failedContent: string }): MockChatError => ({
      id: 'error-id',
      notice: params.notice,
      failedUserMessage: { id: 'failed-msg-id', content: params.failedContent },
    })
  ),
}));

function getSessionData(user: { id: string } | null): { user: { id: string } } | null {
  return user === null ? null : { user };
}

interface StreamOptions {
  onContent?: (content: string, assistantMessageId: string) => void;
  onStart?: (data: { models: { modelId: string; assistantMessageId: string }[] }) => void;
  onModelResolved?: (assistantMessageId: string, modelId: string) => void;
  onAllStreamsSettled?: () => void;
}

describe('TrialChatPage', () => {
  const mockStartStream = vi.fn();
  const mockStartStreaming = vi.fn();
  const mockStopStreaming = vi.fn();
  const mockStopPersisting = vi.fn();
  const mockSetInputValue = vi.fn();
  const mockClearInput = vi.fn();

  const streamingMessageIdsRef = { current: new Set<string>() };
  const persistingMessageIdsRef = { current: new Set<string>() };

  interface MockOverrides {
    isPending?: boolean;
    user?: { id: string } | null;
    pendingMessage?: string | null;
    messages?: TrialMessage[];
    isRateLimited?: boolean;
    isStreaming?: boolean;
    isMobile?: boolean;
    inputValue?: string;
  }

  const defaultMockValues: Required<MockOverrides> = {
    isPending: false,
    user: null,
    pendingMessage: null,
    messages: [],
    isRateLimited: false,
    isStreaming: false,
    isMobile: false,
    inputValue: '',
  };

  function setupMocks(overrides: MockOverrides = {}): void {
    const config = { ...defaultMockValues, ...overrides };

    mockUseSession.mockReturnValue({
      data: getSessionData(config.user),
      isPending: config.isPending,
    });

    mockUseModelStore.mockReturnValue(createModelStoreStub());

    mockUseChatStream.mockReturnValue({
      isStreaming: config.isStreaming,
      startStream: mockStartStream,
    });

    mockUseTrialChatStore.mockReturnValue({
      messages: config.messages,
      pendingMessage: config.pendingMessage,
      isRateLimited: config.isRateLimited,
      addMessage: mockTrialChatStore.addMessage,
      updateMessageContent: mockTrialChatStore.updateMessageContent,
      clearPendingMessage: mockTrialChatStore.clearPendingMessage,
      setRateLimited: mockTrialChatStore.setRateLimited,
      removeMessagesAfter: mockTrialChatStore.removeMessagesAfter,
      removeMessage: mockTrialChatStore.removeMessage,
      setMessageSmartModelResolved: mockTrialChatStore.setMessageSmartModelResolved,
    });

    mockBand.mockReturnValue(config.isMobile ? 'phone' : 'desktop');

    mockUseChatPageState.mockReturnValue({
      inputValue: config.inputValue,
      setInputValue: mockSetInputValue,
      clearInput: mockClearInput,
      streamingMessageIds: new Set<string>(),
      streamingMessageIdsRef,
      startStreaming: mockStartStreaming,
      stopStreaming: mockStopStreaming,
      persistingMessageIds: new Set<string>(),
      persistingMessageIdsRef,
      stopPersisting: mockStopPersisting,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockReasoningEffective = undefined;
    streamingMessageIdsRef.current = new Set<string>();
    mockChatErrorState.errorsByFork = {};
    capturedMessages = [];
    capturedOnRegenerate = undefined;
    capturedOnEdit = undefined;
    capturedOnCancelEdit = undefined;
    useChatEditStore.getState().clearEditing();
    setupMocks();
  });

  describe('authentication redirect', () => {
    it('redirects authenticated users to chat route', () => {
      setupMocks({ user: { id: 'user-1' } });

      render(<TrialChatPage />);

      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/chat');
    });

    it('does not redirect while session is pending', () => {
      setupMocks({
        isPending: true,
        user: { id: 'user-1' },
        pendingMessage: 'Hello',
      });

      render(<TrialChatPage />);

      expect(screen.getByTestId('chat-layout')).toBeInTheDocument();
    });
  });

  // The composer's free-preview count keys off this: a layout composed
  // unauthenticated is what classes its composer as the free preview's.
  it('composes the chat layout as an unauthenticated one', () => {
    setupMocks({ pendingMessage: 'Hello' });

    render(<TrialChatPage />);

    expect(screen.getByTestId('is-authenticated')).toHaveTextContent('false');
  });

  describe('empty state redirect', () => {
    it('redirects when no pending message and no messages', () => {
      setupMocks({
        pendingMessage: null,
        messages: [],
      });

      render(<TrialChatPage />);

      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/chat');
    });

    it('does not redirect when pending message exists', () => {
      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      expect(screen.getByTestId('chat-layout')).toBeInTheDocument();
    });

    it('does not redirect when messages exist', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<TrialChatPage />);

      expect(screen.getByTestId('chat-layout')).toBeInTheDocument();
    });
  });

  it('triggers first message stream when pending message exists', async () => {
    mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

    setupMocks({ pendingMessage: 'Hello AI' });

    render(<TrialChatPage />);

    await waitFor(() => {
      expect(mockTrialChatStore.clearPendingMessage).toHaveBeenCalled();
    });

    expect(mockTrialChatStore.addMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'user',
        content: 'Hello AI',
      })
    );

    expect(mockStartStream).toHaveBeenCalledWith(
      { messages: [{ role: 'user', content: 'Hello AI' }], model: 'test-model' },
      expect.any(Object)
    );
  });

  it('sends the effective reasoningEffort on a trial stream when one is engaged', async () => {
    mockReasoningEffective = 'low';
    setupMocks({ pendingMessage: 'Hello AI' });

    render(<TrialChatPage />);

    await waitFor(() => {
      expect(mockStartStream).toHaveBeenCalled();
    });

    expect(mockStartStream).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'low' }),
      expect.any(Object)
    );
  });

  it('does not trigger stream if already streaming', async () => {
    setupMocks({ pendingMessage: 'Hello', isStreaming: true });

    render(<TrialChatPage />);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockStartStream).not.toHaveBeenCalled();
  });

  describe('stream callbacks', () => {
    it('handles onStart callback', async () => {
      let capturedOnStart:
        | ((data: { models: { modelId: string; assistantMessageId: string }[] }) => void)
        | undefined;
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnStart = options?.onStart;
        return Promise.resolve({ userMessageId: 'user-1', models: [] });
      });

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(capturedOnStart).toBeDefined();
      });

      act(() => {
        capturedOnStart?.({
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
        });
      });

      expect(mockTrialChatStore.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'assistant-1',
          role: 'assistant',
          content: '',
        })
      );
      expect(mockStartStreaming).toHaveBeenCalledWith(['assistant-1']);
    });

    it('records the resolved model when a Smart Model stream starts', async () => {
      let capturedOnModelResolved: StreamOptions['onModelResolved'];
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnModelResolved = options?.onModelResolved;
        return Promise.resolve({ userMessageId: 'user-1', models: [], outcome: 'succeeded' });
      });

      setupMocks({ pendingMessage: 'Hello' });
      mockUseModelStore.mockReturnValue(
        createModelStoreStub({
          selections: {
            text: [{ id: 'smart-model', name: 'Smart Model' }],
            image: [],
            audio: [],
            video: [],
          },
        })
      );

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(capturedOnModelResolved).toBeDefined();
      });

      act(() => {
        capturedOnModelResolved?.('assistant-1', 'openai/gpt-4o-mini');
      });

      expect(mockTrialChatStore.setMessageSmartModelResolved).toHaveBeenCalledWith('assistant-1', {
        resolvedModelId: 'openai/gpt-4o-mini',
        resolvedModelName: 'openai/gpt-4o-mini',
      });
    });

    it('writes streamed content onto the tile the transport routed it to', async () => {
      let capturedOnContent: ((content: string, assistantMessageId: string) => void) | undefined;
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnContent = options?.onContent;
        return Promise.resolve({ userMessageId: 'user-1', models: [], outcome: 'succeeded' });
      });

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(capturedOnContent).toBeDefined();
      });

      act(() => {
        capturedOnContent?.('Hello', 'assistant-1');
      });

      expect(mockTrialChatStore.updateMessageContent).toHaveBeenCalledWith('assistant-1', 'Hello');
    });

    it('stops streaming on stream complete', async () => {
      mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalled();
      });
    });

    it('stops persisting via onAllStreamsSettled callback', async () => {
      // The trial path wires stopPersisting to the wrapper's
      // onAllStreamsSettled callback (fires on SSE done OR in finally on
      // error). Verify the callback is wired and triggers stopPersisting
      // when invoked — the wrapper's own behavior is covered by
      // use-chat-stream tests.
      let capturedOnSettled: (() => void) | undefined;
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnSettled = options?.onAllStreamsSettled;
        return Promise.resolve({ userMessageId: 'user-1', models: [] });
      });

      setupMocks({ pendingMessage: 'Hello' });
      render(<TrialChatPage />);

      await waitFor(() => {
        expect(capturedOnSettled).toBeDefined();
      });

      act(() => {
        capturedOnSettled?.();
      });

      expect(mockStopPersisting).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('handles the personal daily-limit refusal with an in-chat error', async () => {
      const rateLimitError = new ChatRequestError('TRIAL_LIMIT_REACHED', undefined, 429);
      mockStartStream.mockRejectedValue(rateLimitError);

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockTrialChatStore.setRateLimited).toHaveBeenCalledWith(true);
      });

      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ notice: trialRefusalFor(rateLimitError)?.notice })
      );
      expect(mockOpenSignupModal).not.toHaveBeenCalled();
      expect(mockStopStreaming).toHaveBeenCalled();
    });

    it('disables the composer with the shared capacity message when the trial pool is full', async () => {
      const capacityError = new ChatRequestError('TRIAL_CAPACITY_REACHED', undefined, 429);
      mockStartStream.mockRejectedValue(capacityError);

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockTrialChatStore.setRateLimited).toHaveBeenCalledWith(true);
      });

      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ notice: trialRefusalFor(capacityError)?.notice })
      );
    });

    it('disables the composer and links into the app when an authenticated user is refused', async () => {
      const signedInError = new ChatRequestError('AUTHENTICATED_ON_TRIAL', undefined, 403);
      mockStartStream.mockRejectedValue(signedInError);

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockTrialChatStore.setRateLimited).toHaveBeenCalledWith(true);
      });

      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ notice: trialRefusalFor(signedInError)?.notice })
      );
      expect(mockOpenSignupModal).not.toHaveBeenCalled();
    });

    it.each([
      'TRIAL_MESSAGE_TOO_EXPENSIVE',
      'PREMIUM_REQUIRES_ACCOUNT',
      'MEDIA_TRIAL_BLOCKED',
      'FEATURE_REQUIRES_AUTH',
    ] as const)('keeps the composer enabled and shows the shared %s message', async (code) => {
      const refusal = new ChatRequestError(code);
      mockStartStream.mockRejectedValue(refusal);

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalledWith(
          'main',
          expect.objectContaining({ notice: trialRefusalFor(refusal)?.notice })
        );
      });

      expect(mockTrialChatStore.setRateLimited).not.toHaveBeenCalled();
    });

    it('shows the retry countdown for a burst rate limit without disabling the composer', async () => {
      mockStartStream.mockRejectedValue(
        new ChatRequestError('RATE_LIMITED', { retryAfterSeconds: 30 }, 429)
      );

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalledWith(
          'main',
          expect.objectContaining({
            notice: expect.objectContaining({
              cause: 'Too many attempts.',
              action: expect.arrayContaining([{ text: 'Try again in 30 seconds.' }]),
            }),
          })
        );
      });

      expect(mockTrialChatStore.setRateLimited).not.toHaveBeenCalled();
    });

    it('falls back to the generic message for an unmapped refusal code', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      mockStartStream.mockRejectedValue(new ChatRequestError('INTERNAL'));

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalledWith(
          'main',
          expect.objectContaining({ notice: turnNoticeForCode('INTERNAL') })
        );
      });

      expect(mockTrialChatStore.setRateLimited).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('shows generic error to user for non-rate-limit errors', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      const genericError = new Error('Network error');
      mockStartStream.mockRejectedValue(genericError);

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('Trial chat error:', genericError);
      });

      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ notice: turnNoticeForCode('INTERNAL') })
      );
      expect(mockStopStreaming).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('removes orphan assistant placeholder when stream throws after onStart', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());

      // onStart adds the empty assistant placeholder via addMessage, then the
      // stream rejects. Without cleanup the placeholder renders as an invisible
      // bubble whose action toolbar floats above the chat-error tile.
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        options?.onStart?.({
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-orphan' }],
        });
        return Promise.reject(new Error('Stream failed after start'));
      });

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalled();
      });

      expect(mockTrialChatStore.removeMessage).toHaveBeenCalledWith('assistant-orphan');
      consoleErrorSpy.mockRestore();
    });

    it('leaves no assistant row for a run that failed after it started', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      let storedMessages: TrialMessage[] = [];
      mockTrialChatStore.addMessage.mockImplementation((message: TrialMessage) => {
        storedMessages = [...storedMessages, message];
      });
      mockTrialChatStore.removeMessage.mockImplementation((messageId: string) => {
        storedMessages = storedMessages.filter((m) => m.id !== messageId);
      });
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        options?.onStart?.({
          models: [{ modelId: 'test-model', assistantMessageId: 'a1' }],
        });
        return Promise.reject(new ChatRunFailedError('UNAVAILABLE'));
      });

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalled();
      });

      expect(mockTrialChatStore.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a1', role: 'assistant' })
      );
      expect(storedMessages.map((m) => m.id)).not.toContain('a1');
      consoleErrorSpy.mockRestore();
    });
  });

  describe('trial submit', () => {
    it('submits message with full history', async () => {
      const user = userEvent.setup();
      const existingMessages: TrialMessage[] = [
        { id: '1', conversationId: 'trial', role: 'user', content: 'First', createdAt: '' },
        { id: '2', conversationId: 'trial', role: 'assistant', content: 'Response', createdAt: '' },
      ];

      mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

      setupMocks({
        messages: existingMessages,
        inputValue: 'New message',
      });

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });

      expect(mockStartStream).toHaveBeenCalledWith(
        {
          messages: [
            { role: 'user', content: 'First' },
            { role: 'assistant', content: 'Response' },
            { role: 'user', content: 'New message' },
          ],
          model: 'test-model',
        },
        expect.any(Object)
      );
    });

    it('does not submit empty message', async () => {
      const user = userEvent.setup();
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: '   ',
      });

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('does not submit when streaming', async () => {
      const user = userEvent.setup();
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'Hello',
        isStreaming: true,
      });

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('does not submit when rate limited', async () => {
      const user = userEvent.setup();
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'Hello',
        isRateLimited: true,
      });

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      expect(mockStartStream).not.toHaveBeenCalled();
    });
  });

  describe('UI state', () => {
    it('calculates history characters from messages', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hello', createdAt: '' },
          {
            id: '2',
            conversationId: 'trial',
            role: 'assistant',
            content: 'Hi there',
            createdAt: '',
          },
        ],
      });

      render(<TrialChatPage />);

      expect(screen.getByTestId('history-characters')).toHaveTextContent('13');
    });

    it('counts an assistant turn by its answer alone, never its embedded reasoning', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hello', createdAt: '' },
          {
            id: '2',
            conversationId: 'trial',
            role: 'assistant',
            content: serializeSegments([
              { kind: 'reasoning', children: [{ kind: 'text', text: 'chain of thought' }] },
              { kind: 'text', text: 'Hi there' },
            ]),
            createdAt: '',
          },
        ],
      });

      render(<TrialChatPage />);

      expect(screen.getByTestId('history-characters')).toHaveTextContent('13');
    });

    it('passes rate limited state to layout', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        isRateLimited: true,
      });

      render(<TrialChatPage />);

      expect(screen.getByTestId('input-disabled')).toHaveTextContent('true');
    });

    it('passes streaming state to layout', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        isStreaming: true,
      });

      render(<TrialChatPage />);

      expect(screen.getByTestId('is-processing')).toHaveTextContent('true');
    });

    it('passes message count to layout', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
          { id: '2', conversationId: 'trial', role: 'assistant', content: 'Hello', createdAt: '' },
        ],
      });

      render(<TrialChatPage />);

      expect(screen.getByTestId('message-count')).toHaveTextContent('2');
    });
  });

  describe('input handling', () => {
    it('updates input value through layout', async () => {
      const user = userEvent.setup();
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<TrialChatPage />);

      await user.type(screen.getByTestId('input'), 'Test');

      expect(mockSetInputValue).toHaveBeenCalled();
    });

    it('clears input and focuses on desktop after submit', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
        isMobile: false,
      });

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });
    });

    it('clears input without focus on mobile after submit', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
        isMobile: true,
      });

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });
    });
  });

  describe('submit stream callbacks', () => {
    it('handles onStart callback during submit', async () => {
      const user = userEvent.setup();
      let capturedOnStart:
        | ((data: { models: { modelId: string; assistantMessageId: string }[] }) => void)
        | undefined;
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnStart = options?.onStart;
        return Promise.resolve({ userMessageId: 'user-1', models: [] });
      });

      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(capturedOnStart).toBeDefined();
      });

      act(() => {
        capturedOnStart?.({
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-submit' }],
        });
      });

      expect(mockTrialChatStore.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'assistant-submit',
          role: 'assistant',
        })
      );
    });

    it('handles onContent callback during submit', async () => {
      const user = userEvent.setup();
      let capturedOnContent: ((content: string, assistantMessageId: string) => void) | undefined;
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnContent = options?.onContent;
        options?.onContent?.('built content', 'assistant-submit');
        return Promise.resolve({ userMessageId: 'user-1', models: [], outcome: 'succeeded' });
      });

      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(capturedOnContent).toBeDefined();
      });

      expect(mockTrialChatStore.updateMessageContent).toHaveBeenCalledWith(
        'assistant-submit',
        'built content'
      );
    });

    it('handles submit error with generic error display', async () => {
      const user = userEvent.setup();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      const submitError = new Error('Submit failed');
      mockStartStream.mockRejectedValue(submitError);

      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('Trial chat error:', submitError);
      });

      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ notice: turnNoticeForCode('INTERNAL') })
      );
      expect(mockStopStreaming).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('handles rate limit error on submit with in-chat error', async () => {
      const user = userEvent.setup();
      const rateLimitError = new ChatRequestError('TRIAL_LIMIT_REACHED', undefined, 429);
      mockStartStream.mockRejectedValue(rateLimitError);

      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockTrialChatStore.setRateLimited).toHaveBeenCalledWith(true);
      });

      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ notice: trialRefusalFor(rateLimitError)?.notice })
      );
      expect(mockOpenSignupModal).not.toHaveBeenCalled();
    });

    it('stops streaming after submit completes', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalled();
      });
    });
  });

  describe('error message in messages list', () => {
    it('appends error message to messages when chat error exists', () => {
      mockChatErrorState.errorsByFork = {
        main: {
          id: 'error-id',
          notice: turnNoticeForCode('INTERNAL'),
          failedUserMessage: { id: 'failed-msg-id', content: 'Hello' },
        },
      };

      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
          { id: '2', conversationId: 'trial', role: 'assistant', content: 'Hello', createdAt: '' },
        ],
      });

      render(<TrialChatPage />);

      // 2 real messages + 1 error message = 3
      expect(screen.getByTestId('message-count')).toHaveTextContent('3');
    });

    it('gives the error row its notice, worded as the notice reads', () => {
      const notice = turnNoticeForCode('RATE_LIMITED', { retryAfterSeconds: 30 });
      mockChatErrorState.errorsByFork = {
        main: {
          id: 'error-id',
          notice,
          failedUserMessage: { id: 'failed-msg-id', content: 'Hello' },
        },
      };
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<TrialChatPage />);

      const errorRow = capturedMessages.at(-1);
      expect(errorRow?.turnNotice).toBe(notice);
      expect(errorRow?.content).toBe(turnNoticeText(notice));
    });

    it('does not append error message when no error exists', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<TrialChatPage />);

      expect(screen.getByTestId('message-count')).toHaveTextContent('1');
    });
  });

  describe('message result handling', () => {
    it('stops streaming after first message completes', async () => {
      mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalled();
      });
    });
  });

  describe('error cleanup', () => {
    it('clears all fork errors on mount', () => {
      setupMocks({
        pendingMessage: 'Hello',
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<TrialChatPage />);

      expect(mockClearAll).toHaveBeenCalled();
    });

    it('clears all fork errors on unmount', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      const { unmount } = render(<TrialChatPage />);

      mockClearAll.mockClear();
      unmount();

      expect(mockClearAll).toHaveBeenCalled();
    });

    it('lifts a trial refusal when the page unmounts', () => {
      setupMocks({
        isRateLimited: true,
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      const { unmount } = render(<TrialChatPage />);

      expect(mockTrialChatStore.setRateLimited).not.toHaveBeenCalledWith(false);
      unmount();

      expect(mockTrialChatStore.setRateLimited).toHaveBeenLastCalledWith(false);
    });

    it('clears chat error when submitting a message', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });

      render(<TrialChatPage />);

      mockClearError.mockClear();

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearError).toHaveBeenCalled();
      });
    });

    it('clears chat error when first message streams', async () => {
      mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalled();
      });

      expect(mockClearError).toHaveBeenCalled();
    });
  });

  describe('retry and regenerate', () => {
    it('passes onRegenerate callback to ChatLayout', () => {
      setupMocks({
        messages: [
          { id: 'm1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
          { id: 'm2', conversationId: 'trial', role: 'assistant', content: 'Hello', createdAt: '' },
        ],
      });

      render(<TrialChatPage />);

      expect(screen.getByTestId('has-on-regenerate')).toHaveTextContent('true');
    });

    it('retries a user message by truncating history and re-streaming', async () => {
      const existingMessages: TrialMessage[] = [
        { id: 'm1', conversationId: 'trial', role: 'user', content: 'Hello', createdAt: '' },
        {
          id: 'm2',
          conversationId: 'trial',
          role: 'assistant',
          content: 'Hi there',
          createdAt: '',
        },
        { id: 'm3', conversationId: 'trial', role: 'user', content: 'Follow up', createdAt: '' },
        {
          id: 'm4',
          conversationId: 'trial',
          role: 'assistant',
          content: 'Response',
          createdAt: '',
        },
      ];

      mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

      setupMocks({ messages: existingMessages });

      render(<TrialChatPage />);

      act(() => {
        capturedOnRegenerate?.('m3');
      });

      await waitFor(() => {
        expect(mockTrialChatStore.removeMessagesAfter).toHaveBeenCalledWith('m3');
      });

      expect(mockStartStream).toHaveBeenCalledWith(
        {
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi there' },
            { role: 'user', content: 'Follow up' },
          ],
          model: 'test-model',
        },
        expect.any(Object)
      );
    });

    it('regenerates an AI message by truncating and re-streaming', async () => {
      const existingMessages: TrialMessage[] = [
        { id: 'm1', conversationId: 'trial', role: 'user', content: 'Hello', createdAt: '' },
        {
          id: 'm2',
          conversationId: 'trial',
          role: 'assistant',
          content: 'Hi there',
          createdAt: '',
        },
      ];

      mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

      setupMocks({ messages: existingMessages });

      render(<TrialChatPage />);

      act(() => {
        capturedOnRegenerate?.('m2');
      });

      await waitFor(() => {
        expect(mockTrialChatStore.removeMessagesAfter).toHaveBeenCalledWith('m1');
      });

      expect(mockStartStream).toHaveBeenCalledWith(
        {
          messages: [{ role: 'user', content: 'Hello' }],
          model: 'test-model',
        },
        expect.any(Object)
      );
    });

    it('does not retry when streaming', () => {
      setupMocks({
        messages: [
          { id: 'm1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
          { id: 'm2', conversationId: 'trial', role: 'assistant', content: 'Hello', createdAt: '' },
        ],
        isStreaming: true,
      });

      render(<TrialChatPage />);

      act(() => {
        capturedOnRegenerate?.('m1');
      });

      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('does not retry when rate limited', () => {
      setupMocks({
        messages: [
          { id: 'm1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
          { id: 'm2', conversationId: 'trial', role: 'assistant', content: 'Hello', createdAt: '' },
        ],
        isRateLimited: true,
      });

      render(<TrialChatPage />);

      act(() => {
        capturedOnRegenerate?.('m1');
      });

      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('handles rate limit error on retry', async () => {
      const existingMessages: TrialMessage[] = [
        { id: 'm1', conversationId: 'trial', role: 'user', content: 'Hello', createdAt: '' },
        { id: 'm2', conversationId: 'trial', role: 'assistant', content: 'Hi', createdAt: '' },
      ];

      const rateLimitError = new ChatRequestError('TRIAL_LIMIT_REACHED', undefined, 429);
      mockStartStream.mockRejectedValue(rateLimitError);

      setupMocks({ messages: existingMessages });

      render(<TrialChatPage />);

      act(() => {
        capturedOnRegenerate?.('m1');
      });

      await waitFor(() => {
        expect(mockTrialChatStore.setRateLimited).toHaveBeenCalledWith(true);
      });

      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ notice: trialRefusalFor(rateLimitError)?.notice })
      );
      expect(mockStopStreaming).toHaveBeenCalled();
    });

    it('handles rate limit error on regenerate', async () => {
      const existingMessages: TrialMessage[] = [
        { id: 'm1', conversationId: 'trial', role: 'user', content: 'Hello', createdAt: '' },
        { id: 'm2', conversationId: 'trial', role: 'assistant', content: 'Hi', createdAt: '' },
      ];

      const rateLimitError = new ChatRequestError('TRIAL_LIMIT_REACHED', undefined, 429);
      mockStartStream.mockRejectedValue(rateLimitError);

      setupMocks({ messages: existingMessages });

      render(<TrialChatPage />);

      act(() => {
        capturedOnRegenerate?.('m2');
      });

      await waitFor(() => {
        expect(mockTrialChatStore.setRateLimited).toHaveBeenCalledWith(true);
      });

      expect(mockSetError).toHaveBeenCalledWith(
        'main',
        expect.objectContaining({ notice: trialRefusalFor(rateLimitError)?.notice })
      );
      expect(mockStopStreaming).toHaveBeenCalled();
    });

    it('does nothing when target message is not found', () => {
      setupMocks({
        messages: [
          { id: 'm1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<TrialChatPage />);

      act(() => {
        capturedOnRegenerate?.('nonexistent');
      });

      expect(mockStartStream).not.toHaveBeenCalled();
      expect(mockTrialChatStore.removeMessagesAfter).not.toHaveBeenCalled();
    });

    it('does not truncate when regenerating an assistant message with no preceding user message', async () => {
      const existingMessages: TrialMessage[] = [
        { id: 'm1', conversationId: 'trial', role: 'assistant', content: 'Hi', createdAt: '' },
      ];
      mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

      setupMocks({ messages: existingMessages });

      render(<TrialChatPage />);

      act(() => {
        capturedOnRegenerate?.('m1');
      });

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalled();
      });

      expect(mockTrialChatStore.removeMessagesAfter).not.toHaveBeenCalled();
    });
  });

  describe('edit flow', () => {
    const editMessages: TrialMessage[] = [
      { id: 'm1', conversationId: 'trial', role: 'user', content: 'Hello', createdAt: '' },
      { id: 'm2', conversationId: 'trial', role: 'assistant', content: 'Hi there', createdAt: '' },
    ];

    it('starts editing and fills the input when a message edit begins', () => {
      setupMocks({ messages: editMessages });

      render(<TrialChatPage />);

      act(() => {
        capturedOnEdit?.('m1', 'Hello');
      });

      expect(mockSetInputValue).toHaveBeenCalledWith('Hello');
      expect(screen.getByTestId('is-editing')).toHaveTextContent('true');
    });

    it('cancels editing and clears the input', () => {
      setupMocks({ messages: editMessages });

      render(<TrialChatPage />);

      act(() => {
        capturedOnEdit?.('m1', 'Hello');
      });
      act(() => {
        capturedOnCancelEdit?.();
      });

      expect(mockSetInputValue).toHaveBeenCalledWith('');
      expect(screen.getByTestId('is-editing')).toHaveTextContent('false');
    });

    it('submits an edited message through regenerate', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({ userMessageId: 'user-1', models: [] });

      setupMocks({ messages: editMessages, inputValue: 'Edited' });

      render(<TrialChatPage />);

      act(() => {
        capturedOnEdit?.('m1', 'Hello');
      });

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalledWith(
          {
            messages: [{ role: 'user', content: 'Edited' }],
            model: 'test-model',
          },
          expect.any(Object)
        );
      });

      expect(screen.getByTestId('is-editing')).toHaveTextContent('false');
    });
  });

  describe('stream start edge cases', () => {
    it('ignores an onStart event with no models', async () => {
      let capturedOnStart:
        | ((data: { models: { modelId: string; assistantMessageId: string }[] }) => void)
        | undefined;
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnStart = options?.onStart;
        return Promise.resolve({ userMessageId: 'user-1', models: [] });
      });

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(capturedOnStart).toBeDefined();
      });

      act(() => {
        capturedOnStart?.({ models: [] });
      });

      expect(mockStartStreaming).not.toHaveBeenCalled();
    });
  });
});
