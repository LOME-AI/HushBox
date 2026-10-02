import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEST_ID_BUILDERS } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { routerPathnameMock, SidebarLinkMock } from '@/test-utils/sidebar-router-mock';
import { ConversationGroup } from './conversation-group';
import type { SidebarConversation } from './chat-item';
import type { ReactElement, ReactNode } from 'react';

function render(ui: ReactElement): ReturnType<typeof rtlRender> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return rtlRender(ui, { wrapper: Wrapper });
}

vi.mock('@tanstack/react-router', () => ({
  Link: SidebarLinkMock,
  useNavigate: () => vi.fn(),
}));

vi.mock('@/hooks/realtime/use-conversation-members', () => ({
  useMuteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  usePinConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/chat/chat', () => ({
  useDeleteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateConversation: () => ({ mutate: vi.fn(), isPending: false }),
  DECRYPTING_TITLE: 'Decrypting...',
}));

const conversations: SidebarConversation[] = [
  {
    id: 'conv-1',
    title: 'Lease renewal letter',
    currentEpoch: 1,
    updatedAt: isoAt(TEST_DAY_START),
    privilege: 'owner',
    muted: false,
    pinned: false,
    memberCount: 1,
  },
  {
    id: 'conv-2',
    title: 'Sourdough hydration math',
    currentEpoch: 1,
    updatedAt: isoAt(TEST_DAY_START),
    privilege: 'owner',
    muted: false,
    pinned: false,
    memberCount: 1,
  },
];

describe('ConversationGroup', () => {
  beforeEach(() => {
    routerPathnameMock.mockReturnValue('/');
  });

  it('carries the group test id built from its label', () => {
    render(<ConversationGroup label="Today" conversations={conversations} />);

    expect(screen.getByTestId(TEST_ID_BUILDERS.conversationGroup('Today'))).toBeInTheDocument();
  });

  it('titles the group with its label as a heading', () => {
    render(<ConversationGroup label="Previous 7 days" conversations={conversations} />);

    expect(screen.getByRole('heading', { name: 'Previous 7 days' })).toBeInTheDocument();
  });

  it('names its list by the group title', () => {
    render(<ConversationGroup label="Older" conversations={conversations} />);

    expect(screen.getByRole('list', { name: 'Older' })).toBeInTheDocument();
  });

  it('lists its conversations in the order given', () => {
    render(<ConversationGroup label="Today" conversations={conversations} />);

    const items = within(screen.getByRole('list', { name: 'Today' })).getAllByRole('listitem');
    expect(items.map((item) => item.textContent)).toEqual([
      'Lease renewal letter',
      'Sourdough hydration math',
    ]);
  });

  it('marks the conversation named by activeId as the current page', () => {
    routerPathnameMock.mockReturnValue('/chat/conv-2');
    render(<ConversationGroup label="Today" conversations={conversations} activeId="conv-2" />);

    expect(
      screen.getByRole('link', { name: 'Sourdough hydration math', current: 'page' })
    ).toBeInTheDocument();
  });

  it('sets the title in the chrome sans and muted ink, not the heading serif and red', () => {
    render(<ConversationGroup label="Today" conversations={conversations} />);

    const title = screen.getByRole('heading', { name: 'Today' });
    expect(title).toHaveClass('font-sans');
    expect(title).toHaveClass('text-muted-foreground');
  });

  it('carries the load-more sentinel when more conversations wait', () => {
    render(
      <ConversationGroup label="Older" conversations={conversations} hasMore onLoadMore={vi.fn()} />
    );

    const items = within(screen.getByRole('list', { name: 'Older' })).getAllByRole('listitem', {
      hidden: true,
    });
    expect(items).toHaveLength(conversations.length + 1);
  });
});
