import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock TanStack Router
const redirectError = new Error('REDIRECT');
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(
    () => (config: { beforeLoad?: () => Promise<void>; component?: unknown }) => config
  ),
  redirect: vi.fn(() => {
    throw redirectError;
  }),
}));

// Mock auth
const mockRequireAuth = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

// Mock error boundary
vi.mock('@/components/shared/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// Mock authenticated chat page
vi.mock('@/components/chat/authenticated-chat-page', () => ({
  AuthenticatedChatPage: () => <div data-testid="authenticated-chat">chat page</div>,
}));

// Mock query options
const mockConversationOptions = {
  queryKey: ['chat', 'conversations', 'test-id'],
  queryFn: vi.fn(),
};
const mockKeyChainOptions = {
  queryKey: ['keys', 'test-id'],
  queryFn: vi.fn(),
  staleTime: 3_600_000,
};
vi.mock('@/hooks/chat', () => ({
  conversationQueryOptions: vi.fn(() => mockConversationOptions),
}));
vi.mock('@/hooks/keys', () => ({
  keyChainQueryOptions: vi.fn(() => mockKeyChainOptions),
}));

describe('chat.$id route beforeLoad', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls requireAuth in beforeLoad', async () => {
    mockRequireAuth.mockResolvedValue({
      user: {
        id: 'user-1',
        email: 'test@example.com',
        username: 'test_user',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: false,
      },
    });

    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as {
      beforeLoad?: () => Promise<void>;
    };

    expect(routeConfig.beforeLoad).toBeDefined();
    await routeConfig.beforeLoad!();
    expect(mockRequireAuth).toHaveBeenCalledTimes(1);
  });

  it('redirects to login when auth fails', async () => {
    mockRequireAuth.mockRejectedValue(redirectError);

    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as {
      beforeLoad?: () => Promise<void>;
    };

    await expect(routeConfig.beforeLoad!()).rejects.toThrow('REDIRECT');
  });
});

describe('chat.$id route loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefetches conversation and key chain data', async () => {
    mockRequireAuth.mockResolvedValue({ user: { id: 'user-1' } });

    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as {
      loader?: (args: {
        params: { id: string };
        context: { queryClient: { prefetchQuery: ReturnType<typeof vi.fn> } };
      }) => void;
    };

    expect(routeConfig.loader).toBeDefined();

    const mockPrefetchQuery = vi.fn();
    routeConfig.loader!({
      params: { id: 'conv-123' },
      context: { queryClient: { prefetchQuery: mockPrefetchQuery } },
    });

    expect(mockPrefetchQuery).toHaveBeenCalledTimes(2);
    expect(mockPrefetchQuery).toHaveBeenCalledWith(mockConversationOptions);
    expect(mockPrefetchQuery).toHaveBeenCalledWith(mockKeyChainOptions);
  });
});
