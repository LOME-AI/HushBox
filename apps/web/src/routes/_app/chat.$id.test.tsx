import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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

const mockRequireAuth = vi.fn();
vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock('@/components/shared/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="error-boundary">{children}</div>
  ),
}));

const mountSpy = vi.fn();

function MockAuthenticatedChatPage({
  routeConversationId,
  initialForkId,
}: Readonly<{
  routeConversationId: string;
  initialForkId?: string | undefined;
}>): React.JSX.Element {
  React.useEffect(() => {
    mountSpy();
  }, []);
  return (
    <div
      data-testid="authenticated-chat"
      data-conv-id={routeConversationId}
      data-fork-id={initialForkId ?? ''}
    >
      chat page
    </div>
  );
}

const authenticatedChatPageMock = vi.fn(
  ({
    routeConversationId,
    initialForkId,
  }: {
    routeConversationId: string;
    initialForkId?: string | undefined;
  }) => (
    <MockAuthenticatedChatPage
      routeConversationId={routeConversationId}
      initialForkId={initialForkId}
    />
  )
);

vi.mock('@/components/chat/page/authenticated-chat-page', () => ({
  AuthenticatedChatPage: (props: {
    routeConversationId: string;
    initialForkId?: string | undefined;
  }) => authenticatedChatPageMock(props),
}));

const mockConversationOptions = {
  queryKey: ['chat', 'conversations', 'test-id'],
  queryFn: vi.fn(),
};
const mockKeyChainOptions = {
  queryKey: ['keys', 'test-id'],
  queryFn: vi.fn(),
  staleTime: 3_600_000,
};
vi.mock('@/hooks/chat/chat', () => ({
  conversationQueryOptions: vi.fn(() => mockConversationOptions),
}));
vi.mock('@/hooks/crypto/keys', () => ({
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

  it('does not prefetch when id is the "new" sentinel', async () => {
    // The "new" segment in /chat/new is a create-mode marker, not a real
    // conversation id. Treating it as an id triggers GET /api/conversations/new
    // and GET /api/keys/new, both of which 404 and polluted production
    // observability with phantom errors on every welcome-page send.
    mockRequireAuth.mockResolvedValue({ user: { id: 'user-1' } });

    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as RouteConfig;

    const mockPrefetchQuery = vi.fn();
    routeConfig.loader!({
      params: { id: 'new' },
      context: { queryClient: { prefetchQuery: mockPrefetchQuery } },
    });

    expect(mockPrefetchQuery).not.toHaveBeenCalled();
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

  it('remounts the chat subtree when the conversation id changes', async () => {
    // Keying by the conversation id forces a fresh mount on navigation between
    // conversations, so per-conversation hook state cannot bleed across.
    useSearchMock.mockReturnValue({ fork: undefined });
    useParamsMock.mockReturnValue({ id: 'conv-a' });

    const { Route } = await import('./chat.$id');
    const routeConfig = Route as unknown as RouteConfig;

    const { rerender } = render(<routeConfig.component />);
    expect(mountSpy).toHaveBeenCalledTimes(1);

    useParamsMock.mockReturnValue({ id: 'conv-b' });
    rerender(<routeConfig.component />);

    expect(mountSpy).toHaveBeenCalledTimes(2);
  });
});
