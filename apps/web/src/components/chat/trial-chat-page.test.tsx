import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TrialChatPage } from './trial-chat-page';
import { TrialRateLimitError } from '@/hooks/use-chat-stream';
import type { TrialMessage } from '@/stores/trial-chat';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  Navigate: ({ to }: { to: string }) => {
    mockNavigate(to);
    return <div data-testid="navigate" data-to={to} />;
  },
}));

vi.mock('@/components/chat/chat-layout', () => ({
  ChatLayout: ({
    messages,
    onSubmit,
    inputValue,
    onInputChange,
    inputDisabled,
    isProcessing,
    historyCharacters,
  }: {
    messages: TrialMessage[];
    onSubmit: () => void;
    inputValue: string;
    onInputChange: (v: string) => void;
    inputDisabled: boolean;
    isProcessing: boolean;
    historyCharacters: number;
  }) => (
    <div data-testid="chat-layout">
      <div data-testid="message-count">{messages.length}</div>
      <div data-testid="history-characters">{historyCharacters}</div>
      <div data-testid="input-disabled">{String(inputDisabled)}</div>
      <div data-testid="is-processing">{String(isProcessing)}</div>
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
  ),
}));

interface ChatPageStateMock {
  inputValue: string;
  setInputValue: ReturnType<typeof vi.fn>;
  clearInput: ReturnType<typeof vi.fn>;
  streamingMessageId: string | null;
  streamingMessageIdRef: { current: string | null };
  startStreaming: ReturnType<typeof vi.fn>;
  stopStreaming: ReturnType<typeof vi.fn>;
}

const mockUseChatPageState = vi.fn<() => ChatPageStateMock>();
vi.mock('@/hooks/use-chat-page', () => ({
  useChatPageState: (): ChatPageStateMock => mockUseChatPageState(),
}));

const mockUseIsMobile = vi.fn<() => boolean>();
vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: (): boolean => mockUseIsMobile(),
}));

interface SessionMock {
  data: { user: { id: string } } | null;
  isPending: boolean;
}

const mockUseSession = vi.fn<() => SessionMock>();
vi.mock('@/lib/auth', () => ({
  useSession: (): SessionMock => mockUseSession(),
}));

interface ModelStoreMock {
  selectedModelId: string;
}

const mockUseModelStore = vi.fn<() => ModelStoreMock>();
vi.mock('@/stores/model', () => ({
  useModelStore: (): ModelStoreMock => mockUseModelStore(),
}));

interface ChatStreamMock {
  isStreaming: boolean;
  startStream: ReturnType<typeof vi.fn>;
}

const mockUseChatStream = vi.fn<() => ChatStreamMock>();
vi.mock('@/hooks/use-chat-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/use-chat-stream')>();
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
  appendToMessage: vi.fn(),
  clearPendingMessage: vi.fn(),
  setRateLimited: vi.fn(),
};

interface TrialChatStoreMock {
  messages: TrialMessage[];
  pendingMessage: string | null;
  isRateLimited: boolean;
  addMessage: ReturnType<typeof vi.fn>;
  updateMessageContent: ReturnType<typeof vi.fn>;
  appendToMessage: ReturnType<typeof vi.fn>;
  clearPendingMessage: ReturnType<typeof vi.fn>;
  setRateLimited: ReturnType<typeof vi.fn>;
}

const mockUseTrialChatStore = vi.fn<() => TrialChatStoreMock>();
vi.mock('@/stores/trial-chat', () => ({
  useTrialChatStore: (): TrialChatStoreMock => mockUseTrialChatStore(),
}));

const mockOpenSignupModal = vi.fn();
vi.mock('@/stores/ui-modals', () => ({
  useUIModalsStore: {
    getState: () => ({
      openSignupModal: mockOpenSignupModal,
    }),
  },
}));

const mockSetError = vi.fn();
const mockClearError = vi.fn();
const mockChatErrorState = {
  error: null as null | {
    id: string;
    content: string;
    retryable: boolean;
    failedUserMessage: { id: string; content: string };
  },
};
vi.mock('@/stores/chat-error', () => ({
  useChatErrorStore: Object.assign(
    (selector?: (state: typeof mockChatErrorState) => unknown) =>
      selector ? selector(mockChatErrorState) : mockChatErrorState,
    {
      getState: () => ({
        ...mockChatErrorState,
        setError: mockSetError,
        clearError: mockClearError,
      }),
    }
  ),
  createChatError: vi.fn(
    (params: { content: string; retryable: boolean; failedContent: string }) => ({
      id: 'error-id',
      content: params.content,
      retryable: params.retryable,
      failedUserMessage: { id: 'failed-msg-id', content: params.failedContent },
    })
  ),
}));

