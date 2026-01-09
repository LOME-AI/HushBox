/* eslint-disable @typescript-eslint/unbound-method -- vitest mocks are self-bound */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  chatKeys,
  useConversations,
  useConversation,
  useMessages,
  useCreateConversation,
  useSendMessage,
  useDeleteConversation,
  useUpdateConversation,
} from './chat';

// Mock the api module
vi.mock('../lib/api', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  },
  getApiUrl: () => 'http://localhost:8787',
}));

import { api } from '../lib/api';

const mockApi = vi.mocked(api);

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  function Wrapper({ children }: { children: ReactNode }): ReactNode {
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

  describe('messages', () => {
    it('returns messages key with conversation id', () => {
      expect(chatKeys.messages('conv-123')).toEqual([
        'chat',
        'conversations',
        'conv-123',
        'messages',
      ]);
    });
  });
});

describe('useConversations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches conversations from API', async () => {
    const mockConversations = [
      {
        id: '1',
        userId: 'user-1',
        title: 'Test',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    ];
    mockApi.get.mockResolvedValueOnce({ conversations: mockConversations });

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.get).toHaveBeenCalledWith('/conversations');
    expect(result.current.data).toEqual(mockConversations);
  });

  it('handles API errors', async () => {
    mockApi.get.mockRejectedValueOnce(new Error('Network error'));

    const { result } = renderHook(() => useConversations(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Network error');
  });
});

describe('useConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches single conversation from API', async () => {
    const mockConversation = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'Test',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };
    const mockMessages = [
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hello',
        createdAt: '2024-01-01',
      },
    ];
    mockApi.get.mockResolvedValueOnce({ conversation: mockConversation, messages: mockMessages });

    const { result } = renderHook(() => useConversation('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.get).toHaveBeenCalledWith('/conversations/conv-1');
    expect(result.current.data).toEqual(mockConversation);
  });

  it('is disabled when id is empty', () => {
    const { result } = renderHook(() => useConversation(''), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockApi.get).not.toHaveBeenCalled();
  });
});

describe('useMessages', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('fetches messages from API', async () => {
    const mockConversation = {
      id: 'conv-1',
      userId: 'user-1',
      title: 'Test',
      createdAt: '2024-01-01',
      updatedAt: '2024-01-01',
    };
    const mockMessages = [
      {
        id: 'msg-1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hello',
        createdAt: '2024-01-01',
      },
      {
        id: 'msg-2',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hi!',
        createdAt: '2024-01-01',
      },
    ];
    mockApi.get.mockResolvedValueOnce({ conversation: mockConversation, messages: mockMessages });

    const { result } = renderHook(() => useMessages('conv-1'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.get).toHaveBeenCalledWith('/conversations/conv-1');
    expect(result.current.data).toEqual(mockMessages);
  });

  it('is disabled when conversationId is empty', () => {
    const { result } = renderHook(() => useMessages(''), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(mockApi.get).not.toHaveBeenCalled();
  });

  it('handles API errors', async () => {
    mockApi.get.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useMessages('invalid-id'), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });
});

describe('useCreateConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls POST /conversations with correct body', async () => {
    const mockResponse = {
      conversation: {
        id: 'conv-1',
        userId: 'user-1',
        title: 'New Chat',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
    };
    mockApi.post.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({ title: 'New Chat' });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.post).toHaveBeenCalledWith('/conversations', { title: 'New Chat' });
    expect(result.current.data).toEqual(mockResponse);
  });

  it('returns conversation and message when firstMessage provided', async () => {
    const mockResponse = {
      conversation: {
        id: 'conv-1',
        userId: 'user-1',
        title: '',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-01',
      },
      message: {
        id: 'msg-1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hello!',
        createdAt: '2024-01-01',
      },
    };
    mockApi.post.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({ firstMessage: { content: 'Hello!' } });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.post).toHaveBeenCalledWith('/conversations', {
      firstMessage: { content: 'Hello!' },
    });
    expect(result.current.data?.message?.content).toBe('Hello!');
  });

  it('handles API errors correctly', async () => {
    mockApi.post.mockRejectedValueOnce(new Error('Unauthorized'));

    const { result } = renderHook(() => useCreateConversation(), { wrapper: createWrapper() });

    result.current.mutate({ title: 'Test' });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Unauthorized');
  });
});

