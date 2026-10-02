import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router';
import * as React from 'react';
import { ROUTES, TEST_IDS, type ConversationListItem } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { useUIStore } from '@/stores/ui/ui';

vi.mock('@/hooks/chat/chat', () => ({
  useDecryptedConversations: vi.fn(),
  useDeleteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateConversation: () => ({ mutate: vi.fn(), isPending: false }),
  DECRYPTING_TITLE: 'Decrypting...',
  chatKeys: {
    all: ['chat'] as const,
    conversations: () => ['chat', 'conversations'] as const,
    conversation: (id: string) => ['chat', 'conversations', id] as const,
    messages: (conversationId: string) =>
      ['chat', 'conversations', conversationId, 'messages'] as const,
  },
}));

vi.mock('@/hooks/realtime/use-conversation-members', () => ({
  useAcceptMembership: () => ({ mutate: vi.fn(), isPending: false }),
  useLeaveConversation: () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(() => Promise.resolve()),
    isPending: false,
  }),
  useDeclineInvitation: () => ({ mutateAsync: vi.fn(() => Promise.resolve()), isPending: false }),
  useMuteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  usePinConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/lib/auth/auth', () => ({
  useSession: () => ({
    data: {
      user: { id: 'user-1', email: 'test@example.com', username: 'test_user' },
      session: { id: 'session-1' },
    },
    isPending: false,
  }),
  useAuthStore: <T,>(selector: (s: { user: { id: string } | null }) => T): T =>
    selector({ user: { id: 'user-1' } }),
  signOutAndClearCache: vi.fn(),
}));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: () => ({ displayBalance: '10000000000', isStable: true }),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => ({ isAuthStable: true, isBalanceStable: true, isAppStable: true }),
}));

vi.mock('@/hooks/notifications/use-enable-prompt', () => ({
  useEnablePrompt: () => ({
    isVisible: false,
    isEnabling: false,
    enable: vi.fn(),
    dismiss: vi.fn(),
  }),
}));

vi.mock('@hushbox/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/ui')>();
  return { ...actual, useIsMobile: () => false };
});

import { useDecryptedConversations } from '@/hooks/chat/chat';
import { Sidebar } from './sidebar';

const mockUseDecryptedConversations = vi.mocked(useDecryptedConversations);

const baseConversation: ConversationListItem = {
  id: 'conv-1',
  title: 'First Chat',
  currentEpoch: 1,
  titleEpochNumber: 1,
  nextSequence: 1,
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

const conversations: ConversationListItem[] = [
  { ...baseConversation, id: 'conv-1', title: 'First Chat' },
  { ...baseConversation, id: 'conv-2', title: 'Second Chat' },
];

// The route tree mirrors the app's: a pathless layout that renders the sidebar
// on every route, with `/chat` and `/chat/$id` as siblings under it. The
// prefix-by-segment default of the router's active matching is what makes the
// nesting load-bearing here — a flat stub would not reproduce it.
function renderSidebarAt(pathname: string): ReturnType<typeof render> {
  const rootRoute = createRootRoute({ component: Outlet });
  const appRoute = createRoute({
    getParentRoute: () => rootRoute,
    id: 'app',
    component: function AppLayout(): React.JSX.Element {
      return (
        <>
          <Sidebar />
          <Outlet />
        </>
      );
    },
  });
  const indexRoute = createRoute({
    getParentRoute: () => appRoute,
    path: '/',
    component: () => <div>home</div>,
  });
  const chatRoute = createRoute({
    getParentRoute: () => appRoute,
    path: ROUTES.CHAT,
    component: () => <div>chat</div>,
  });
  const chatIdRoute = createRoute({
    getParentRoute: () => appRoute,
    path: ROUTES.CHAT_ID,
    component: () => <div>conversation</div>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([appRoute.addChildren([indexRoute, chatRoute, chatIdRoute])]),
    history: createMemoryHistory({ initialEntries: [pathname] }),
  });

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';

  return render(<RouterProvider router={router} />, { wrapper: Wrapper });
}

describe('Sidebar against the real router', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
    mockUseDecryptedConversations.mockReturnValue({
      data: conversations,
      isLoading: false,
      fetchNextPage: vi.fn(),
      hasNextPage: false,
      isFetchingNextPage: false,
    });
  });

  it('marks the active conversation row as the current page and nothing else', async () => {
    renderSidebarAt('/chat/conv-2');

    const sidebar = await screen.findByTestId(TEST_IDS.sidebar);
    const marked = within(sidebar)
      .getAllByRole('link')
      .filter((link) => link.getAttribute('aria-current') === 'page');

    expect(marked.map((link) => link.getAttribute('aria-label') ?? link.textContent)).toEqual([
      'Second Chat',
    ]);
  });

  it('marks the header link as the current page on the chat route itself', async () => {
    renderSidebarAt(ROUTES.CHAT);

    const sidebar = await screen.findByTestId(TEST_IDS.sidebar);

    expect(within(sidebar).getByRole('link', { name: 'HushBox - Go to chat' })).toHaveAttribute(
      'aria-current',
      'page'
    );
  });

  it('draws no conversation links while collapsed', async () => {
    useUIStore.setState({ sidebarOpen: false });

    renderSidebarAt('/chat/conv-2');
    const sidebar = await screen.findByTestId(TEST_IDS.sidebar);

    expect(within(sidebar).queryByRole('link', { name: 'Second Chat' })).not.toBeInTheDocument();
    expect(within(sidebar).queryByRole('link', { name: 'First Chat' })).not.toBeInTheDocument();
  });
});