function getSessionData(user: { id: string } | null): { user: { id: string } } | null {
  return user === null ? null : { user };
}

interface StreamOptions {
  onToken?: (token: string) => void;
  onStart?: (data: { assistantMessageId: string }) => void;
}

describe('TrialChatPage', () => {
  const mockStartStream = vi.fn();
  const mockStartStreaming = vi.fn();
  const mockStopStreaming = vi.fn();
  const mockSetInputValue = vi.fn();
  const mockClearInput = vi.fn();

  const streamingMessageIdRef = { current: null as string | null };

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

    mockUseModelStore.mockReturnValue({ selectedModelId: 'test-model' });

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
      appendToMessage: mockTrialChatStore.appendToMessage,
      clearPendingMessage: mockTrialChatStore.clearPendingMessage,
      setRateLimited: mockTrialChatStore.setRateLimited,
    });

    mockUseIsMobile.mockReturnValue(config.isMobile);

    mockUseChatPageState.mockReturnValue({
      inputValue: config.inputValue,
      setInputValue: mockSetInputValue,
      clearInput: mockClearInput,
      streamingMessageId: null,
      streamingMessageIdRef,
      startStreaming: mockStartStreaming,
      stopStreaming: mockStopStreaming,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    streamingMessageIdRef.current = null;
    mockChatErrorState.error = null;
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
    mockStartStream.mockResolvedValue({
      userMessageId: 'user-1',
      assistantMessageId: 'assistant-1',
      content: 'Response content',
    });

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

  it('does not trigger stream if already streaming', async () => {
    setupMocks({ pendingMessage: 'Hello', isStreaming: true });

    render(<TrialChatPage />);

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mockStartStream).not.toHaveBeenCalled();
  });

  describe('stream callbacks', () => {
    it('handles onStart callback', async () => {
      let capturedOnStart: ((data: { assistantMessageId: string }) => void) | undefined;
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnStart = options?.onStart;
        return Promise.resolve({
          assistantMessageId: 'assistant-1',
          content: 'Response',
        });
      });

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(capturedOnStart).toBeDefined();
      });

      act(() => {
        capturedOnStart?.({ assistantMessageId: 'assistant-1' });
      });

      expect(mockTrialChatStore.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'assistant-1',
          role: 'assistant',
          content: '',
        })
      );
      expect(mockStartStreaming).toHaveBeenCalledWith('assistant-1');
    });

    it('handles onToken callback', async () => {
      let capturedOnToken: ((token: string) => void) | undefined;
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnToken = options?.onToken;
        return Promise.resolve({ assistantMessageId: 'assistant-1', content: 'Response' });
      });

      setupMocks({ pendingMessage: 'Hello' });
      streamingMessageIdRef.current = 'assistant-1';

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(capturedOnToken).toBeDefined();
      });

      act(() => {
        capturedOnToken?.('Hello');
      });

      expect(mockTrialChatStore.appendToMessage).toHaveBeenCalledWith('assistant-1', 'Hello');
    });

    it('does not append token if no streaming message id', async () => {
      let capturedOnToken: ((token: string) => void) | undefined;
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnToken = options?.onToken;
        return Promise.resolve({ assistantMessageId: 'assistant-1', content: 'Response' });
      });

      setupMocks({ pendingMessage: 'Hello' });
      streamingMessageIdRef.current = null;

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(capturedOnToken).toBeDefined();
      });

      act(() => {
        capturedOnToken?.('Hello');
      });

      expect(mockTrialChatStore.appendToMessage).not.toHaveBeenCalled();
    });

    it('updates message content on stream complete', async () => {
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-1',
        content: 'Final response',
      });

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockTrialChatStore.updateMessageContent).toHaveBeenCalledWith(
          'assistant-1',
          'Final response'
        );
      });

      expect(mockStopStreaming).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('handles TrialRateLimitError with in-chat error', async () => {
      const rateLimitError = new TrialRateLimitError('DAILY_LIMIT_EXCEEDED', 5, 0);
      mockStartStream.mockRejectedValue(rateLimitError);

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockTrialChatStore.setRateLimited).toHaveBeenCalledWith(true);
      });

      expect(mockSetError).toHaveBeenCalledWith(
        expect.objectContaining({
          retryable: false,
        })
      );
      expect(mockOpenSignupModal).not.toHaveBeenCalled();
      expect(mockStopStreaming).toHaveBeenCalled();
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
        expect.objectContaining({
          retryable: false,
        })
      );
      expect(mockStopStreaming).toHaveBeenCalled();
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

      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-2',
        content: 'New response',
      });

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
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-1',
        content: 'Response',
      });

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
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-1',
        content: 'Response',
      });

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
      let capturedOnStart: ((data: { assistantMessageId: string }) => void) | undefined;
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnStart = options?.onStart;
        return Promise.resolve({
          assistantMessageId: 'assistant-submit',
          content: 'Response',
        });
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
        capturedOnStart?.({ assistantMessageId: 'assistant-submit' });
      });

      expect(mockTrialChatStore.addMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'assistant-submit',
          role: 'assistant',
        })
      );
    });

    it('handles onToken callback during submit with active streaming', async () => {
      const user = userEvent.setup();
      let capturedOnToken: ((token: string) => void) | undefined;
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnToken = options?.onToken;
        // Simulate calling onToken during stream
        if (streamingMessageIdRef.current) {
          options?.onToken?.('test-token');
        }
        return Promise.resolve({
          assistantMessageId: 'assistant-submit',
          content: 'Response',
        });
      });

      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });
      streamingMessageIdRef.current = 'assistant-submit';

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(capturedOnToken).toBeDefined();
      });

      expect(mockTrialChatStore.appendToMessage).toHaveBeenCalledWith(
        'assistant-submit',
        'test-token'
      );
    });

    it('skips onToken callback during submit when no streaming id', async () => {
      const user = userEvent.setup();
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        // Call onToken but with no streaming id set
        options?.onToken?.('test-token');
        return Promise.resolve({
          assistantMessageId: 'assistant-submit',
          content: 'Response',
        });
      });

      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });
      streamingMessageIdRef.current = null;

      render(<TrialChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockTrialChatStore.updateMessageContent).toHaveBeenCalled();
      });

      // appendToMessage should not have been called because streamingMessageIdRef was null
      expect(mockTrialChatStore.appendToMessage).not.toHaveBeenCalled();
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
        expect.objectContaining({
          retryable: false,
        })
      );
      expect(mockStopStreaming).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('handles rate limit error on submit with in-chat error', async () => {
      const user = userEvent.setup();
      const rateLimitError = new TrialRateLimitError('DAILY_LIMIT_EXCEEDED', 5, 0);
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
        expect.objectContaining({
          retryable: false,
        })
      );
      expect(mockOpenSignupModal).not.toHaveBeenCalled();
    });

    it('does not update message if no assistantMessageId on submit', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        assistantMessageId: '',
        content: 'Response',
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
        expect(mockStopStreaming).toHaveBeenCalled();
      });

      expect(mockTrialChatStore.updateMessageContent).not.toHaveBeenCalled();
    });
  });

  describe('error message in messages list', () => {
    it('appends error message to messages when chat error exists', () => {
      mockChatErrorState.error = {
        id: 'error-id',
        content: 'You have used all 5 free messages today.',
        retryable: false,
        failedUserMessage: { id: 'failed-msg-id', content: 'Hello' },
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
    it('does not update if no assistantMessageId returned', async () => {
      mockStartStream.mockResolvedValue({
        assistantMessageId: '',
        content: 'Response',
      });

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalled();
      });

      expect(mockTrialChatStore.updateMessageContent).not.toHaveBeenCalled();
    });
  });

  describe('error cleanup', () => {
    it('clears chat error on mount', () => {
      setupMocks({
        pendingMessage: 'Hello',
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<TrialChatPage />);

      expect(mockClearError).toHaveBeenCalled();
    });

    it('clears chat error on unmount', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'trial', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      const { unmount } = render(<TrialChatPage />);

      mockClearError.mockClear();
      unmount();

      expect(mockClearError).toHaveBeenCalled();
    });

    it('clears chat error when submitting a message', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-1',
        content: 'Response',
      });

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
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-1',
        content: 'Response',
      });

      setupMocks({ pendingMessage: 'Hello' });

      render(<TrialChatPage />);

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalled();
      });

      expect(mockClearError).toHaveBeenCalled();
    });
  });
});
