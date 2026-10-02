import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { expectExposes } from '@hushbox/shared/test-assertions';
import { DAY_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  chatKeys,
  conversationQueryOptions,
  useConversations,
  useConversation,
  useMessages,
  useCreateConversation,
  useDeleteConversation,
  useUpdateConversation,
  useDecryptedConversations,
  DECRYPTING_TITLE,
} from '@/hooks/chat/chat';
import { useSession } from '@/lib/auth/auth';
import { client } from '@/lib/api-client';
import { queryClient as appQueryClient } from '@/providers/query-provider';
import type { ReactNode } from 'react';
import type { InferResponseType } from 'hono/client';
import type { decryptTextFromEpoch } from '@hushbox/crypto';
import type { EpochVerdict, getEpochVerdict } from '@/lib/crypto/epoch-key-cache';
import type {
  ConversationListItem,
  ConversationResponse,
  HistoryContentItemResponse,
  MessageResponse,
} from '@hushbox/shared';
import type { useAuthStore } from '@/lib/auth/auth';

type AuthState = ReturnType<typeof useAuthStore.getState>;

type AuthStateDouble = Pick<AuthState, 'privateKey'> & {
  user: Pick<NonNullable<AuthState['user']>, 'id'> | null;
};

// Mock auth to break transitive import chain to api.ts (env parse)
const DEFAULT_AUTH_STATE: AuthStateDouble = {
  privateKey: null,
  user: { id: 'test-user' },
};
let mockAuthState: AuthStateDouble = DEFAULT_AUTH_STATE;
vi.mock('@/lib/auth/auth', () => ({
  useAuthStore: vi.fn((selector: (s: AuthStateDouble) => unknown) => selector(mockAuthState)),
  useSession: vi.fn(() => {
    const user = mockAuthState.user;
    return {
      data: user ? { user, session: { id: user.id } } : null,
      isPending: false,
    };
  }),
}));

// Mock crypto and epoch-key-cache (used by useDecryptedConversations)
const mockDecryptMessage = vi.fn<typeof decryptTextFromEpoch>();
vi.mock('@hushbox/crypto', () => ({
  decryptTextFromEpoch: (...args: Parameters<typeof decryptTextFromEpoch>) =>
    mockDecryptMessage(...args),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    fromBase64: vi.fn((s: string) => new Uint8Array(Buffer.from(s, 'base64'))),
  };
});

const mockGetEpochKey = vi.fn(() => undefined as Uint8Array | undefined);
const mockGetEpochVerdict = vi.fn<typeof getEpochVerdict>();
vi.mock(import('@/lib/crypto/epoch-key-cache'), () => ({
  getEpochKey: () => mockGetEpochKey(),
  getEpochVerdict: (conversationId: string) => mockGetEpochVerdict(conversationId),
  processKeyChain: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getSnapshot: vi.fn(() => 0),
}));

const mockFetchJson = vi.fn();
vi.mock('@/lib/api-client', () => ({
  client: {
    conversations: {
      $get: vi.fn(),
      $post: vi.fn(),
      ':conversationId': {
        $get: vi.fn(),
        $delete: vi.fn(),
        $patch: vi.fn(),
        messages: {
          $get: vi.fn(),
        },
        keychain: {
          $get: vi.fn(),
        },
      },
      'member-keys': {
        batch: {
          $get: vi.fn(),
        },
      },
    },
  },
  fetchJson: (...args: unknown[]) => mockFetchJson(...args),
}));

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

describe('chatKeys', () => {
  describe('all', () => {
    it('returns base chat key', () => {
      expect(chatKeys.all).toEqual(['chat']);
    });
  });

  describe('conversations', () => {
    it('returns conversations key array', () => {
      expect(chatKeys.conversations()).toEqual(['chat', 'conversations']);
    });
  });

  describe('conversation', () => {
    it('returns conversation key with id', () => {
      expect(chatKeys.conversation('conv-123')).toEqual(['chat', 'conversations', 'conv-123']);
    });
  });
});

describe('conversationQueryOptions', () => {
  it('returns correct queryKey for a given id', () => {
    const options = conversationQueryOptions('conv-abc');
    expect(options.queryKey).toEqual(['chat', 'conversations', 'conv-abc']);
  });

  it('returns a callable queryFn', () => {
    const options = conversationQueryOptions('conv-abc');
    expectExposes(options, 'queryFn');
  });

  it('uses the same queryKey as chatKeys.conversation', () => {
    const options = conversationQueryOptions('conv-xyz');
    expect(options.queryKey).toEqual(chatKeys.conversation('conv-xyz'));
  });
});

/** The 200 body of `GET /conversations`, one page of the conversation list. */
type ConversationsPage = InferResponseType<typeof client.conversations.$get, 200>;

