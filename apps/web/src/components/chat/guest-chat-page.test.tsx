import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GuestChatPage } from './guest-chat-page';
import { GuestRateLimitError } from '@/hooks/use-chat-stream';
import type { GuestMessage } from '@/stores/guest-chat';

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
    rateLimitMessage,
  }: {
    messages: GuestMessage[];
    onSubmit: () => void;
    inputValue: string;
    onInputChange: (v: string) => void;
    inputDisabled: boolean;
    isProcessing: boolean;
    historyCharacters: number;
    rateLimitMessage?: boolean;
  }) => (
    <div data-testid="chat-layout">
      <div data-testid="message-count">{messages.length}</div>
      <div data-testid="history-characters">{historyCharacters}</div>
      <div data-testid="input-disabled">{String(inputDisabled)}</div>
      <div data-testid="is-processing">{String(isProcessing)}</div>
      <div data-testid="rate-limit-message">{String(rateLimitMessage)}</div>
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
  documentsByMessage: Record<string, unknown>;
  handleDocumentsExtracted: ReturnType<typeof vi.fn>;
  allDocuments: unknown[];
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

const mockGuestChatStore = {
  messages: [] as GuestMessage[],
  pendingMessage: null as string | null,
  isRateLimited: false,
  addMessage: vi.fn(),
  updateMessageContent: vi.fn(),
  appendToMessage: vi.fn(),
  clearPendingMessage: vi.fn(),
  setRateLimited: vi.fn(),
};

interface GuestChatStoreMock {
  messages: GuestMessage[];
  pendingMessage: string | null;
  isRateLimited: boolean;
  addMessage: ReturnType<typeof vi.fn>;
  updateMessageContent: ReturnType<typeof vi.fn>;
  appendToMessage: ReturnType<typeof vi.fn>;
  clearPendingMessage: ReturnType<typeof vi.fn>;
  setRateLimited: ReturnType<typeof vi.fn>;
}

const mockUseGuestChatStore = vi.fn<() => GuestChatStoreMock>();
vi.mock('@/stores/guest-chat', () => ({
  useGuestChatStore: (): GuestChatStoreMock => mockUseGuestChatStore(),
}));

const mockOpenSignupModal = vi.fn();
vi.mock('@/stores/ui-modals', () => ({
  useUIModalsStore: {
    getState: () => ({
      openSignupModal: mockOpenSignupModal,
    }),
  },
}));

function getSessionData(user: { id: string } | null): { user: { id: string } } | null {
  return user === null ? null : { user };
}

interface StreamOptions {
  onToken?: (token: string) => void;
  onStart?: (data: { assistantMessageId: string }) => void;
}

describe('GuestChatPage', () => {
  const mockStartStream = vi.fn();
  const mockStartStreaming = vi.fn();
  const mockStopStreaming = vi.fn();
  const mockSetInputValue = vi.fn();
  const mockClearInput = vi.fn();
  const mockHandleDocumentsExtracted = vi.fn();
  const streamingMessageIdRef = { current: null as string | null };

  interface MockOverrides {
    isPending?: boolean;
    user?: { id: string } | null;
    pendingMessage?: string | null;
    messages?: GuestMessage[];
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

    mockUseGuestChatStore.mockReturnValue({
      messages: config.messages,
      pendingMessage: config.pendingMessage,
      isRateLimited: config.isRateLimited,
      addMessage: mockGuestChatStore.addMessage,
      updateMessageContent: mockGuestChatStore.updateMessageContent,
      appendToMessage: mockGuestChatStore.appendToMessage,
      clearPendingMessage: mockGuestChatStore.clearPendingMessage,
      setRateLimited: mockGuestChatStore.setRateLimited,
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
      documentsByMessage: {},
      handleDocumentsExtracted: mockHandleDocumentsExtracted,
      allDocuments: [],
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    streamingMessageIdRef.current = null;
    setupMocks();
  });

  describe('authentication redirect', () => {
    it('redirects authenticated users to chat route', () => {
      setupMocks({ user: { id: 'user-1' } });

      render(<GuestChatPage />);

      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/chat');
    });

    it('does not redirect while session is pending', () => {
      setupMocks({
        isPending: true,
        user: { id: 'user-1' },
        pendingMessage: 'Hello',
      });

      render(<GuestChatPage />);

      expect(screen.getByTestId('chat-layout')).toBeInTheDocument();
    });
  });

  describe('empty state redirect', () => {
    it('redirects when no pending message and no messages', () => {
      setupMocks({
        pendingMessage: null,
        messages: [],
      });

      render(<GuestChatPage />);

      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/chat');
    });

    it('does not redirect when pending message exists', () => {
      setupMocks({ pendingMessage: 'Hello' });

      render(<GuestChatPage />);

      expect(screen.getByTestId('chat-layout')).toBeInTheDocument();
    });

    it('does not redirect when messages exist', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<GuestChatPage />);

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

    render(<GuestChatPage />);

    await waitFor(() => {
      expect(mockGuestChatStore.clearPendingMessage).toHaveBeenCalled();
    });

    expect(mockGuestChatStore.addMessage).toHaveBeenCalledWith(
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

    render(<GuestChatPage />);

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

      render(<GuestChatPage />);

      await waitFor(() => {
        expect(capturedOnStart).toBeDefined();
      });

      act(() => {
        capturedOnStart?.({ assistantMessageId: 'assistant-1' });
      });

      expect(mockGuestChatStore.addMessage).toHaveBeenCalledWith(
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

      render(<GuestChatPage />);

      await waitFor(() => {
        expect(capturedOnToken).toBeDefined();
      });

      act(() => {
        capturedOnToken?.('Hello');
      });

      expect(mockGuestChatStore.appendToMessage).toHaveBeenCalledWith('assistant-1', 'Hello');
    });

    it('does not append token if no streaming message id', async () => {
      let capturedOnToken: ((token: string) => void) | undefined;
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        capturedOnToken = options?.onToken;
        return Promise.resolve({ assistantMessageId: 'assistant-1', content: 'Response' });
      });

      setupMocks({ pendingMessage: 'Hello' });
      streamingMessageIdRef.current = null;

      render(<GuestChatPage />);

      await waitFor(() => {
        expect(capturedOnToken).toBeDefined();
      });

      act(() => {
        capturedOnToken?.('Hello');
      });

      expect(mockGuestChatStore.appendToMessage).not.toHaveBeenCalled();
    });

    it('updates message content on stream complete', async () => {
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-1',
        content: 'Final response',
      });

      setupMocks({ pendingMessage: 'Hello' });

      render(<GuestChatPage />);

      await waitFor(() => {
        expect(mockGuestChatStore.updateMessageContent).toHaveBeenCalledWith(
          'assistant-1',
          'Final response'
        );
      });

      expect(mockStopStreaming).toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('handles GuestRateLimitError', async () => {
      const rateLimitError = new GuestRateLimitError('Rate limited', 5, 0);
      mockStartStream.mockRejectedValue(rateLimitError);

      setupMocks({ pendingMessage: 'Hello' });

      render(<GuestChatPage />);

      await waitFor(() => {
        expect(mockGuestChatStore.setRateLimited).toHaveBeenCalledWith(true);
      });

      expect(mockOpenSignupModal).toHaveBeenCalledWith(undefined, 'rate-limit');
      expect(mockStopStreaming).toHaveBeenCalled();
    });

    it('logs non-rate-limit errors to console', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      const genericError = new Error('Network error');
      mockStartStream.mockRejectedValue(genericError);

      setupMocks({ pendingMessage: 'Hello' });

      render(<GuestChatPage />);

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('Guest chat error:', genericError);
      });

      expect(mockStopStreaming).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  describe('guest submit', () => {
    it('submits message with full history', async () => {
      const user = userEvent.setup();
      const existingMessages: GuestMessage[] = [
        { id: '1', conversationId: 'guest', role: 'user', content: 'First', createdAt: '' },
        { id: '2', conversationId: 'guest', role: 'assistant', content: 'Response', createdAt: '' },
      ];

      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-2',
        content: 'New response',
      });

      setupMocks({
        messages: existingMessages,
        inputValue: 'New message',
      });

      render(<GuestChatPage />);

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
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: '   ',
      });

      render(<GuestChatPage />);

      await user.click(screen.getByTestId('submit'));

      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('does not submit when streaming', async () => {
      const user = userEvent.setup();
      setupMocks({
        messages: [
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'Hello',
        isStreaming: true,
      });

      render(<GuestChatPage />);

      await user.click(screen.getByTestId('submit'));

      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('does not submit when rate limited', async () => {
      const user = userEvent.setup();
      setupMocks({
        messages: [
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'Hello',
        isRateLimited: true,
      });

      render(<GuestChatPage />);

      await user.click(screen.getByTestId('submit'));

      expect(mockStartStream).not.toHaveBeenCalled();
    });
  });

  describe('UI state', () => {
    it('calculates history characters from messages', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hello', createdAt: '' },
          {
            id: '2',
            conversationId: 'guest',
            role: 'assistant',
            content: 'Hi there',
            createdAt: '',
          },
        ],
      });

      render(<GuestChatPage />);

      expect(screen.getByTestId('history-characters')).toHaveTextContent('13');
    });

    it('passes rate limited state to layout', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        isRateLimited: true,
      });

      render(<GuestChatPage />);

      expect(screen.getByTestId('input-disabled')).toHaveTextContent('true');
      expect(screen.getByTestId('rate-limit-message')).toHaveTextContent('true');
    });

    it('passes streaming state to layout', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        isStreaming: true,
      });

      render(<GuestChatPage />);

      expect(screen.getByTestId('is-processing')).toHaveTextContent('true');
    });

    it('passes message count to layout', () => {
      setupMocks({
        messages: [
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
          { id: '2', conversationId: 'guest', role: 'assistant', content: 'Hello', createdAt: '' },
        ],
      });

      render(<GuestChatPage />);

      expect(screen.getByTestId('message-count')).toHaveTextContent('2');
    });
  });

  describe('input handling', () => {
    it('updates input value through layout', async () => {
      const user = userEvent.setup();
      setupMocks({
        messages: [
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<GuestChatPage />);

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
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
        isMobile: false,
      });

      render(<GuestChatPage />);

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
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
        isMobile: true,
      });

      render(<GuestChatPage />);

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
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });

      render(<GuestChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(capturedOnStart).toBeDefined();
      });

      act(() => {
        capturedOnStart?.({ assistantMessageId: 'assistant-submit' });
      });

      expect(mockGuestChatStore.addMessage).toHaveBeenCalledWith(
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
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });
      streamingMessageIdRef.current = 'assistant-submit';

      render(<GuestChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(capturedOnToken).toBeDefined();
      });

      expect(mockGuestChatStore.appendToMessage).toHaveBeenCalledWith(
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
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });
      streamingMessageIdRef.current = null;

      render(<GuestChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockGuestChatStore.updateMessageContent).toHaveBeenCalled();
      });

      // appendToMessage should not have been called because streamingMessageIdRef was null
      expect(mockGuestChatStore.appendToMessage).not.toHaveBeenCalled();
    });

    it('handles submit error', async () => {
      const user = userEvent.setup();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      const submitError = new Error('Submit failed');
      mockStartStream.mockRejectedValue(submitError);

      setupMocks({
        messages: [
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });

      render(<GuestChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(consoleErrorSpy).toHaveBeenCalledWith('Guest chat error:', submitError);
      });

      expect(mockStopStreaming).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });

    it('handles rate limit error on submit', async () => {
      const user = userEvent.setup();
      const rateLimitError = new GuestRateLimitError('Rate limited', 5, 0);
      mockStartStream.mockRejectedValue(rateLimitError);

      setupMocks({
        messages: [
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });

      render(<GuestChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockGuestChatStore.setRateLimited).toHaveBeenCalledWith(true);
      });

      expect(mockOpenSignupModal).toHaveBeenCalledWith(undefined, 'rate-limit');
    });

    it('does not update message if no assistantMessageId on submit', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        assistantMessageId: '',
        content: 'Response',
      });

      setupMocks({
        messages: [
          { id: '1', conversationId: 'guest', role: 'user', content: 'Hi', createdAt: '' },
        ],
        inputValue: 'New message',
      });

      render(<GuestChatPage />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalled();
      });

      expect(mockGuestChatStore.updateMessageContent).not.toHaveBeenCalled();
    });
  });

  describe('message result handling', () => {
    it('does not update if no assistantMessageId returned', async () => {
      mockStartStream.mockResolvedValue({
        assistantMessageId: '',
        content: 'Response',
      });

      setupMocks({ pendingMessage: 'Hello' });

      render(<GuestChatPage />);

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalled();
      });

      expect(mockGuestChatStore.updateMessageContent).not.toHaveBeenCalled();
    });
  });
});
