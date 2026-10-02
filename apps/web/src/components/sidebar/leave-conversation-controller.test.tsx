import * as React from 'react';
import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, renderHook, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { TouchDeviceOverrideContext } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { useUIStore } from '@/stores/ui/ui';
import { SidebarLinkMock } from '@/test-utils/sidebar-router-mock';
import { ChatList } from './chat-list';
import { LeaveConversationProvider, useRequestLeave } from './leave-conversation-controller';
import type { ReactElement, ReactNode } from 'react';
import type { SidebarConversation } from './chat-item';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  Link: SidebarLinkMock,
  useNavigate: () => mockNavigate,
}));

vi.mock('@hushbox/crypto', () => ({
  encryptTextForEpoch: vi.fn(() => new Uint8Array([1, 2, 3, 4])),
  getPublicKeyFromPrivate: vi.fn(() => new Uint8Array([10, 20, 30])),
}));

const MOCK_EPOCH_KEY = new Uint8Array([99, 88, 77]);
const mockProcessKeyChain = vi.fn();
vi.mock('@/lib/crypto/epoch-key-cache', () => ({
  getEpochKey: vi.fn(() => MOCK_EPOCH_KEY),
  getCurrentEpoch: vi.fn(() => 2),
  processKeyChain: (...args: unknown[]) => {
    mockProcessKeyChain(...args);
  },
}));

vi.mock('@/hooks/chat/chat', () => ({
  useDeleteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  useUpdateConversation: () => ({ mutate: vi.fn(), isPending: false }),
  DECRYPTING_TITLE: 'Decrypting...',
}));

const mockLeaveMutateAsync = vi.fn(() => Promise.resolve());
vi.mock('@/hooks/realtime/use-conversation-members', () => ({
  useLeaveConversation: () => ({ mutateAsync: mockLeaveMutateAsync, isPending: false }),
  useMuteConversation: () => ({ mutate: vi.fn(), isPending: false }),
  usePinConversation: () => ({ mutate: vi.fn(), isPending: false }),
}));

const mockExecuteWithRotation = vi.fn<(...args: unknown[]) => Promise<void>>(() =>
  Promise.resolve()
);
vi.mock('@/lib/crypto/rotation', () => ({
  executeWithRotation: (...args: unknown[]) => mockExecuteWithRotation(...args),
}));

const nonOwnerConversation: SidebarConversation = {
  id: 'conv-123',
  title: 'Group Chat',
  currentEpoch: 2,
  updatedAt: new Date().toISOString(),
  privilege: 'write',
  muted: false,
  pinned: false,
  memberCount: 1,
};

function Harness({
  conversations,
  touch = true,
}: Readonly<{ conversations: SidebarConversation[]; touch?: boolean }>): React.JSX.Element {
  return (
    <TouchDeviceOverrideContext value={touch}>
      <LeaveConversationProvider>
        <ChatList conversations={conversations} />
      </LeaveConversationProvider>
    </TouchDeviceOverrideContext>
  );
}

const originalMatchMedia = globalThis.matchMedia;

/** Narrows the window below 768px, where the overlay presents as a bottom sheet. */
function stubPhoneWidth(): void {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: (query: string): MediaQueryList => {
      const list: Pick<
        MediaQueryList,
        'matches' | 'media' | 'addEventListener' | 'removeEventListener'
      > = {
        matches: query === '(max-width: 767px)',
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      };
      // The band and pointer hooks read only `matches` and the change-listener pair.
      return list as MediaQueryList;
    },
  });
}

function render(ui: ReactElement): ReturnType<typeof rtlRender> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  Wrapper.displayName = 'TestWrapper';
  return rtlRender(ui, { wrapper: Wrapper });
}

describe('LeaveConversationProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, 'matchMedia', { writable: true, value: originalMatchMedia });
  });

  it('keeps the confirmation modal mounted when the row that opened it is removed', async () => {
    // The bug: in the bottom sheet (below 768px), confirming a leave drops the conversation
    // from the sidebar list, which unmounts the ChatItem. If that row owned the
    // modal, the modal unmounts mid-close and vaul leaves its portal stuck. The
    // modal must be owned by this stable provider, so removing the row leaves it
    // in the DOM to close cleanly.
    stubPhoneWidth();
    const user = userEvent.setup();
    const { rerender } = render(<Harness conversations={[nonOwnerConversation]} />);

    await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
    screen.getByRole('menuitem', { name: 'Leave' }).focus();
    await user.keyboard('{Enter}');
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
    });
    // The row's menu is itself a sheet, which this DOM never finishes animating out.
    const openOverlay = screen
      .getAllByTestId(TEST_IDS.overlayContent)
      .find((overlay) => overlay.dataset['state'] === 'open');
    expect(openOverlay).toHaveAttribute('data-overlay-variant', 'bottom-sheet');

    // Simulate the post-leave list invalidation dropping the row.
    rerender(<Harness conversations={[]} />);

    expect(screen.queryByText('Group Chat')).not.toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
  });

  it('runs the leave flow and closes the modal on confirm', async () => {
    // The test window's default width gives the Radix dialog, whose close reliably unmounts
    // the portal here; the bottom sheet's stuck-portal case is the iphone-15 e2e oracle.
    const user = userEvent.setup();
    render(<Harness conversations={[nonOwnerConversation]} touch={false} />);

    await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
    await user.click(screen.getByText('Leave'));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
    });

    await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationConfirm));

    await waitFor(() => {
      expect(mockLeaveMutateAsync).toHaveBeenCalledWith({ conversationId: 'conv-123' });
    });
    await waitFor(() => {
      expect(screen.queryByTestId(TEST_IDS.leaveConfirmationModal)).not.toBeInTheDocument();
    });
  });

  it('builds no rotation and caches no key when leaving', async () => {
    const user = userEvent.setup();
    render(<Harness conversations={[nonOwnerConversation]} touch={false} />);

    await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
    await user.click(screen.getByText('Leave'));
    await waitFor(() => {
      expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
    });
    await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationConfirm));

    await waitFor(() => {
      expect(mockLeaveMutateAsync).toHaveBeenCalledOnce();
    });
    expect(mockExecuteWithRotation).not.toHaveBeenCalled();
    expect(mockProcessKeyChain).not.toHaveBeenCalled();
  });

  it('throws when requestLeave is used without a provider', () => {
    const { result } = renderHook(() => useRequestLeave());
    expect(() => {
      result.current(nonOwnerConversation, false);
    }).toThrow(/LeaveConversationProvider/);
  });
});