function listedConversation(id: string): ConversationListItem {
  return {
    id,
    title: 'Test',
    currentEpoch: 1,
    titleEpochNumber: 1,
    nextSequence: 0,
    createdAt: isoAt(TEST_DAY_START),
    updatedAt: isoAt(TEST_DAY_START),
    accepted: true,
    invitedByUsername: null,
    privilege: 'owner',
    muted: false,
    pinned: false,
    lastReadSeq: 0,
    memberCount: 1,
  };
}

describe('useConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches conversations from API', async () => {
    const mockConversations: ConversationListItem[] = [
      {
        id: '1',
        title: 'Test',
        currentEpoch: 1,
        titleEpochNumber: 1,
        nextSequence: 0,
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START),
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner',
        muted: false,
        pinned: false,
        lastReadSeq: 0,
        memberCount: 1,
      },
    ];
    const page: ConversationsPage = { conversations: mockConversations, nextCursor: null };
    mockFetchJson.mockResolvedValueOnce(page);

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockConversations);
  });

  it('handles API errors', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(mockFetchJson).toHaveBeenCalled();
  });

  it('follows nextCursor when fetchNextPage is called', async () => {
    const firstPage: ConversationsPage = {
      conversations: [listedConversation('p1')],
      nextCursor: 'cursor-1',
    };
    const lastPage: ConversationsPage = {
      conversations: [listedConversation('p2')],
      nextCursor: null,
    };
    mockFetchJson.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(lastPage);

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.hasNextPage).toBe(true);
    });

    act(() => {
      result.current.fetchNextPage();
    });

    await waitFor(() => {
      expect(result.current.data).toHaveLength(2);
    });

    // The second page request carries the cursor query param.
    expect(vi.mocked(client.conversations.$get)).toHaveBeenLastCalledWith({
      query: { cursor: 'cursor-1' },
    });
  });

  it('does not fetch when user is not authenticated', async () => {
    const previousState = mockAuthState;
    mockAuthState = { privateKey: null, user: null };

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    // Wait a tick to ensure query would have fired if enabled
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(result.current.data).toBeUndefined();
    expect(mockFetchJson).not.toHaveBeenCalled();

    mockAuthState = previousState;
  });

  it('does not fetch when masked by link-guest session', async () => {
    // Guards the link-guest path: Zustand still holds the logged-in user, but
    // useSession() returns null because getLinkGuestAuth() is active. The query
    // must respect the session mask — if it reads useAuthStore directly it will
    // fire under `credentials: 'omit'` and 401.
    vi.mocked(useSession).mockReturnValueOnce({ data: null, isPending: false });

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

    expect(result.current.data).toBeUndefined();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});

/** The 200 body of `GET /conversations/:id`, the conversation with the caller's membership. */
type ConversationDetail = InferResponseType<
  (typeof client.conversations)[':conversationId']['$get'],
  200
>;

function conversationRecord(id: string): ConversationResponse {
  return {
    id,
    title: 'Test',
    currentEpoch: 1,
    titleEpochNumber: 1,
    nextSequence: 0,
    createdAt: isoAt(TEST_DAY_START),
    updatedAt: isoAt(TEST_DAY_START),
  };
}