describe('useSendMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls POST /conversations/:id/messages with correct body', async () => {
    const mockResponse = {
      message: {
        id: 'msg-1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hello AI!',
        createdAt: '2024-01-01',
      },
    };
    mockApi.post.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useSendMessage(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      message: { role: 'user', content: 'Hello AI!' },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.post).toHaveBeenCalledWith('/conversations/conv-1/messages', {
      role: 'user',
      content: 'Hello AI!',
    });
    expect(result.current.data).toEqual(mockResponse);
  });

  it('includes model field when provided', async () => {
    const mockResponse = {
      message: {
        id: 'msg-1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Response',
        model: 'gpt-4',
        createdAt: '2024-01-01',
      },
    };
    mockApi.post.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useSendMessage(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      message: { role: 'assistant', content: 'Response', model: 'gpt-4' },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.post).toHaveBeenCalledWith('/conversations/conv-1/messages', {
      role: 'assistant',
      content: 'Response',
      model: 'gpt-4',
    });
  });

  it('handles conversation not found error', async () => {
    mockApi.post.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useSendMessage(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'invalid-id',
      message: { role: 'user', content: 'Hello' },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });

  it('handles validation errors for empty content', async () => {
    mockApi.post.mockRejectedValueOnce(new Error('Validation failed'));

    const { result } = renderHook(() => useSendMessage(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      message: { role: 'user', content: '' },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Validation failed');
  });
});

describe('useDeleteConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls DELETE /conversations/:id', async () => {
    const mockResponse = { deleted: true };
    mockApi.delete.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('conv-1');

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.delete).toHaveBeenCalledWith('/conversations/conv-1');
    expect(result.current.data).toEqual(mockResponse);
  });

  it('handles 404 error when conversation already deleted', async () => {
    mockApi.delete.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('deleted-id');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });

  it('handles unauthorized error', async () => {
    mockApi.delete.mockRejectedValueOnce(new Error('Unauthorized'));

    const { result } = renderHook(() => useDeleteConversation(), { wrapper: createWrapper() });

    result.current.mutate('conv-1');

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Unauthorized');
  });
});

