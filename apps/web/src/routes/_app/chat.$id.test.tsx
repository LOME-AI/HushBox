import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Mock TanStack Router
const redirectError = new Error('REDIRECT');
const useParamsMock = vi.fn();
const useSearchMock = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  createFileRoute: vi.fn(() => (config: Record<string, unknown>) => {
    return {
      ...config,
      useParams: useParamsMock,
      useSearch: useSearchMock,
    };
  }),
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
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="error-boundary">{children}</div>
  ),
}));

// Mock authenticated chat page
const authenticatedChatPageMock = vi.fn(
  ({
    routeConversationId,
    initialForkId,
  }: {
    routeConversationId: string;
    initialForkId?: string | undefined;
  }) => (
    <div
      data-testid="authenticated-chat"
      data-conv-id={routeConversationId}
      data-fork-id={initialForkId ?? ''}
    >
      chat page
    </div>
  )
);

vi.mock('@/components/chat/authenticated-chat-page', () => ({
  AuthenticatedChatPage: (props: {
    routeConversationId: string;
    initialForkId?: string | undefined;
  }) => authenticatedChatPageMock(props),
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

interface RouteConfig {
  beforeLoad?: () => Promise<void>;
  loader?: (args: {
    params: { id: string };
    context: { queryClient: { prefetchQuery: ReturnType<typeof vi.fn> } };
  }) => void;
  component: () => React.JSX.Element;
  validateSearch: (search: Record<string, unknown>) => { fork: string | undefined };
}

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
    const routeConfig = Route as unknown as RouteConfig;

    expect(routeConfig.beforeLoad).toBeDefined();
    await routeConfig.beforeLoad!();
    expect(mockRequireAuth).toHaveBeenCalledTimes(1);
  });

  it('redirects to login when auth fails', async () => {
    mockRequireAuth.mockRejectedValue(redirectError);

    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as RouteConfig;

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
    const routeConfig = Route as unknown as RouteConfig;

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

describe('chat.$id validateSearch', () => {
  it('extracts fork param when provided as a string', async () => {
    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as RouteConfig;

    expect(routeConfig.validateSearch({ fork: 'fork-123' })).toEqual({
      fork: 'fork-123',
    });
  });

  it('returns undefined fork when not present', async () => {
    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as RouteConfig;

    expect(routeConfig.validateSearch({})).toEqual({ fork: undefined });
  });

  it('returns undefined when fork is not a string', async () => {
    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as RouteConfig;

    expect(routeConfig.validateSearch({ fork: 42 })).toEqual({ fork: undefined });
    expect(routeConfig.validateSearch({ fork: null })).toEqual({ fork: undefined });
    expect(routeConfig.validateSearch({ fork: ['x'] })).toEqual({ fork: undefined });
  });

  it('ignores unrelated search params', async () => {
    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as RouteConfig;

    expect(routeConfig.validateSearch({ fork: 'fork-x', extra: 'noise' })).toEqual({
      fork: 'fork-x',
    });
  });
});

describe('chat.$id component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders AuthenticatedChatPage inside an ErrorBoundary, forwarding params', async () => {
    useParamsMock.mockReturnValue({ id: 'conv-abc' });
    useSearchMock.mockReturnValue({ fork: 'fork-xyz' });

    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as RouteConfig;

    render(<routeConfig.component />);

    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();
    const chat = screen.getByTestId('authenticated-chat');
    expect(chat).toHaveAttribute('data-conv-id', 'conv-abc');
    expect(chat).toHaveAttribute('data-fork-id', 'fork-xyz');
    expect(authenticatedChatPageMock).toHaveBeenCalledWith({
      routeConversationId: 'conv-abc',
      initialForkId: 'fork-xyz',
    });
  });

  it('forwards undefined fork to AuthenticatedChatPage', async () => {
    useParamsMock.mockReturnValue({ id: 'conv-abc' });
    useSearchMock.mockReturnValue({ fork: undefined });

    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as RouteConfig;

    render(<routeConfig.component />);

    expect(authenticatedChatPageMock).toHaveBeenCalledWith({
      routeConversationId: 'conv-abc',
      initialForkId: undefined,
    });
  });
});