describe('useConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
    // `mockAuthState` is a plain module binding, so a mock reset leaves it
    // where the case left it. A case that signs the caller out restores it
    // here rather than on its own success path, which a failure skips.
    mockAuthState = DEFAULT_AUTH_STATE;
  });

  it('merges membership privilege and the session caller id onto the conversation', async () => {
    const mockConversation: ConversationResponse = {
      id: 'conv-1',
      title: 'Test',
      titleEpochNumber: 1,
      currentEpoch: 1,
      nextSequence: 0,
      createdAt: isoAt(TEST_DAY_START),
      updatedAt: isoAt(TEST_DAY_START),
    };
    const detail: ConversationDetail = {
      conversation: mockConversation,
      membership: {
        privilege: 'write',
        muted: false,
        pinned: false,
        accepted: true,
        visibleFromEpoch: 1,
        lastReadSeq: 0,
        linkId: null,
      },
      forks: [],
    };
    mockFetchJson.mockResolvedValueOnce(detail);

    const { result } = renderHook(() => useConversation('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    // Caller id comes from the session (mockAuthState.user.id), privilege from
    // membership — neither field is on the conversation payload anymore.
    expect(result.current.data).toEqual({
      ...mockConversation,
      callerId: 'test-user',
      callerPrivilege: 'write',
    });
  });

  it('takes the caller id from the membership link id when the session has no user', async () => {
    mockAuthState = { privateKey: null, user: null };

    const detail: ConversationDetail = {
      conversation: conversationRecord('conv-1'),
      membership: {
        privilege: 'read',
        muted: false,
        pinned: false,
        accepted: true,
        visibleFromEpoch: 1,
        lastReadSeq: 0,
        linkId: 'link-1',
      },
      forks: [],
    };
    mockFetchJson.mockResolvedValueOnce(detail);

    const { result } = renderHook(() => useConversation('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.callerId).toBe('link-1');
  });

  it('prefers the session user id over a membership link id', async () => {
    const detail: ConversationDetail = {
      conversation: conversationRecord('conv-1'),
      membership: {
        privilege: 'write',
        muted: false,
        pinned: false,
        accepted: true,
        visibleFromEpoch: 1,
        lastReadSeq: 0,
        linkId: 'link-1',
      },
      forks: [],
    };
    mockFetchJson.mockResolvedValueOnce(detail);

    const { result } = renderHook(() => useConversation('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.callerId).toBe('test-user');
  });

  it('yields an undefined caller id when neither a session nor a link identifies the caller', async () => {
    mockAuthState = { privateKey: null, user: null };

    const detail: ConversationDetail = {
      conversation: conversationRecord('conv-1'),
      membership: {
        privilege: 'read',
        muted: false,
        pinned: false,
        accepted: true,
        visibleFromEpoch: 1,
        lastReadSeq: 0,
        linkId: null,
      },
      forks: [],
    };
    mockFetchJson.mockResolvedValueOnce(detail);

    const { result } = renderHook(() => useConversation('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.callerId).toBeUndefined();
  });

  it('is disabled when id is empty', () => {
    const { result } = renderHook(() => useConversation(''), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});

/** A settled assistant history row whose only variable is the served level. */
function historyMessageWithLevel(
  reasoningEffort: HistoryContentItemResponse['reasoningEffort']
): MessageResponse {
  return {
    id: 'msg-ai',
    parentMessageId: null,
    sequenceNumber: 0,
    epochNumber: 1,
    senderType: 'assistant',
    senderId: null,
    wrappedContentKey: 'wrap-1',
    batchId: 'batch-1',
    deleted: false,
    createdAt: isoAt(TEST_DAY_START),
    contentItems: [
      {
        id: 'ci-ai',
        position: 0,
        contentType: 'text',
        mimeType: null,
        byteLength: 20,
        width: null,
        height: null,
        durationMs: null,
        encryptedBlob: 'blob-ai',
        modelName: 'anthropic/claude',
        cost: '1360000',
        isSmartModel: false,
        reasoningTokens: 1204,
        reasoningEffort,
        reasoningDurationMs: null,
        inputTokens: null,
        outputTokens: null,
      },
    ],
  };
}

/** The 200 body of `GET /conversations/:id/messages`, one page of history. */
type MessagesPage = InferResponseType<
  (typeof client.conversations)[':conversationId']['messages']['$get'],
  200
>;

function historyMessage(id: string, sequenceNumber: number): MessageResponse {
  return {
    id,
    parentMessageId: null,
    sequenceNumber,
    epochNumber: 1,
    senderType: 'user',
    senderId: 'user-1',
    wrappedContentKey: `wrap-${id}`,
    batchId: 'batch-1',
    deleted: false,
    createdAt: isoAt(TEST_DAY_START),
    contentItems: [],
  };
}

describe('useMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches history and returns the wire messages unadapted', async () => {
    const historyMessages: MessageResponse[] = [
      {
        id: 'msg-1',
        parentMessageId: null,
        sequenceNumber: 0,
        epochNumber: 1,
        senderType: 'user',
        senderId: 'user-1',
        wrappedContentKey: 'wrap-1',
        batchId: 'batch-1',
        deleted: false,
        createdAt: isoAt(TEST_DAY_START),
        contentItems: [
          {
            id: 'ci-1',
            position: 0,
            contentType: 'text',
            mimeType: null,
            byteLength: 12,
            width: null,
            height: null,
            durationMs: null,
            encryptedBlob: 'blob-1',
            modelName: null,
            cost: null,
            isSmartModel: false,
            reasoningTokens: null,
            reasoningEffort: null,
            reasoningDurationMs: null,
            inputTokens: null,
            outputTokens: null,
          },
        ],
      },
      {
        id: 'msg-2',
        parentMessageId: 'msg-1',
        sequenceNumber: 1,
        epochNumber: 1,
        senderType: 'assistant',
        senderId: null,
        wrappedContentKey: 'wrap-2',
        batchId: 'batch-1',
        deleted: false,
        createdAt: isoAt(TEST_DAY_START),
        contentItems: [],
      },
    ];
    const page: MessagesPage = { messages: historyMessages, nextCursor: null };
    mockFetchJson.mockResolvedValueOnce(page);

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(historyMessages);
  });

  it('maps the settled display metadata (model, cost, smart) from the wire', async () => {
    const historyMessages: MessageResponse[] = [
      {
        id: 'msg-ai',
        parentMessageId: null,
        sequenceNumber: 0,
        epochNumber: 1,
        senderType: 'assistant',
        senderId: null,
        wrappedContentKey: 'wrap-1',
        batchId: 'batch-1',
        deleted: false,
        createdAt: isoAt(TEST_DAY_START),
        contentItems: [
          {
            id: 'ci-ai',
            position: 0,
            contentType: 'text',
            mimeType: null,
            byteLength: 20,
            width: null,
            height: null,
            durationMs: null,
            encryptedBlob: 'blob-ai',
            modelName: 'anthropic/claude',
            cost: '1360000',
            isSmartModel: true,
            reasoningTokens: null,
            reasoningEffort: null,
            reasoningDurationMs: null,
            inputTokens: null,
            outputTokens: null,
          },
        ],
      },
    ];
    const page: MessagesPage = { messages: historyMessages, nextCursor: null };
    mockFetchJson.mockResolvedValueOnce(page);

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const item = result.current.data?.[0]?.contentItems[0];
    expect(item?.modelName).toBe('anthropic/claude');
    expect(item?.cost).toBe('1360000');
    expect(item?.isSmartModel).toBe(true);
  });

  it('maps the persisted reasoning token count from the wire', async () => {
    const historyMessages: MessageResponse[] = [
      {
        id: 'msg-ai',
        parentMessageId: null,
        sequenceNumber: 0,
        epochNumber: 1,
        senderType: 'assistant',
        senderId: null,
        wrappedContentKey: 'wrap-1',
        batchId: 'batch-1',
        deleted: false,
        createdAt: isoAt(TEST_DAY_START),
        contentItems: [
          {
            id: 'ci-ai',
            position: 0,
            contentType: 'text',
            mimeType: null,
            byteLength: 20,
            width: null,
            height: null,
            durationMs: null,
            encryptedBlob: 'blob-ai',
            modelName: 'anthropic/claude',
            cost: '1360000',
            isSmartModel: false,
            reasoningTokens: 1204,
            reasoningEffort: null,
            reasoningDurationMs: null,
            inputTokens: null,
            outputTokens: null,
          },
        ],
      },
    ];
    const page: MessagesPage = { messages: historyMessages, nextCursor: null };
    mockFetchJson.mockResolvedValueOnce(page);

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.[0]?.contentItems[0]?.reasoningTokens).toBe(1204);
  });

  it('carries a null wire reasoning token count through as null', async () => {
    const historyMessages: MessageResponse[] = [
      {
        id: 'msg-ai',
        parentMessageId: null,
        sequenceNumber: 0,
        epochNumber: 1,
        senderType: 'assistant',
        senderId: null,
        wrappedContentKey: 'wrap-1',
        batchId: 'batch-1',
        deleted: false,
        createdAt: isoAt(TEST_DAY_START),
        contentItems: [
          {
            id: 'ci-ai',
            position: 0,
            contentType: 'text',
            mimeType: null,
            byteLength: 20,
            width: null,
            height: null,
            durationMs: null,
            encryptedBlob: 'blob-ai',
            modelName: null,
            cost: null,
            isSmartModel: false,
            reasoningTokens: null,
            reasoningEffort: null,
            reasoningDurationMs: null,
            inputTokens: null,
            outputTokens: null,
          },
        ],
      },
    ];
    const page: MessagesPage = { messages: historyMessages, nextCursor: null };
    mockFetchJson.mockResolvedValueOnce(page);

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.[0]?.contentItems[0]?.reasoningTokens).toBeNull();
  });

  it('maps the persisted reasoning level from the wire', async () => {
    const page: MessagesPage = { messages: [historyMessageWithLevel('high')], nextCursor: null };
    mockFetchJson.mockResolvedValueOnce(page);

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.[0]?.contentItems[0]?.reasoningEffort).toBe('high');
  });

  it('keeps an off reasoning level rather than dropping it', async () => {
    const page: MessagesPage = { messages: [historyMessageWithLevel('off')], nextCursor: null };
    mockFetchJson.mockResolvedValueOnce(page);

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.[0]?.contentItems[0]?.reasoningEffort).toBe('off');
  });

  it('carries a null wire reasoning level through as null', async () => {
    const page: MessagesPage = { messages: [historyMessageWithLevel(null)], nextCursor: null };
    mockFetchJson.mockResolvedValueOnce(page);

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(result.current.data?.[0]?.contentItems[0]?.reasoningEffort).toBeNull();
  });

  it('maps persisted pixel dimensions and duration for a media content item', async () => {
    const historyMessages: MessageResponse[] = [
      {
        id: 'msg-media',
        parentMessageId: null,
        sequenceNumber: 0,
        epochNumber: 1,
        senderType: 'assistant',
        senderId: null,
        wrappedContentKey: 'wrap-1',
        batchId: 'batch-1',
        deleted: false,
        createdAt: isoAt(TEST_DAY_START),
        contentItems: [
          {
            id: 'ci-media',
            position: 0,
            contentType: 'video',
            mimeType: 'video/mp4',
            byteLength: 4096,
            width: 1920,
            height: 1080,
            durationMs: 5000,
            encryptedBlob: null,
            modelName: 'openai/sora',
            cost: null,
            isSmartModel: false,
            reasoningTokens: null,
            reasoningEffort: null,
            reasoningDurationMs: null,
            inputTokens: null,
            outputTokens: null,
          },
        ],
      },
    ];
    const page: MessagesPage = { messages: historyMessages, nextCursor: null };
    mockFetchJson.mockResolvedValueOnce(page);

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const item = result.current.data?.[0]?.contentItems[0];
    expect(item?.width).toBe(1920);
    expect(item?.height).toBe(1080);
    expect(item?.durationMs).toBe(5000);
  });

  it('follows the cursor to load every page of history', async () => {
    const firstPage: MessagesPage = {
      messages: [
        {
          id: 'msg-1',
          parentMessageId: null,
          sequenceNumber: 0,
          epochNumber: 1,
          senderType: 'user',
          senderId: 'user-1',
          wrappedContentKey: 'wrap-1',
          batchId: 'batch-1',
          deleted: false,
          createdAt: isoAt(TEST_DAY_START),
          contentItems: [],
        },
      ],
      nextCursor: '0',
    };
    const lastPage: MessagesPage = {
      messages: [
        {
          id: 'msg-2',
          parentMessageId: 'msg-1',
          sequenceNumber: 1,
          epochNumber: 1,
          senderType: 'assistant',
          senderId: null,
          wrappedContentKey: 'wrap-2',
          batchId: 'batch-1',
          deleted: false,
          createdAt: isoAt(TEST_DAY_START),
          contentItems: [],
        },
      ],
      nextCursor: null,
    };
    mockFetchJson.mockResolvedValueOnce(firstPage).mockResolvedValueOnce(lastPage);

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(2);
    expect(result.current.data?.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
  });

  it('finishes a history load its last observer left, then serves the return from cache', async () => {
    const firstPage: MessagesPage = { messages: [historyMessage('msg-1', 0)], nextCursor: '0' };
    const lastPage: MessagesPage = { messages: [historyMessage('msg-2', 1)], nextCursor: null };
    let answerLastPage: ((page: MessagesPage) => void) | undefined;
    mockFetchJson.mockResolvedValueOnce(firstPage).mockImplementationOnce(
      () =>
        new Promise<MessagesPage>((resolve) => {
          answerLastPage = resolve;
        })
    );
    const wrapper = createWrapper();
    const leaving = renderHook(() => useMessages('conv-long'), { wrapper });
    await waitFor(() => {
      expect(answerLastPage).toBeDefined();
    });

    leaving.unmount();
    answerLastPage?.(lastPage);
    await act(async () => {
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
    });
    const returning = renderHook(() => useMessages('conv-long'), { wrapper });

    expect(returning.result.current.isLoading).toBe(false);
    expect(returning.result.current.data?.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
  });

  it('holds a history load the browser went offline under until the network returns', async () => {
    const firstPage: MessagesPage = { messages: [historyMessage('msg-1', 0)], nextCursor: '0' };
    const lastPage: MessagesPage = { messages: [historyMessage('msg-2', 1)], nextCursor: null };
    let answerFirstPage: ((page: MessagesPage) => void) | undefined;
    mockFetchJson
      .mockImplementationOnce(
        () =>
          new Promise<MessagesPage>((resolve) => {
            answerFirstPage = resolve;
          })
      )
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(lastPage);
    // The app's own client, so its retry policy decides what an offline stop
    // becomes; its retry jitter is pinned to zero so the pause follows at once.
    const jitter = vi.spyOn(Math, 'random').mockReturnValue(0);
    function AppClientWrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
      return <QueryClientProvider client={appQueryClient}>{children}</QueryClientProvider>;
    }
    const { result, unmount } = renderHook(() => useMessages('conv-offline'), {
      wrapper: AppClientWrapper,
    });
    try {
      await waitFor(() => {
        expect(answerFirstPage).toBeDefined();
      });
      act(() => {
        globalThis.dispatchEvent(new Event('offline'));
      });

      answerFirstPage?.(firstPage);
      await waitFor(() => {
        expect(result.current.isPaused).toBe(true);
      });

      expect(result.current.status).toBe('pending');
      expect(mockFetchJson).toHaveBeenCalledTimes(1);

      act(() => {
        globalThis.dispatchEvent(new Event('online'));
      });
      await waitFor(() => {
        expect(result.current.data?.map((m) => m.id)).toEqual(['msg-1', 'msg-2']);
      });
    } finally {
      unmount();
      appQueryClient.clear();
      onlineManager.setOnline(true);
      jitter.mockRestore();
    }
  });

  it('is disabled when conversationId is empty', () => {
    const { result } = renderHook(() => useMessages(''), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('handles API errors', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useMessages('invalid-id'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });
});

/** The 200 body of `POST /conversations`, the created conversation. */
type CreatedConversation = InferResponseType<typeof client.conversations.$post, 200>;

describe('useCreateConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls POST /conversations with correct body', async () => {
    const mockResponse: CreatedConversation = {
      conversation: { ...conversationRecord('conv-1'), title: 'New Chat' },
      created: true,
    };
    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      id: 'conv-1',
      title: 'New Chat',
      epochPublicKey: 'test-epoch-key',
      confirmationHash: 'test-hash',
      memberWrap: 'test-wrap',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockResponse);
  });

  it('sends an Idempotency-Key header', async () => {
    const creation: CreatedConversation = {
      conversation: conversationRecord('conv-1'),
      created: true,
    };
    mockFetchJson.mockResolvedValueOnce(creation);

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      id: 'conv-1',
      epochPublicKey: 'test-epoch-key',
      confirmationHash: 'test-hash',
      memberWrap: 'test-wrap',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(vi.mocked(client.conversations.$post)).toHaveBeenCalledWith(expect.anything(), {
      headers: { 'Idempotency-Key': expect.any(String) },
    });
  });

  it('creates conversation without firstMessage field', async () => {
    const mockResponse: CreatedConversation = {
      conversation: { ...conversationRecord('conv-1'), title: '' },
      created: true,
    };
    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      id: 'conv-1',
      epochPublicKey: 'test-epoch-key',
      confirmationHash: 'test-hash',
      memberWrap: 'test-wrap',
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('handles API errors correctly', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Unauthorized'));

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      id: 'conv-error',
      title: 'Test',
      epochPublicKey: 'test-epoch-key',
      confirmationHash: 'test-hash',
      memberWrap: 'test-wrap',
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Unauthorized');
  });
});

/** The 200 body of `DELETE /conversations/:id`. */
type DeletedConversation = InferResponseType<
  (typeof client.conversations)[':conversationId']['$delete'],
  200
>;

describe('useDeleteConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls DELETE /conversations/:id', async () => {
    const mockResponse: DeletedConversation = { deleted: true };
    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('conv-1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data).toEqual(mockResponse);
  });

  it('does not refetch the deleted conversation messages after delete', async () => {
    // The list refresh must not cascade into the just-deleted conversation's
    // active messages query: a refetch of a gone id 404s. Route fetchJson by a
    // per-endpoint sentinel so a stray messages refetch resolves cleanly and is
    // caught by the call-count assertion rather than throwing.
    const messagesGet = vi.mocked(client.conversations[':conversationId'].messages.$get);
    const deleteMock = vi.mocked(client.conversations[':conversationId'].$delete);
    messagesGet.mockReturnValue('MESSAGES' as never);
    deleteMock.mockReturnValue('DELETE' as never);
    const emptyHistory: MessagesPage = { messages: [], nextCursor: null };
    const deletion: DeletedConversation = { deleted: true };
    mockFetchJson.mockImplementation((argument: unknown) => {
      if (argument === 'MESSAGES') return Promise.resolve(emptyHistory);
      if (argument === 'DELETE') return Promise.resolve(deletion);
      return Promise.reject(new Error('unexpected fetchJson call'));
    });

    const { result } = renderHook(
      () => ({ del: useDeleteConversation(), msgs: useMessages('conv-del') }),
      { wrapper: createWrapper() }
    );

    await waitFor(() => {
      expect(result.current.msgs.isSuccess).toBe(true);
    });
    expect(messagesGet).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.del.mutate('conv-del');
    });
    await waitFor(() => {
      expect(result.current.del.isSuccess).toBe(true);
    });

    expect(messagesGet).toHaveBeenCalledTimes(1);
  });

  it('sends an Idempotency-Key header', async () => {
    const deletion: DeletedConversation = { deleted: true };
    mockFetchJson.mockResolvedValueOnce(deletion);

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('conv-1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(vi.mocked(client.conversations[':conversationId'].$delete)).toHaveBeenCalledWith(
      expect.anything(),
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
  });

  it('reuses one idempotency key across a retry of the same delete', async () => {
    const retryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: 1, retryDelay: 0 } },
    });
    function RetryWrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
      return <QueryClientProvider client={retryClient}>{children}</QueryClientProvider>;
    }

    const deletion: DeletedConversation = { deleted: true };
    // First attempt fails, the retry succeeds — two mutationFn runs for the same
    // conversationId, which must share the per-id idempotency token.
    mockFetchJson.mockRejectedValueOnce(new Error('flaky')).mockResolvedValueOnce(deletion);

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: RetryWrapper });

    result.current.mutate('conv-retry');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    const deleteMock = vi.mocked(client.conversations[':conversationId'].$delete);
    expect(deleteMock).toHaveBeenCalledTimes(2);
    const firstKey = (deleteMock.mock.calls[0]![1] as { headers: { 'Idempotency-Key': string } })
      .headers['Idempotency-Key'];
    const secondKey = (deleteMock.mock.calls[1]![1] as { headers: { 'Idempotency-Key': string } })
      .headers['Idempotency-Key'];
    expect(secondKey).toBe(firstKey);
  });

  it('handles 404 error when conversation already deleted', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('deleted-id');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });

  it('handles unauthorized error', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Unauthorized'));

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('conv-1');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Unauthorized');
  });
});

