import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AuthenticatedChatPage } from './authenticated-chat-page';
import { setEpochKey, clearEpochKeyCache } from '@/lib/epoch-key-cache';
import type { Message } from '@/lib/api';

const mockNavigate = vi.fn();

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  Navigate: ({ to }: { to: string }) => {
    mockNavigate(to);
    return <div data-testid="navigate" data-to={to} />;
  },
}));

const mockSetQueryData = vi.fn();
const mockInvalidateQueries = vi.fn().mockResolvedValue(null);

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({
    setQueryData: mockSetQueryData,
    invalidateQueries: mockInvalidateQueries,
  }),
}));

interface MockChatLayoutProps {
  messages: Message[];
  onSubmit: (fundingSource: string) => void;
  onSubmitUserOnly?: () => void;
  inputValue: string;
  onInputChange: (v: string) => void;
  inputDisabled: boolean;
  isProcessing: boolean;
  historyCharacters: number;
  isAuthenticated: boolean;
  isLinkGuest?: boolean;
  callerPrivilege?: string;
  title?: string;
  isDecrypting?: boolean;
  conversationId?: string;
  groupChat?: { conversationId: string };
  streamingMessageIds?: Set<string>;
  onRegenerate?: (messageId: string) => void;
  onEdit?: (messageId: string, content: string) => void;
  onFork?: (messageId: string) => void;
  onForkRename?: (forkId: string, currentName: string) => void;
  onForkDelete?: (forkId: string) => void;
}

function resolveConversationId(
  conversationId: string | undefined,
  groupChat: { conversationId: string } | undefined
): string {
  return conversationId ?? groupChat?.conversationId ?? '';
}

function resolveStreamingAttribute(
  streamingMessageIds: Set<string> | undefined
): Record<string, string> {
  if (!streamingMessageIds || streamingMessageIds.size === 0) return {};
  return { 'data-streaming-ids': [...streamingMessageIds].join(',') };
}

function boolAttribute(value: unknown): string {
  return value ? 'true' : 'false';
}

vi.mock('@/components/chat/chat-layout', () => ({
  ChatLayout: (props: MockChatLayoutProps) => (
    <div
      data-testid="chat-layout"
      data-decrypting={props.isDecrypting ? 'true' : undefined}
      data-conversation-id={resolveConversationId(props.conversationId, props.groupChat)}
      {...resolveStreamingAttribute(props.streamingMessageIds)}
      data-is-authenticated={boolAttribute(props.isAuthenticated)}
      data-is-link-guest={boolAttribute(props.isLinkGuest)}
      data-caller-privilege={props.callerPrivilege ?? 'none'}
      data-has-on-regenerate={boolAttribute(props.onRegenerate)}
      data-has-on-edit={boolAttribute(props.onEdit)}
      data-has-on-fork={boolAttribute(props.onFork)}
    >
      <div data-testid="message-count">{props.messages.length}</div>
      <div data-testid="history-characters">{props.historyCharacters}</div>
      <div data-testid="input-disabled">{String(props.inputDisabled)}</div>
      <div data-testid="is-processing">{String(props.isProcessing)}</div>
      <div data-testid="title">{props.title ?? ''}</div>
      <div data-testid="message-ids">{props.messages.map((m) => m.id).join(',')}</div>
      <input
        data-testid="input"
        value={props.inputValue}
        onChange={(event) => {
          props.onInputChange(event.target.value);
        }}
      />
      <button
        data-testid="submit"
        onClick={() => {
          props.onSubmit('personal_balance');
        }}
      >
        Submit
      </button>
      {props.onSubmitUserOnly && (
        <button data-testid="submit-user-only" onClick={props.onSubmitUserOnly}>
          Submit User Only
        </button>
      )}
      {props.onForkRename && (
        <button
          data-testid="trigger-fork-rename"
          onClick={() => {
            props.onForkRename?.('fork-1', 'Fork 1');
          }}
        >
          Trigger Fork Rename
        </button>
      )}
      {props.onForkDelete && (
        <button
          data-testid="trigger-fork-delete"
          onClick={() => {
            props.onForkDelete?.('fork-1');
          }}
        >
          Trigger Fork Delete
        </button>
      )}
    </div>
  ),
}));

interface ChatPageStateMock {
  inputValue: string;
  setInputValue: ReturnType<typeof vi.fn>;
  clearInput: ReturnType<typeof vi.fn>;
  streamingMessageIds: Set<string>;
  streamingMessageIdsRef: { current: Set<string> };
  startStreaming: ReturnType<typeof vi.fn>;
  stopStreaming: ReturnType<typeof vi.fn>;
}