describe('useChatStream', () => {
  let mockFetch: ReturnType<typeof vi.fn<typeof fetch>>;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
    originalFetch = global.fetch;
    mockFetch = vi.fn<typeof fetch>();
    global.fetch = mockFetch;
  });

  afterEach(() => {
    vi.resetAllMocks();
    global.fetch = originalFetch;
  });

  function createMockSSEResponse(events: { event: string; data: string }[]): Response {
    const lines = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n\n`).join('');

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller): void {
        controller.enqueue(encoder.encode(lines));
        controller.close();
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  }

  it('calls POST /chat/stream with conversationId and model', async () => {
    const mockResponse = createMockSSEResponse([
      {
        event: 'start',
        data: JSON.stringify({ userMessageId: 'msg-1', assistantMessageId: 'msg-2' }),
      },
      { event: 'token', data: JSON.stringify({ content: 'Hello' }) },
      { event: 'done', data: JSON.stringify({}) },
    ]);
    mockFetch.mockResolvedValueOnce(mockResponse);

    const { useChatStream } = await import('./chat');
    const { result } = renderHook(() => useChatStream(), { wrapper: createWrapper() });

    await result.current.startStream({
      conversationId: 'conv-123',
      model: 'openai/gpt-4-turbo',
    });

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/chat/stream'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ conversationId: 'conv-123', model: 'openai/gpt-4-turbo' }),
      })
    );
  });

  it('parses start event and returns message IDs', async () => {
    const mockResponse = createMockSSEResponse([
      {
        event: 'start',
        data: JSON.stringify({ userMessageId: 'msg-1', assistantMessageId: 'msg-2' }),
      },
      { event: 'done', data: JSON.stringify({}) },
    ]);
    mockFetch.mockResolvedValueOnce(mockResponse);

    const { useChatStream } = await import('./chat');
    const { result } = renderHook(() => useChatStream(), { wrapper: createWrapper() });

    const streamResult = await result.current.startStream({
      conversationId: 'conv-123',
      model: 'openai/gpt-4-turbo',
    });

    expect(streamResult.userMessageId).toBe('msg-1');
    expect(streamResult.assistantMessageId).toBe('msg-2');
  });

  it('calls onStart callback with message IDs', async () => {
    const mockResponse = createMockSSEResponse([
      {
        event: 'start',
        data: JSON.stringify({ userMessageId: 'msg-1', assistantMessageId: 'msg-2' }),
      },
      { event: 'done', data: JSON.stringify({}) },
    ]);
    mockFetch.mockResolvedValueOnce(mockResponse);

    const { useChatStream } = await import('./chat');
    const { result } = renderHook(() => useChatStream(), { wrapper: createWrapper() });

    const onStart = vi.fn();
    await result.current.startStream(
      { conversationId: 'conv-123', model: 'openai/gpt-4-turbo' },
      { onStart }
    );

    expect(onStart).toHaveBeenCalledWith({
      userMessageId: 'msg-1',
      assistantMessageId: 'msg-2',
    });
  });

  it('accumulates content from token events', async () => {
    const mockResponse = createMockSSEResponse([
      {
        event: 'start',
        data: JSON.stringify({ userMessageId: 'msg-1', assistantMessageId: 'msg-2' }),
      },
      { event: 'token', data: JSON.stringify({ content: 'Hello' }) },
      { event: 'token', data: JSON.stringify({ content: ' ' }) },
      { event: 'token', data: JSON.stringify({ content: 'world' }) },
      { event: 'done', data: JSON.stringify({}) },
    ]);
    mockFetch.mockResolvedValueOnce(mockResponse);

    const { useChatStream } = await import('./chat');
    const { result } = renderHook(() => useChatStream(), { wrapper: createWrapper() });

    const streamResult = await result.current.startStream({
      conversationId: 'conv-123',
      model: 'openai/gpt-4-turbo',
    });

    expect(streamResult.content).toBe('Hello world');
  });

  it('throws error on stream error event', async () => {
    const mockResponse = createMockSSEResponse([
      {
        event: 'start',
        data: JSON.stringify({ userMessageId: 'msg-1', assistantMessageId: 'msg-2' }),
      },
      {
        event: 'error',
        data: JSON.stringify({ message: 'API rate limit exceeded', code: 'RATE_LIMIT' }),
      },
    ]);
    mockFetch.mockResolvedValueOnce(mockResponse);

    const { useChatStream } = await import('./chat');
    const { result } = renderHook(() => useChatStream(), { wrapper: createWrapper() });

    await expect(
      result.current.startStream({
        conversationId: 'conv-123',
        model: 'openai/gpt-4-turbo',
      })
    ).rejects.toThrow('API rate limit exceeded');
  });

  it('throws error on non-OK response', async () => {
    const errorResponse = new Response(JSON.stringify({ error: 'Conversation not found' }), {
      status: 404,
    });
    mockFetch.mockResolvedValueOnce(errorResponse);

    const { useChatStream } = await import('./chat');
    const { result } = renderHook(() => useChatStream(), { wrapper: createWrapper() });

    await expect(
      result.current.startStream({
        conversationId: 'invalid',
        model: 'openai/gpt-4-turbo',
      })
    ).rejects.toThrow('Conversation not found');
  });

  it('returns isStreaming state while streaming', async () => {
    // eslint-disable-next-line @typescript-eslint/no-empty-function -- placeholder for Promise resolve
    let resolveStream: () => void = (): void => {};
    const streamPromise = new Promise<void>((resolve) => {
      resolveStream = resolve;
    });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        controller.enqueue(
          encoder.encode('event: start\ndata: {"userMessageId":"m1","assistantMessageId":"m2"}\n\n')
        );
        await streamPromise;
        controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
        controller.close();
      },
    });

    const mockResponse = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const { useChatStream } = await import('./chat');
    const { result } = renderHook(() => useChatStream(), { wrapper: createWrapper() });

    expect(result.current.isStreaming).toBe(false);

    const streamPromiseResult = result.current.startStream({
      conversationId: 'conv-123',
      model: 'openai/gpt-4-turbo',
    });

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(true);
    });

    resolveStream();
    await streamPromiseResult;

    await waitFor(() => {
      expect(result.current.isStreaming).toBe(false);
    });
  });

  it('provides onToken callback for live updates', async () => {
    const mockResponse = createMockSSEResponse([
      {
        event: 'start',
        data: JSON.stringify({ userMessageId: 'msg-1', assistantMessageId: 'msg-2' }),
      },
      { event: 'token', data: JSON.stringify({ content: 'A' }) },
      { event: 'token', data: JSON.stringify({ content: 'B' }) },
      { event: 'done', data: JSON.stringify({}) },
    ]);
    mockFetch.mockResolvedValueOnce(mockResponse);

    const tokens: string[] = [];
    const { useChatStream } = await import('./chat');
    const { result } = renderHook(() => useChatStream(), { wrapper: createWrapper() });

    await result.current.startStream(
      {
        conversationId: 'conv-123',
        model: 'openai/gpt-4-turbo',
      },
      { onToken: (token: string) => tokens.push(token) }
    );

    expect(tokens).toEqual(['A', 'B']);
  });

  it('handles SSE events split across multiple chunks', async () => {
    // Simulate events arriving in separate chunks (the real-world scenario)
    const chunks = [
      'event: start\n',
      'data: {"userMessageId":"msg-1","assistantMessageId":"msg-2"}\n\n',
      'event: token\n',
      'data: {"content":"H"}\n\n',
      'event: token\n',
      'data: {"content":"i"}\n\n',
      'event: done\n',
      'data: {}\n\n',
    ];

    let chunkIndex = 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      pull(controller): void {
        if (chunkIndex < chunks.length) {
          controller.enqueue(encoder.encode(chunks[chunkIndex]));
          chunkIndex++;
        } else {
          controller.close();
        }
      },
    });

    mockFetch.mockResolvedValueOnce(
      new Response(stream, {
        status: 200,
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      })
    );

    const tokens: string[] = [];
    const { useChatStream } = await import('./chat');
    const { result } = renderHook(() => useChatStream(), { wrapper: createWrapper() });

    const streamResult = await result.current.startStream(
      {
        conversationId: 'conv-123',
        model: 'openai/gpt-4-turbo',
      },
      { onToken: (token: string) => tokens.push(token) }
    );

    // Should receive all tokens despite being split across chunks
    expect(tokens).toEqual(['H', 'i']);
    expect(streamResult.content).toBe('Hi');
    expect(streamResult.userMessageId).toBe('msg-1');
    expect(streamResult.assistantMessageId).toBe('msg-2');
  });

  it('completes when done event is received even if connection stays open', async () => {
    // This simulates the real-world scenario where Hono's streamSSE with Wrangler
    // may not close the HTTP connection after the stream callback completes.
    // The frontend should exit when it receives the 'done' event.
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller): void {
        // Send events
        controller.enqueue(
          encoder.encode(
            'event: start\ndata: {"userMessageId":"msg-1","assistantMessageId":"msg-2"}\n\n'
          )
        );
        controller.enqueue(encoder.encode('event: token\ndata: {"content":"Hello"}\n\n'));
        controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
        // NOTE: We intentionally do NOT call controller.close() to simulate
        // a connection that stays open after done event
      },
    });

    const mockResponse = new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
    mockFetch.mockResolvedValueOnce(mockResponse);

    const { useChatStream } = await import('./chat');
    const { result } = renderHook(() => useChatStream(), { wrapper: createWrapper() });

    // This should complete when 'done' event is received, not hang waiting for connection close
    const streamResult = await result.current.startStream({
      conversationId: 'conv-123',
      model: 'openai/gpt-4-turbo',
    });

    expect(streamResult.content).toBe('Hello');
    expect(streamResult.userMessageId).toBe('msg-1');
    expect(streamResult.assistantMessageId).toBe('msg-2');
  });
});

describe('useUpdateConversation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it('calls PATCH /conversations/:id with title', async () => {
    const mockResponse = {
      conversation: {
        id: 'conv-1',
        userId: 'user-1',
        title: 'Updated Title',
        createdAt: '2024-01-01',
        updatedAt: '2024-01-02',
      },
    };
    mockApi.patch.mockResolvedValueOnce(mockResponse);

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: 'Updated Title' },
    });

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true);
    });

    expect(mockApi.patch).toHaveBeenCalledWith('/conversations/conv-1', { title: 'Updated Title' });
    expect(result.current.data?.conversation.title).toBe('Updated Title');
  });

  it('handles 404 error for non-existent conversation', async () => {
    mockApi.patch.mockRejectedValueOnce(new Error('Conversation not found'));

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'invalid-id',
      data: { title: 'New Title' },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Conversation not found');
  });

  it('handles validation error for empty title', async () => {
    mockApi.patch.mockRejectedValueOnce(new Error('Title is required'));

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: '' },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Title is required');
  });

  it('handles validation error for title exceeding max length', async () => {
    mockApi.patch.mockRejectedValueOnce(new Error('Title too long'));

    const { result } = renderHook(() => useUpdateConversation(), { wrapper: createWrapper() });

    const longTitle = 'a'.repeat(256);
    result.current.mutate({
      conversationId: 'conv-1',
      data: { title: longTitle },
    });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });

    expect(result.current.error?.message).toBe('Title too long');
  });
});