/** The 200 body of `PATCH /conversations/:id`, the retitled conversation. */
type UpdatedConversation = InferResponseType<
  (typeof client.conversations)[':conversationId']['$patch'],
  200
>;

describe('useUpdateConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls PATCH /conversations/:id with title', async () => {
    const mockResponse: UpdatedConversation = {
      conversation: {
        ...conversationRecord('conv-1'),
        title: 'Updated Title',
        updatedAt: isoAt(TEST_DAY_START + DAY_MS),
      },
    };
    mockFetchJson.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: 'Updated Title', titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockFetchJson).toHaveBeenCalledTimes(1);
    expect(result.current.data?.conversation.title).toBe('Updated Title');
  });

  it('sends an Idempotency-Key header', async () => {
    const update: UpdatedConversation = {
      conversation: { ...conversationRecord('conv-1'), title: 'x' },
    };
    mockFetchJson.mockResolvedValueOnce(update);

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: 'x', titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(vi.mocked(client.conversations[':conversationId'].$patch)).toHaveBeenCalledWith(
      expect.anything(),
      { headers: { 'Idempotency-Key': expect.any(String) } }
    );
  });

  it('handles 404 error for non-existent conversation', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'invalid-id',
      data: { title: 'New Title', titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });

  it('handles validation error for empty title', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Title is required'));

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: '', titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Title is required');
  });

  it('handles validation error for title exceeding max length', async () => {
    mockFetchJson.mockRejectedValueOnce(new Error('Title too long'));

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    const longTitle = 'a'.repeat(256);
    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: longTitle, titleEpochNumber: 1 },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Title too long');
  });
});