const mockStartStreaming = vi.fn();
const mockStopStreaming = vi.fn();
const mockSetInputValue = vi.fn();
const mockClearInput = vi.fn();
const streamingMessageIdsRef = { current: new Set<string>() };

const mockUseChatPageState = vi.fn<() => ChatPageStateMock>();
vi.mock('@/hooks/use-chat-page', () => ({
  useChatPageState: (): ChatPageStateMock => mockUseChatPageState(),
}));

const mockUseIsMobile = vi.fn<() => boolean>();
vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: (): boolean => mockUseIsMobile(),
}));

interface ChatStreamMock {
  isStreaming: boolean;
  startStream: ReturnType<typeof vi.fn>;
}

const mockStartStream = vi.fn();
const mockUseChatStream = vi.fn<() => ChatStreamMock>();
vi.mock('@/hooks/use-chat-stream', () => {
  class BalanceReservedError extends Error {
    public readonly isBalanceReserved = true;
    constructor(public readonly code: string) {
      super(code);
      this.name = 'BalanceReservedError';
    }
  }
  class BillingMismatchError extends Error {
    public readonly isBillingMismatch = true;
    constructor(public readonly code: string) {
      super(code);
      this.name = 'BillingMismatchError';
    }
  }
  class ContextCapacityError extends Error {
    public readonly isContextCapacity = true;
    constructor(public readonly code: string) {
      super(code);
      this.name = 'ContextCapacityError';
    }
  }
  return {
    useChatStream: (): ChatStreamMock => mockUseChatStream(),
    BalanceReservedError,
    BillingMismatchError,
    ContextCapacityError,
  };
});

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

interface CreateConversationMock {
  mutateAsync: ReturnType<typeof vi.fn>;
  isPending: boolean;
}

const mockCreateConversationMutateAsync = vi.fn();
const mockUseCreateConversation = vi.fn<() => CreateConversationMock>();

interface ConversationQueryMock {
  data: { id: string; title: string; titleEpochNumber?: number; currentEpoch?: number } | undefined;
  isLoading: boolean;
}

const mockUseConversation = vi.fn<(id: string) => ConversationQueryMock>();

interface MessagesQueryMock {
  data: Message[] | undefined;
  isLoading: boolean;
}

const mockUseMessages = vi.fn<(id: string) => MessagesQueryMock>();

vi.mock('@/hooks/chat', () => ({
  useCreateConversation: (): CreateConversationMock => mockUseCreateConversation(),
  useConversation: (id: string): ConversationQueryMock => mockUseConversation(id),
  useMessages: (id: string): MessagesQueryMock => mockUseMessages(id),
  chatKeys: {
    conversation: (id: string) => ['conversation', id],
    messages: (id: string) => ['messages', id],
  },
  DECRYPTING_TITLE: 'Decrypting...',
}));

vi.mock('@/hooks/forks', () => ({
  useForks: () => ({ data: [], isLoading: false }),
  useCreateFork: () => ({ mutate: vi.fn() }),
  useDeleteFork: () => ({ mutate: vi.fn() }),
  useRenameFork: () => ({ mutate: vi.fn() }),
}));

vi.mock('@/hooks/use-fork-messages', () => ({
  useForkMessages: (messages: Message[]) => messages,
}));

const mockSetActiveFork = vi.fn();
let mockActiveForkId: string | null = null;

vi.mock('@/stores/fork', () => ({
  useForkStore: Object.assign(
    () => ({
      activeForkId: mockActiveForkId,
      setActiveFork: mockSetActiveFork,
    }),
    {
      getState: () => ({
        activeForkId: mockActiveForkId,
        setActiveFork: mockSetActiveFork,
      }),
    }
  ),
}));

vi.mock('@/components/sidebar/rename-conversation-dialog', () => ({
  RenameConversationDialog: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    value: string;
    onValueChange: (v: string) => void;
    onConfirm: () => void;
  }) => {
    return props.open ? (
      <div data-testid="rename-fork-dialog" data-value={props.value}>
        <button data-testid="confirm-rename" onClick={props.onConfirm}>
          Save
        </button>
      </div>
    ) : null;
  },
}));

vi.mock('@/components/sidebar/delete-conversation-dialog', () => ({
  DeleteConversationDialog: (props: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    title: string;
    onConfirm: () => void;
  }) => {
    return props.open ? (
      <div data-testid="delete-fork-dialog" data-title={props.title}>
        <button data-testid="confirm-delete" onClick={props.onConfirm}>
          Delete
        </button>
      </div>
    ) : null;
  },
}));

vi.mock('@/hooks/billing', () => ({
  billingKeys: { balance: () => ['balance'] },
}));

