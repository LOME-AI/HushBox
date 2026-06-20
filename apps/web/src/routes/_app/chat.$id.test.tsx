import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './chat.$id';

const { mockRequireAuth, authenticatedChatPageMock, mountSpy } = vi.hoisted(() => ({
  mockRequireAuth: vi.fn(),
  authenticatedChatPageMock: vi.fn(),
  mountSpy: vi.fn(),
}));

// `Route.useParams`/`Route.useSearch` call the router's bundled internals (not
// the module's standalone hook exports), so importActual+override does not reach
// them — spy on the Route methods directly, as the other renderRoute tests do.
function setParams(params: { id: string }): void {
  vi.spyOn(Route, 'useParams').mockReturnValue(params);
}
function setSearch(search: { fork: string | undefined }): void {
  vi.spyOn(Route, 'useSearch').mockReturnValue(search);
}

vi.mock('@/lib/auth', () => ({
  requireAuth: (...args: unknown[]) => mockRequireAuth(...args),
}));

vi.mock('@/components/shared/error-boundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="error-boundary">{children}</div>
  ),
}));

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

vi.mock('@/components/chat/page/authenticated-chat-page', () => ({
  AuthenticatedChatPage: (props: {
    routeConversationId: string;
    initialForkId?: string | undefined;
  }) => {
    authenticatedChatPageMock(props);
    return (
      <MockAuthenticatedChatPage
        routeConversationId={props.routeConversationId}
        initialForkId={props.initialForkId}
      />
    );
  },
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

const redirectError = new Error('REDIRECT');

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

    const beforeLoad = Route.options.beforeLoad as (() => Promise<void>) | undefined;
    expect(beforeLoad).toBeDefined();
    await beforeLoad!();
    expect(mockRequireAuth).toHaveBeenCalledTimes(1);
  });

  it('redirects to login when auth fails', async () => {
    mockRequireAuth.mockRejectedValue(redirectError);

    const beforeLoad = Route.options.beforeLoad as (() => Promise<void>) | undefined;
    await expect(beforeLoad!()).rejects.toThrow('REDIRECT');
  });
});

describe('chat.$id route loader', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefetches conversation and key chain data', () => {
    const loader = Route.options.loader as
      | ((args: {
          params: { id: string };
          context: { queryClient: { prefetchQuery: ReturnType<typeof vi.fn> } };
        }) => void)
      | undefined;
    expect(loader).toBeDefined();

    const mockPrefetchQuery = vi.fn();
    loader!({
      params: { id: 'conv-123' },
      context: { queryClient: { prefetchQuery: mockPrefetchQuery } },
    });

    expect(mockPrefetchQuery).toHaveBeenCalledTimes(2);
    expect(mockPrefetchQuery).toHaveBeenCalledWith(mockConversationOptions);
    expect(mockPrefetchQuery).toHaveBeenCalledWith(mockKeyChainOptions);
  });

  it('does not prefetch when id is the "new" sentinel', () => {
    // The "new" segment in /chat/new is a create-mode marker, not a real
    // conversation id. Treating it as an id triggers GET /api/conversations/new
    // and GET /api/keys/new, both of which 404 and polluted production
    // observability with phantom errors on every welcome-page send.
    const loader = Route.options.loader as
      | ((args: {
          params: { id: string };
          context: { queryClient: { prefetchQuery: ReturnType<typeof vi.fn> } };
        }) => void)
      | undefined;

    const mockPrefetchQuery = vi.fn();
    loader!({
      params: { id: 'new' },
      context: { queryClient: { prefetchQuery: mockPrefetchQuery } },
    });

    expect(mockPrefetchQuery).not.toHaveBeenCalled();
  });
});

describe('chat.$id validateSearch', () => {
  function validateSearch(search: Record<string, unknown>): { fork: string | undefined } {
    return (
      Route.options.validateSearch as (s: Record<string, unknown>) => { fork: string | undefined }
    )(search);
  }

  it('extracts fork param when provided as a string', () => {
    expect(validateSearch({ fork: 'fork-123' })).toEqual({ fork: 'fork-123' });
  });

  it('returns undefined fork when not present', () => {
    expect(validateSearch({})).toEqual({ fork: undefined });
  });

  it('returns undefined when fork is not a string', () => {
    expect(validateSearch({ fork: 42 })).toEqual({ fork: undefined });
    expect(validateSearch({ fork: null })).toEqual({ fork: undefined });
    expect(validateSearch({ fork: ['x'] })).toEqual({ fork: undefined });
  });

  it('ignores unrelated search params', () => {
    expect(validateSearch({ fork: 'fork-x', extra: 'noise' })).toEqual({ fork: 'fork-x' });
  });
});

describe('chat.$id component', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mountSpy.mockClear();
    authenticatedChatPageMock.mockClear();
  });

  it('renders AuthenticatedChatPage inside an ErrorBoundary, forwarding params', () => {
    setParams({ id: 'conv-abc' });
    setSearch({ fork: 'fork-xyz' });

    renderRoute(Route);

    expect(screen.getByTestId('error-boundary')).toBeInTheDocument();
    const chat = screen.getByTestId('authenticated-chat');
    expect(chat).toHaveAttribute('data-conv-id', 'conv-abc');
    expect(chat).toHaveAttribute('data-fork-id', 'fork-xyz');
    expect(authenticatedChatPageMock).toHaveBeenCalledWith({
      routeConversationId: 'conv-abc',
      initialForkId: 'fork-xyz',
    });
  });

  it('forwards undefined fork to AuthenticatedChatPage', () => {
    setParams({ id: 'conv-abc' });
    setSearch({ fork: undefined });

    renderRoute(Route);

    expect(authenticatedChatPageMock).toHaveBeenCalledWith({
      routeConversationId: 'conv-abc',
      initialForkId: undefined,
    });
  });

  it('remounts the chat subtree when the conversation id changes', () => {
    // Keying by the conversation id forces a fresh mount on navigation between
    // conversations, so per-conversation hook state cannot bleed across.
    setSearch({ fork: undefined });
    const paramsSpy = vi.spyOn(Route, 'useParams').mockReturnValue({ id: 'conv-a' });

    const { rerender } = renderRoute(Route);
    expect(mountSpy).toHaveBeenCalledTimes(1);

    paramsSpy.mockReturnValue({ id: 'conv-b' });
    const Component = Route.options.component as React.ComponentType;
    rerender(<Component />);

    expect(mountSpy).toHaveBeenCalledTimes(2);
  });
});