/** The 200 body of `GET /conversations/member-keys/batch`, key chains by conversation id. */
type MemberKeysBatch = InferResponseType<
  (typeof client.conversations)['member-keys']['batch']['$get'],
  200
>;

describe('useDecryptedConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('shows Encrypted conversation placeholder when decryption throws', async () => {
    const mockConversations: ConversationListItem[] = [
      {
        id: 'conv-1',
        title: 'base64encryptedblob',
        titleEpochNumber: 1,
        currentEpoch: 1,
        nextSequence: 0,
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START),
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner',
        muted: false,
        pinned: false,
        lastReadSeq: 0,
        memberCount: 1,
      },
    ];
    const page: ConversationsPage = { conversations: mockConversations, nextCursor: null };
    mockFetchJson.mockResolvedValueOnce(page);

    // Epoch key is available so decryption path is reached
    mockGetEpochKey.mockReturnValue(new Uint8Array(32).fill(1));
    // Decryption throws (e.g., wrong key or corrupt blob)
    mockDecryptMessage.mockImplementation(() => {
      throw new Error('Decryption failed');
    });

    const { result } = renderHook(() => useDecryptedConversations(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(result.current.data![0]!.title).toBe('Encrypted conversation');
  });

  describe('a title with no verified key cached', () => {
    function listWithOneEncryptedTitle(title = 'base64encryptedblob'): void {
      const conversation: ConversationListItem = {
        id: 'conv-bad',
        title,
        titleEpochNumber: 2,
        currentEpoch: 2,
        nextSequence: 0,
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START),
        accepted: true,
        invitedByUsername: null,
        privilege: 'write',
        muted: false,
        pinned: false,
        lastReadSeq: 0,
        memberCount: 1,
      };
      const page: ConversationsPage = { conversations: [conversation], nextCursor: null };
      mockFetchJson.mockResolvedValueOnce(page);
    }

    function verdictOf(rotation: EpochVerdict['rotation']): EpochVerdict {
      return {
        currentEpoch: 2,
        rotationPending: false,
        rotation,
        lastGoodEpoch: rotation === 'ok' ? 2 : null,
        badEpochs: rotation === 'ok' ? new Set() : new Set([2]),
      };
    }

    async function listedTitle(): Promise<string> {
      const { result } = renderHook(() => useDecryptedConversations(), {
        wrapper: createWrapper(),
      });
      await waitFor(() => {
        expect(result.current.data).toBeDefined();
      });
      return result.current.data![0]!.title;
    }

    it('is named unreadable when the verdict is bad', async () => {
      listWithOneEncryptedTitle();
      mockGetEpochVerdict.mockReturnValue(verdictOf('bad'));

      expect(await listedTitle()).toBe('Encrypted conversation');
    });

    it('stays decrypting while no verdict has been reached', async () => {
      listWithOneEncryptedTitle();
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockReturnValue requires an argument for the EpochVerdict|undefined return
      mockGetEpochVerdict.mockReturnValue(undefined);

      expect(await listedTitle()).toBe(DECRYPTING_TITLE);
    });

    it('stays decrypting under an ok verdict while its key loads', async () => {
      listWithOneEncryptedTitle();
      mockGetEpochVerdict.mockReturnValue(verdictOf('ok'));

      expect(await listedTitle()).toBe(DECRYPTING_TITLE);
    });

    it('stays decrypting while its key is cached but it has no title yet', async () => {
      listWithOneEncryptedTitle('');
      mockGetEpochVerdict.mockReturnValue(verdictOf('ok'));
      mockGetEpochKey.mockReturnValue(new Uint8Array(32).fill(1));

      expect(await listedTitle()).toBe(DECRYPTING_TITLE);
    });

    it('is decrypted under an ok verdict once its key is cached', async () => {
      listWithOneEncryptedTitle();
      mockGetEpochVerdict.mockReturnValue(verdictOf('ok'));
      mockGetEpochKey.mockReturnValue(new Uint8Array(32).fill(1));
      mockDecryptMessage.mockReturnValue('Trip plans');

      expect(await listedTitle()).toBe('Trip plans');
    });
  });

  it('presents the conversation and title epoch each row claims', async () => {
    const mockConversations: ConversationListItem[] = [
      {
        id: 'conv-9',
        title: 'base64encryptedblob',
        titleEpochNumber: 4,
        currentEpoch: 4,
        nextSequence: 0,
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START),
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner',
        muted: false,
        pinned: false,
        lastReadSeq: 0,
        memberCount: 1,
      },
    ];
    const page: ConversationsPage = { conversations: mockConversations, nextCursor: null };
    mockFetchJson.mockResolvedValueOnce(page);
    mockGetEpochKey.mockReturnValue(new Uint8Array(32).fill(1));
    mockDecryptMessage.mockReturnValue('My Chat');

    const { result } = renderHook(() => useDecryptedConversations(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(result.current.data).toBeDefined();
    });

    expect(mockDecryptMessage).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
      conversationId: 'conv-9',
      epochNumber: 4,
    });
  });

  it('calls batch endpoint instead of individual key endpoints', async () => {
    const mockConversations: ConversationListItem[] = [
      {
        id: 'conv-1',
        title: 'base64blob1',
        titleEpochNumber: 1,
        currentEpoch: 1,
        nextSequence: 0,
        createdAt: isoAt(TEST_DAY_START),
        updatedAt: isoAt(TEST_DAY_START),
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner',
        muted: false,
        pinned: false,
        lastReadSeq: 0,
        memberCount: 1,
      },
      {
        id: 'conv-2',
        title: 'base64blob2',
        titleEpochNumber: 1,
        currentEpoch: 1,
        nextSequence: 0,
        createdAt: isoAt(TEST_DAY_START + DAY_MS),
        updatedAt: isoAt(TEST_DAY_START + DAY_MS),
        accepted: true,
        invitedByUsername: null,
        privilege: 'owner',
        muted: false,
        pinned: false,
        lastReadSeq: 0,
        memberCount: 1,
      },
    ];
    const page: ConversationsPage = { conversations: mockConversations, nextCursor: null };
    const memberKeys: MemberKeysBatch = {
      keys: {
        'conv-1': { epochs: [], wraps: [], currentEpoch: 1, rotationPending: false },
        'conv-2': { epochs: [], wraps: [], currentEpoch: 1, rotationPending: false },
      },
      missing: [],
    };

    // First call: GET /conversations
    // Second call: GET /conversations/member-keys/batch
    mockFetchJson.mockResolvedValueOnce(page).mockResolvedValueOnce(memberKeys);

    // Simulate needing keys (no cached epoch keys)
    mockGetEpochKey.mockReset();
    mockAuthState = { privateKey: new Uint8Array(32).fill(1), user: { id: 'test-user' } };

    const { result } = renderHook(() => useDecryptedConversations(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(mockFetchJson).toHaveBeenCalledTimes(2);
    });

    // Should have called fetchJson twice: once for conversations, once for batch keys
    expect(mockFetchJson).toHaveBeenCalledTimes(2);

    // Titles should show as Decrypting... since wraps are empty (no keys to unwrap)
    expect(result.current.data).toBeDefined();
    expect(result.current.data).toHaveLength(2);
  });
});