interface PendingChatStoreMock {
  pendingMessage: string | null;
  clearPendingMessage: ReturnType<typeof vi.fn>;
}

const mockClearPendingMessage = vi.fn();
let mockPendingMessage: string | null = null;

vi.mock('@/stores/pending-chat', () => ({
  usePendingChatStore: (selector: (state: PendingChatStoreMock) => unknown) => {
    const state: PendingChatStoreMock = {
      pendingMessage: mockPendingMessage,
      clearPendingMessage: mockClearPendingMessage,
    };
    return selector(state);
  },
}));

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  return {
    ...actual,
    useModelStore: () => ({ selectedModels: [{ id: 'test-model', name: 'Test Model' }] }),
  };
});

const mockScrollToBottom = vi.fn();
vi.mock('@/hooks/use-scroll-behavior', () => ({
  useScrollBehavior: () => ({
    handleScroll: vi.fn(),
    scrollToBottom: mockScrollToBottom,
    bottomPadding: 800,
    isAutoScrollEnabled: true,
  }),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    generateChatTitle: (content: string) => `Chat: ${content.slice(0, 10)}`,
    toBase64: (data: Uint8Array) => `base64-${String(data[0])}`,
    fromBase64: (string_: string) =>
      new Uint8Array(Array.from(string_, (c) => c.codePointAt(0) ?? 0)),
  };
});

const mockPrivateKey = new Uint8Array(32).fill(1);

vi.mock('@hushbox/crypto', () => ({
  createFirstEpoch: () => ({
    epochPublicKey: new Uint8Array(32).fill(10),
    epochPrivateKey: new Uint8Array(32).fill(11),
    confirmationHash: new Uint8Array(32).fill(12),
    memberWraps: [
      { memberPublicKey: new Uint8Array(32).fill(13), wrap: new Uint8Array(48).fill(14) },
    ],
  }),
  getPublicKeyFromPrivate: () => new Uint8Array(32).fill(13),
  encryptMessageForStorage: () => new Uint8Array(64).fill(20),
  decryptMessage: (_key: Uint8Array, _blob: Uint8Array) => 'Decrypted Title',
}));

let mockAuthPrivateKey: Uint8Array | null = mockPrivateKey;

vi.mock('@/lib/auth', () => ({
  useAuthStore: (selector: (state: { privateKey: Uint8Array | null }) => unknown) =>
    selector({ privateKey: mockAuthPrivateKey }),
}));

vi.mock('@/hooks/use-decrypted-messages', () => ({
  useDecryptedMessages: (_conversationId: string | null, msgs: Message[] | undefined) => msgs ?? [],
}));

const mockUseGroupChat = vi.fn();
vi.mock('@/hooks/use-group-chat', () => ({
  useGroupChat: (...args: unknown[]) => mockUseGroupChat(...args),
}));

vi.mock('@/lib/chat-regeneration', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/chat-regeneration')>();
  return { ...actual };
});

const mockFetchJson = vi.fn();
vi.mock('@/lib/api-client', () => ({
  client: {
    api: {
      chat: new Proxy(
        {},
        {
          get: () => ({
            message: {
              $post: vi.fn(() => Promise.resolve(new Response())),
            },
          }),
        }
      ),
    },
  },
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

interface StreamOptions {
  onStart?: (data: {
    userMessageId: string;
    models: { modelId: string; assistantMessageId: string }[];
  }) => void;
  onToken?: (token: string, modelId: string) => void;
}

interface SetupMocksOptions {
  pendingMessage?: string | null;
  isStreaming?: boolean;
  isPending?: boolean;
  conversationData?:
    | { id: string; title: string; titleEpochNumber?: number; currentEpoch?: number }
    | undefined;
  messagesData?: Message[] | undefined;
  isConversationLoading?: boolean;
  isMessagesLoading?: boolean;
  isMobile?: boolean;
  inputValue?: string;
}

function setupMocks(overrides: SetupMocksOptions = {}): void {
  const {
    pendingMessage = null,
    isStreaming = false,
    isPending = false,
    conversationData,
    messagesData,
    isConversationLoading = false,
    isMessagesLoading = false,
    isMobile = false,
    inputValue = '',
  } = overrides;

  mockPendingMessage = pendingMessage;

  mockUseChatPageState.mockReturnValue({
    inputValue,
    setInputValue: mockSetInputValue,
    clearInput: mockClearInput,
    streamingMessageIds: new Set<string>(),
    streamingMessageIdsRef,
    startStreaming: mockStartStreaming,
    stopStreaming: mockStopStreaming,
  });

  mockUseChatStream.mockReturnValue({
    isStreaming,
    startStream: mockStartStream,
  });

  mockUseCreateConversation.mockReturnValue({
    mutateAsync: mockCreateConversationMutateAsync,
    isPending,
  });

  mockUseConversation.mockReturnValue({
    data: conversationData,
    isLoading: isConversationLoading,
  });

  mockUseMessages.mockReturnValue({
    data: messagesData,
    isLoading: isMessagesLoading,
  });

  mockUseIsMobile.mockReturnValue(isMobile);
}

function setupSuccessfulCreation(): void {
  mockCreateConversationMutateAsync.mockResolvedValue({
    conversation: { id: 'conv-123' },
    isNew: true,
  });
  mockStartStream.mockResolvedValue({
    userMessageId: 'user-1',
    models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1', cost: '0' }],
  });
}

describe('AuthenticatedChatPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearEpochKeyCache();
    mockPendingMessage = null;
    streamingMessageIdsRef.current = new Set<string>();
    mockChatErrorState.error = null;
    mockActiveForkId = null;
    mockAuthPrivateKey = mockPrivateKey;
    mockUseGroupChat.mockImplementation((conversationId: string | null) => {
      if (!conversationId) return;
      return {
        conversationId,
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
      };
    });
    setupMocks();
  });

  describe('create mode (routeConversationId === "new")', () => {
    it('redirects to chat list when no pending message', () => {
      setupMocks({ pendingMessage: null });
      render(<AuthenticatedChatPage routeConversationId="new" />);
      expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });

    it('does NOT redirect when pending message exists', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockCreateConversationMutateAsync).toHaveBeenCalled();
      });

      expect(mockNavigate).not.toHaveBeenCalledWith({ to: '/chat' });
    });

    it('shows user message immediately when pending message exists', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(screen.getByTestId('message-count')).toHaveTextContent('1');
      });
    });

    it('creates conversation with generated UUID and epoch fields', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockCreateConversationMutateAsync).toHaveBeenCalledWith({
          id: expect.any(String),
          title: 'base64-20',
          epochPublicKey: 'base64-10',
          confirmationHash: 'base64-12',
          memberWrap: 'base64-14',
        });
      });
    });

    it('clears pending message after conversation creation', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockClearPendingMessage).toHaveBeenCalled();
      });
    });

    it('shows loading state while creating conversation', () => {
      setupMocks({ pendingMessage: 'Hello', isPending: true });
      render(<AuthenticatedChatPage routeConversationId="new" />);
      // Loading state is indicated by having a user message visible (from pendingMessage)
      // and inputDisabled being true until real conversation ID is set
      expect(screen.getByTestId('message-count')).toHaveTextContent('1');
    });

    it('sets title from message content', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(screen.getByTestId('title')).toHaveTextContent('Chat: Hello AI');
      });
    });

    it('calls startStream after conversation creation', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: 'conv-123',
            models: ['test-model'],
            userMessage: expect.objectContaining({
              id: expect.any(String),
              content: expect.any(String),
            }),
            messagesForInference: [{ role: 'user', content: 'Hello AI' }],
          }),
          expect.objectContaining({
            onStart: expect.any(Function) as unknown,
            onToken: expect.any(Function) as unknown,
          })
        );
      });
    });

    it('handles onStart callback from stream', async () => {
      mockCreateConversationMutateAsync.mockResolvedValue({
        conversation: { id: 'conv-123' },
        isNew: true,
      });
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        options?.onStart?.({
          userMessageId: 'user-1',
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
        });
        return Promise.resolve({
          userMessageId: 'user-1',
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1', cost: '0' }],
        });
      });
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStartStreaming).toHaveBeenCalledWith(['assistant-1']);
      });
    });

    it('handles onToken callback from stream', async () => {
      mockCreateConversationMutateAsync.mockResolvedValue({
        conversation: { id: 'conv-123' },
        isNew: true,
      });
      mockStartStream.mockImplementation((_request: unknown, options?: StreamOptions) => {
        options?.onStart?.({
          userMessageId: 'user-1',
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1' }],
        });
        options?.onToken?.('Hello', 'test-model');
        return Promise.resolve({
          userMessageId: 'user-1',
          models: [{ modelId: 'test-model', assistantMessageId: 'assistant-1', cost: '0' }],
        });
      });
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalled();
      });
    });

    it('stops streaming after completion', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalled();
      });
    });

    it('navigates back to chat on creation error', async () => {
      mockCreateConversationMutateAsync.mockRejectedValue(new Error('Creation failed'));
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
      });
    });

    it('shows generic error to user when first-message stream fails', async () => {
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      mockCreateConversationMutateAsync.mockResolvedValue({
        conversation: { id: 'conv-123' },
        isNew: true,
      });
      mockStartStream.mockRejectedValue(new Error('Stream failed'));

      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalledWith(
          expect.objectContaining({
            retryable: false,
          })
        );
      });

      consoleErrorSpy.mockRestore();
    });

    it('shows processing state when streaming', () => {
      setupMocks({ pendingMessage: 'Hello', isStreaming: true });
      render(<AuthenticatedChatPage routeConversationId="new" />);
      expect(screen.getByTestId('is-processing')).toHaveTextContent('true');
    });

    it('navigates to /chat/:uuid after successful creation', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({
          to: '/chat/$id',
          params: { id: 'conv-123' },
          replace: true,
        });
      });
    });

    it('does not create conversation when accountPrivateKey is null', () => {
      mockAuthPrivateKey = null;
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      expect(mockCreateConversationMutateAsync).not.toHaveBeenCalled();
    });
  });

  describe('existing chat mode (routeConversationId === UUID)', () => {
    it('fetches conversation and messages', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockUseConversation).toHaveBeenCalledWith('conv-456');
      expect(mockUseMessages).toHaveBeenCalledWith('conv-456');
    });

    it('renders ChatLayout with isDecrypting while fetching', () => {
      setupMocks({
        isConversationLoading: true,
        isMessagesLoading: true,
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      const layout = screen.getByTestId('chat-layout');
      expect(layout).toBeInTheDocument();
      expect(layout).toHaveAttribute('data-decrypting', 'true');
      expect(screen.getByTestId('input-disabled')).toHaveTextContent('true');
    });

    it('displays messages from API', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
          {
            id: 'm2',
            conversationId: 'conv-456',
            role: 'assistant',
            content: 'Hello',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('message-count')).toHaveTextContent('2');
    });

    it('displays decrypted conversation title when epoch key available', () => {
      setEpochKey('conv-456', 1, new Uint8Array(32).fill(11));
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-blob', titleEpochNumber: 1 },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('title')).toHaveTextContent('Decrypted Title');
    });

    it('displays Decrypting... when epoch key not available', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-blob', titleEpochNumber: 1 },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('title')).toHaveTextContent('Decrypting...');
    });

    it('redirects if conversation not found', () => {
      setupMocks({
        conversationData: undefined,
        isConversationLoading: false,
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('navigate')).toHaveAttribute('data-to', '/chat');
    });

    it('submits new message with optimistic update', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        userMessageId: 'user-2',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-2', cost: '0' }],
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
        inputValue: 'New message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });

      expect(mockStartStream).toHaveBeenCalledWith(
        expect.objectContaining({
          conversationId: 'conv-456',
          models: ['test-model'],
          userMessage: expect.objectContaining({
            id: expect.any(String),
            content: 'New message',
          }),
          messagesForInference: expect.arrayContaining([
            expect.objectContaining({ role: 'user', content: 'New message' }),
          ]),
        }),
        expect.any(Object)
      );
    });

    it('does not submit empty message', async () => {
      const user = userEvent.setup();
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: '   ',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('streams assistant response after message sent', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        assistantMessageId: 'assistant-2',
        content: 'Response',
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
        inputValue: 'New message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStartStream).toHaveBeenCalledWith(
          expect.objectContaining({
            conversationId: 'conv-456',
            models: ['test-model'],
          }),
          expect.any(Object)
        );
      });
    });

    it('passes displayTitle to useGroupChat for epoch rotation', () => {
      setEpochKey('conv-456', 1, new Uint8Array(32).fill(11));
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-blob', titleEpochNumber: 1 },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockUseGroupChat).toHaveBeenCalledWith(
        'conv-456',
        undefined,
        'Decrypted Title',
        streamingMessageIdsRef
      );
    });

    it('passes conversationId via groupChat to ChatLayout', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockUseGroupChat).toHaveBeenCalledWith(
        'conv-456',
        undefined,
        expect.anything(),
        streamingMessageIdsRef
      );
      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-conversation-id', 'conv-456');
    });

    it('passes conversationId directly to ChatLayout even when groupChat is undefined', () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockReturnValue requires an argument
      mockUseGroupChat.mockReturnValue(undefined);
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-conversation-id', 'conv-456');
    });

    it('passes undefined to useGroupChat initially for new conversation', () => {
      setupMocks({ pendingMessage: null });

      render(<AuthenticatedChatPage routeConversationId="new" />);

      expect(mockUseGroupChat).toHaveBeenCalledWith(
        null,
        undefined,
        undefined,
        streamingMessageIdsRef
      );
    });

    it('passes realConversationId to useGroupChat after conversation creation', async () => {
      setupSuccessfulCreation();
      setupMocks({ pendingMessage: 'Hello AI' });
      render(<AuthenticatedChatPage routeConversationId="new" />);

      await waitFor(() => {
        expect(mockUseGroupChat).toHaveBeenCalledWith(
          'conv-123',
          undefined,
          expect.anything(),
          streamingMessageIdsRef
        );
      });
    });

    it('passes groupChat members from useGroupChat hook', () => {
      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
        ],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
      });
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-conversation-id', 'conv-456');
    });

    it('calculates history characters from messages', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hello',
            createdAt: '',
          },
          {
            id: 'm2',
            conversationId: 'conv-456',
            role: 'assistant',
            content: 'Hi there',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // "Hello" (5) + "Hi there" (8) = 13
      expect(screen.getByTestId('history-characters')).toHaveTextContent('13');
    });

    it('appends phantom messages from remoteStreamingMessages to messages array', () => {
      const phantomMap = new Map([
        [
          'phantom-user-1',
          { content: 'Hello from Bob', senderType: 'user' as const, senderId: 'u2' },
        ],
        ['phantom-ai-1', { content: 'Echo: Hello', senderType: 'ai' as const }],
      ]);

      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
        ],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
        remoteStreamingMessages: phantomMap,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // 1 real message + 2 phantom messages = 3
      expect(screen.getByTestId('message-count')).toHaveTextContent('3');
      expect(screen.getByTestId('message-ids')).toHaveTextContent('m1,phantom-user-1,phantom-ai-1');
    });

    it('sets streamingMessageIds to remote AI phantom when no local streaming', () => {
      const phantomMap = new Map([
        ['phantom-ai-1', { content: 'Echo: Hello', senderType: 'ai' as const }],
      ]);

      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
        remoteStreamingMessages: phantomMap,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute(
        'data-streaming-ids',
        'phantom-ai-1'
      );
    });

    it('deduplicates phantom messages whose IDs already exist in API messages', () => {
      const phantomMap = new Map([
        ['m1', { content: 'Hello from Bob', senderType: 'user' as const, senderId: 'u2' }],
        ['phantom-ai-1', { content: 'Echo: Hello', senderType: 'ai' as const }],
      ]);

      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [
          { id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' },
          { id: 'm2', userId: 'u2', username: 'bob', privilege: 'write' },
        ],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
        remoteStreamingMessages: phantomMap,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // phantom 'm1' should be deduped (already in API messages), only phantom-ai-1 remains
      expect(screen.getByTestId('message-count')).toHaveTextContent('2');
      expect(screen.getByTestId('message-ids')).toHaveTextContent('m1,phantom-ai-1');
    });

    it('does not append phantom messages when remoteStreamingMessages is empty', () => {
      mockUseGroupChat.mockReturnValue({
        conversationId: 'conv-456',
        members: [{ id: 'm1', userId: 'u1', username: 'alice', privilege: 'owner' }],
        links: [],
        onlineMemberIds: new Set<string>(),
        currentUserId: 'u1',
        currentUserPrivilege: 'owner',
        currentEpochPrivateKey: new Uint8Array(32),
        currentEpochNumber: 1,
        remoteStreamingMessages: new Map(),
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('message-count')).toHaveTextContent('1');
    });
  });

  describe('state reset on navigation', () => {
    it('resets state when navigating between existing conversations', () => {
      setEpochKey('conv-456', 1, new Uint8Array(32).fill(11));
      setEpochKey('conv-789', 1, new Uint8Array(32).fill(11));
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-1', titleEpochNumber: 1 },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
      });

      const { rerender } = render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // Navigate to different conversation
      setupMocks({
        conversationData: { id: 'conv-789', title: 'encrypted-2', titleEpochNumber: 1 },
        messagesData: [
          {
            id: 'm2',
            conversationId: 'conv-789',
            role: 'user',
            content: 'Different',
            createdAt: '',
          },
        ],
      });

      rerender(<AuthenticatedChatPage routeConversationId="conv-789" />);

      // Should show decrypted title for new conversation
      expect(screen.getByTestId('title')).toHaveTextContent('Decrypted Title');
    });
  });

  describe('input handling', () => {
    it('disables input in create mode', () => {
      setupMocks({ pendingMessage: 'Hello' });
      render(<AuthenticatedChatPage routeConversationId="new" />);
      expect(screen.getByTestId('input-disabled')).toHaveTextContent('true');
    });

    it('enables input in existing chat mode', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });
      render(<AuthenticatedChatPage routeConversationId="conv-456" />);
      expect(screen.getByTestId('input-disabled')).toHaveTextContent('false');
    });

    it('clears input after submit on desktop', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        userMessageId: 'user-2',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-2', cost: '0' }],
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
        isMobile: false,
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });
    });
  });

  describe('send message error handling', () => {
    it('shows generic error to user for unrecognized errors', async () => {
      const user = userEvent.setup();
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());
      mockStartStream.mockRejectedValue(new Error('Stream failed'));

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockStopStreaming).toHaveBeenCalled();
      });

      expect(mockSetError).toHaveBeenCalledWith(
        expect.objectContaining({
          retryable: false,
          failedUserMessage: expect.objectContaining({
            content: 'Test message',
          }),
        })
      );
      consoleErrorSpy.mockRestore();
    });

    it('sets retryable chat error and invalidates billing on BillingMismatchError', async () => {
      const { BillingMismatchError } = await import('@/hooks/use-chat-stream');
      const user = userEvent.setup();
      mockStartStream.mockRejectedValue(new BillingMismatchError('BILLING_MISMATCH'));

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: ['balance'],
        });
      });

      expect(mockSetError).toHaveBeenCalledWith(
        expect.objectContaining({
          retryable: true,
          failedUserMessage: expect.objectContaining({
            content: 'Test message',
          }),
        })
      );
    });

    it('sets non-retryable chat error on ContextCapacityError', async () => {
      const { ContextCapacityError } = await import('@/hooks/use-chat-stream');
      const user = userEvent.setup();
      mockStartStream.mockRejectedValue(new ContextCapacityError('CONTEXT_LENGTH_EXCEEDED'));

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalledWith(
          expect.objectContaining({
            retryable: false,
            failedUserMessage: expect.objectContaining({
              content: 'Test message',
            }),
          })
        );
      });
    });

    it('sets chat error on BalanceReservedError', async () => {
      const { BalanceReservedError } = await import('@/hooks/use-chat-stream');
      const user = userEvent.setup();
      mockStartStream.mockRejectedValue(new BalanceReservedError('BALANCE_RESERVED'));

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Test message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockSetError).toHaveBeenCalledWith(
          expect.objectContaining({
            retryable: true,
            failedUserMessage: expect.objectContaining({
              content: 'Test message',
            }),
          })
        );
      });
    });
  });

  describe('error message in messages list', () => {
    it('appends error message to messages when chat error exists', () => {
      mockChatErrorState.error = {
        id: 'error-id',
        content: 'Please wait for your current messages to finish.',
        retryable: true,
        failedUserMessage: { id: 'failed-msg-id', content: 'Hello' },
      };

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // 1 real message + 1 error message = 2
      expect(screen.getByTestId('message-count')).toHaveTextContent('2');
    });

    it('does not append error message when no error exists', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('message-count')).toHaveTextContent('1');
    });
  });

  describe('error cleanup', () => {
    it('clears chat error when submitting a new message', async () => {
      const user = userEvent.setup();
      mockStartStream.mockResolvedValue({
        userMessageId: 'user-2',
        models: [{ modelId: 'test-model', assistantMessageId: 'assistant-2', cost: '0' }],
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [
          {
            id: 'm1',
            conversationId: 'conv-456',
            role: 'user',
            content: 'Hi',
            createdAt: '',
          },
        ],
        inputValue: 'Retry message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit'));

      await waitFor(() => {
        expect(mockClearError).toHaveBeenCalled();
      });
    });

    it('clears chat error when navigating between conversations', () => {
      setEpochKey('conv-456', 1, new Uint8Array(32).fill(11));
      setEpochKey('conv-789', 1, new Uint8Array(32).fill(11));
      setupMocks({
        conversationData: { id: 'conv-456', title: 'encrypted-1', titleEpochNumber: 1 },
        messagesData: [],
      });

      const { rerender } = render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      mockClearError.mockClear();

      setupMocks({
        conversationData: { id: 'conv-789', title: 'encrypted-2', titleEpochNumber: 1 },
        messagesData: [],
      });

      rerender(<AuthenticatedChatPage routeConversationId="conv-789" />);

      expect(mockClearError).toHaveBeenCalled();
    });

    it('clears chat error on unmount', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      const { unmount } = render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      mockClearError.mockClear();
      unmount();

      expect(mockClearError).toHaveBeenCalled();
    });
  });

  describe('user-only messages (AI toggle off)', () => {
    it('passes onSubmitUserOnly to ChatLayout', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('submit-user-only')).toBeInTheDocument();
    });

    it('sends user-only message via fetchJson without streaming', async () => {
      const user = userEvent.setup();
      mockFetchJson.mockResolvedValue({
        messageId: 'msg-1',
        sequenceNumber: 0,
        epochNumber: 1,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Human only message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit-user-only'));

      await waitFor(() => {
        expect(mockFetchJson).toHaveBeenCalled();
      });

      // No streaming should be triggered
      expect(mockStartStream).not.toHaveBeenCalled();
    });

    it('clears input after sending user-only message', async () => {
      const user = userEvent.setup();
      mockFetchJson.mockResolvedValue({
        messageId: 'msg-1',
        sequenceNumber: 0,
        epochNumber: 1,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Human only message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit-user-only'));

      await waitFor(() => {
        expect(mockClearInput).toHaveBeenCalled();
      });
    });

    it('does not send user-only message when input is empty', async () => {
      const user = userEvent.setup();

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: '   ',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit-user-only'));

      expect(mockFetchJson).not.toHaveBeenCalled();
    });

    it('invalidates messages query after successful user-only send', async () => {
      const user = userEvent.setup();
      mockFetchJson.mockResolvedValue({
        messageId: 'msg-1',
        sequenceNumber: 0,
        epochNumber: 1,
      });

      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test Chat' },
        messagesData: [],
        inputValue: 'Human only message',
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      await user.click(screen.getByTestId('submit-user-only'));

      await waitFor(() => {
        expect(mockInvalidateQueries).toHaveBeenCalledWith({
          queryKey: ['conversation', 'conv-456'],
        });
      });
    });
  });

  describe('fork URL sync', () => {
    it('initializes fork store from initialForkId prop', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" initialForkId="fork-abc" />);

      expect(mockSetActiveFork).toHaveBeenCalledWith('fork-abc');
    });

    it('does not initialize fork store when initialForkId is undefined', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(mockSetActiveFork).not.toHaveBeenCalled();
    });
  });

  describe('fork rename modal', () => {
    it('opens rename dialog when onForkRename is called', async () => {
      const user = userEvent.setup();
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // Initially no dialog
      expect(screen.queryByTestId('rename-fork-dialog')).not.toBeInTheDocument();

      // Trigger fork rename
      await user.click(screen.getByTestId('trigger-fork-rename'));

      // Dialog should now be visible with the current fork name
      expect(screen.getByTestId('rename-fork-dialog')).toBeInTheDocument();
      expect(screen.getByTestId('rename-fork-dialog')).toHaveAttribute('data-value', 'Fork 1');
    });

    it('opens delete dialog when onForkDelete is called', async () => {
      const user = userEvent.setup();
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      // Initially no dialog
      expect(screen.queryByTestId('delete-fork-dialog')).not.toBeInTheDocument();

      // Trigger fork delete
      await user.click(screen.getByTestId('trigger-fork-delete'));

      // Dialog should now be visible
      expect(screen.getByTestId('delete-fork-dialog')).toBeInTheDocument();
    });
  });

  describe('message action callbacks', () => {
    it('passes onRegenerate to ChatLayout', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-has-on-regenerate', 'true');
    });

    it('passes onEdit to ChatLayout', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-has-on-edit', 'true');
    });

    it('passes onFork to ChatLayout', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Test' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      expect(screen.getByTestId('chat-layout')).toHaveAttribute('data-has-on-fork', 'true');
    });
  });

  describe('link guest mode (privateKeyOverride)', () => {
    it('passes isAuthenticated=false and isLinkGuest=true when privateKeyOverride is set', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Shared' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(
        <AuthenticatedChatPage
          routeConversationId="conv-456"
          privateKeyOverride={new Uint8Array(32)}
        />
      );

      const layout = screen.getByTestId('chat-layout');
      expect(layout).toHaveAttribute('data-is-authenticated', 'false');
      expect(layout).toHaveAttribute('data-is-link-guest', 'true');
    });

    it('defaults callerPrivilege to read during loading when link guest', () => {
      setupMocks({ isConversationLoading: true });

      render(
        <AuthenticatedChatPage
          routeConversationId="conv-456"
          privateKeyOverride={new Uint8Array(32)}
        />
      );

      const layout = screen.getByTestId('chat-layout');
      expect(layout).toHaveAttribute('data-caller-privilege', 'read');
    });

    it('passes isAuthenticated=true when not a link guest', () => {
      setupMocks({
        conversationData: { id: 'conv-456', title: 'Normal' },
        messagesData: [
          { id: 'm1', conversationId: 'conv-456', role: 'user', content: 'Hi', createdAt: '' },
        ],
      });

      render(<AuthenticatedChatPage routeConversationId="conv-456" />);

      const layout = screen.getByTestId('chat-layout');
      expect(layout).toHaveAttribute('data-is-authenticated', 'true');
      expect(layout).toHaveAttribute('data-is-link-guest', 'false');
    });
  });
});
