import { describe, it, expect, vi, beforeEach, afterEach, onTestFinished } from 'vitest';
import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import userEvent from '@testing-library/user-event';
import { TEST_IDS, TEST_ID_BUILDERS, ROUTES, friendlyErrorMessage } from '@hushbox/shared';
import { encryptTextForEpoch } from '@hushbox/crypto';
import { ApiError } from '@/lib/api/api';
import { getEpochKey, getEpochVerdict } from '@/lib/crypto/epoch-key-cache';
import { CONVERSATION_TITLE_MAX_LENGTH } from '@/lib/chat/conversation-title';
import { useUIStore } from '@/stores/ui/ui';
import { routerPathnameMock, SidebarLinkMock } from '@/test-utils/sidebar-router-mock';
import { ChatItem, type SidebarConversation } from './chat-item';
import { LeaveConversationProvider } from './leave-conversation-controller';
import type { ReactElement, ReactNode } from 'react';
import type { EpochVerdict } from '@/lib/crypto/epoch-key-cache';

function render(ui: ReactElement): ReturnType<typeof rtlRender> {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    // The leave-confirmation modal and its flow live in this provider (a stable
    // ancestor of the row); wrap so Leave interactions resolve against it.
    return (
      <QueryClientProvider client={queryClient}>
        <LeaveConversationProvider>{children}</LeaveConversationProvider>
      </QueryClientProvider>
    );
  }
  Wrapper.displayName = 'TestWrapper';
  return rtlRender(ui, { wrapper: Wrapper });
}

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  Link: SidebarLinkMock,
  useNavigate: () => mockNavigate,
}));

const MOCK_ENCRYPTED_BYTES = new Uint8Array([1, 2, 3, 4]);
vi.mock('@hushbox/crypto', () => ({
  encryptTextForEpoch: vi.fn(() => MOCK_ENCRYPTED_BYTES),
  getPublicKeyFromPrivate: vi.fn(() => new Uint8Array([10, 20, 30])),
}));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    toBase64: vi.fn(() => 'bW9jay1lbmNyeXB0ZWQ'),
  };
});

const MOCK_EPOCH_KEY = new Uint8Array([99, 88, 77]);
const VERIFIED_VERDICT: EpochVerdict = {
  currentEpoch: 2,
  rotationPending: false,
  rotation: 'ok',
  lastGoodEpoch: 2,
  badEpochs: new Set<number>(),
};
vi.mock('@/lib/crypto/epoch-key-cache', () => ({
  getEpochKey: vi.fn(() => MOCK_EPOCH_KEY),
  getEpochVerdict: vi.fn((): EpochVerdict | undefined => VERIFIED_VERDICT),
  getCurrentEpoch: vi.fn(() => 2),
  processKeyChain: vi.fn(),
}));

const mockDeleteMutateAsync = vi.fn<(conversationId: string) => Promise<unknown>>(() =>
  Promise.resolve({})
);
const mockUpdateMutateAsync = vi.fn<(variables: unknown) => Promise<unknown>>(() =>
  Promise.resolve({})
);

vi.mock('@/hooks/chat/chat', () => ({
  useDeleteConversation: () => ({
    mutateAsync: mockDeleteMutateAsync,
    isPending: false,
  }),
  useUpdateConversation: () => ({
    mutateAsync: mockUpdateMutateAsync,
    isPending: false,
  }),
  DECRYPTING_TITLE: 'Decrypting...',
}));

const mockLeaveMutateAsync = vi.fn(() => Promise.resolve());
const mockMuteMutate = vi.fn();
const mockPinMutate = vi.fn();
vi.mock('@/hooks/realtime/use-conversation-members', () => ({
  useLeaveConversation: () => ({
    mutateAsync: mockLeaveMutateAsync,
    isPending: false,
  }),
  useMuteConversation: () => ({
    mutate: mockMuteMutate,
    isPending: false,
  }),
  usePinConversation: () => ({
    mutate: mockPinMutate,
    isPending: false,
  }),
}));

const mockExecuteWithRotation = vi.fn<(...args: unknown[]) => Promise<void>>(() =>
  Promise.resolve()
);
vi.mock('@/lib/crypto/rotation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/crypto/rotation')>()),
  executeWithRotation: (...args: unknown[]) => mockExecuteWithRotation(...args),
}));

const originalMatchMedia = globalThis.matchMedia;

/** Narrows the window below 768px, where the menu presents as a bottom sheet. */
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

describe('ChatItem', () => {
  const mockConversation: SidebarConversation = {
    id: 'conv-123',
    title: 'Test Conversation',
    currentEpoch: 2,
    updatedAt: new Date().toISOString(),
    privilege: 'owner',
    muted: false,
    pinned: false,
    memberCount: 1,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockDeleteMutateAsync.mockClear();
    mockUpdateMutateAsync.mockClear();
    mockLeaveMutateAsync.mockClear();
    mockExecuteWithRotation.mockClear();
    mockNavigate.mockClear();
    routerPathnameMock.mockReturnValue('/');
    vi.mocked(getEpochVerdict).mockReturnValue(VERIFIED_VERDICT);
    mockMuteMutate.mockClear();
    mockPinMutate.mockClear();
    useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: false });
  });

  describe('expanded state', () => {
    it('renders conversation title', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByText('Test Conversation')).toBeInTheDocument();
    });

    it('links to conversation page', () => {
      render(<ChatItem conversation={mockConversation} />);
      const link = screen.getByTestId(TEST_IDS.chatLink);
      expect(link).toHaveAttribute('href', '/chat/conv-123');
    });

    it('truncates long titles', () => {
      const longTitle = {
        ...mockConversation,
        title: 'This is a very long conversation title that should be truncated',
      };
      render(<ChatItem conversation={longTitle} />);
      const title = screen.getByText(longTitle.title);
      expect(title).toHaveClass('truncate');
    });

    it('renders lock icon with muted style when title is Decrypting...', () => {
      const decryptingConversation = { ...mockConversation, title: 'Decrypting...' };
      render(<ChatItem conversation={decryptingConversation} />);
      expect(screen.getByTestId(TEST_IDS.decryptingTitle)).toBeInTheDocument();
      expect(screen.getByText('Decrypting...')).toHaveClass('text-muted-foreground');
    });

    it('hides message icon when expanded', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.queryByTestId(TEST_IDS.messageIcon)).not.toBeInTheDocument();
    });

    it('marks the row as the current page when the router is at its conversation route', () => {
      routerPathnameMock.mockReturnValue(`/chat/${mockConversation.id}`);
      render(<ChatItem conversation={mockConversation} isActive />);
      expect(
        screen.getByRole('link', { name: mockConversation.title, current: 'page' })
      ).toBeInTheDocument();
    });

    it('leaves an active-styled row unmarked when the router is at another route', () => {
      routerPathnameMock.mockReturnValue('/chat/conv-elsewhere');
      render(<ChatItem conversation={mockConversation} isActive />);
      const link = screen.getByRole('link', { name: mockConversation.title });
      expect(link.parentElement).toHaveClass('bg-background-subtle');
      expect(link).not.toHaveAttribute('aria-current');
    });

    it('carries the conversation row test id on the row', () => {
      render(<ChatItem conversation={mockConversation} />);
      const row = screen.getByTestId(TEST_ID_BUILDERS.conversationRow(mockConversation.id));
      expect(row).toContainElement(screen.getByRole('link', { name: mockConversation.title }));
    });
  });

  describe('the open conversation', () => {
    it('fills the open row with the subtle background', () => {
      render(<ChatItem conversation={mockConversation} isActive />);
      expect(screen.getByTestId(TEST_ID_BUILDERS.conversationRow('conv-123'))).toHaveClass(
        'bg-background-subtle'
      );
    });

    it('draws the red dot on the open row', () => {
      render(<ChatItem conversation={mockConversation} isActive />);
      expect(screen.getByTestId(TEST_ID_BUILDERS.conversationRow('conv-123'))).toHaveClass(
        'before:bg-brand-red'
      );
    });

    it('sets the open row title in the heavier weight', () => {
      render(<ChatItem conversation={mockConversation} isActive />);
      expect(screen.getByTestId(TEST_ID_BUILDERS.conversationRow('conv-123'))).toHaveClass(
        'font-semibold'
      );
    });

    it('draws no dot on a row that is not open', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByTestId(TEST_ID_BUILDERS.conversationRow('conv-123'))).not.toHaveClass(
        'before:bg-brand-red'
      );
    });

    it('keeps the open row fill while hovered', () => {
      render(<ChatItem conversation={mockConversation} isActive />);
      expect(screen.getByTestId(TEST_ID_BUILDERS.conversationRow('conv-123'))).not.toHaveClass(
        'hover:bg-accent'
      );
    });

    it('fills a row that is not open on hover', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByTestId(TEST_ID_BUILDERS.conversationRow('conv-123'))).toHaveClass(
        'hover:bg-accent'
      );
    });
  });

  describe('group conversations', () => {
    it('shows the users icon for a group conversation', () => {
      render(<ChatItem conversation={mockConversation} isGroup />);
      const link = screen.getByRole('link', { name: mockConversation.title });
      expect(link.querySelector('svg.lucide-users')).toBeInTheDocument();
    });

    it('shows no users icon for a conversation that is not a group', () => {
      render(<ChatItem conversation={mockConversation} />);
      const link = screen.getByRole('link', { name: mockConversation.title });
      expect(link.querySelector('svg.lucide-users')).not.toBeInTheDocument();
    });
  });

  describe('the menu trigger', () => {
    function trigger(): HTMLElement {
      return screen.getByTestId(TEST_IDS.chatItemMoreButton);
    }

    it('names the trigger for its conversation', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByRole('button', { name: 'More for Test Conversation' })).toBe(trigger());
    });

    it('draws the trigger as a horizontal ellipsis', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(trigger().querySelector('svg.lucide-ellipsis')).toBeInTheDocument();
    });

    it('hides the trigger at rest on a fine pointer', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(trigger()).toHaveClass('opacity-0');
    });

    it('shows the trigger while the row is hovered', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(trigger()).toHaveClass('group-hover/row:opacity-100');
    });

    it('shows the trigger while keyboard focus is inside the row', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(trigger()).toHaveClass('group-has-focus-visible/row:opacity-100');
    });

    it('shows the trigger while its menu is open', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(trigger()).toHaveClass('data-[state=open]:opacity-100');
    });

    it('marks the trigger open while its menu is open', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);
      await user.click(trigger());
      expect(trigger()).toHaveAttribute('data-state', 'open');
    });

    it('always shows the trigger on a coarse pointer', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(trigger()).toHaveClass('pointer-coarse:opacity-100');
    });

    it('keeps the hidden trigger in the tab order', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(trigger()).not.toHaveAttribute('tabindex', '-1');
      expect(trigger()).not.toHaveClass('invisible');
    });
  });

  describe('the menu items', () => {
    it('lists Pin, Mute, Rename and Delete for the owner', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);
      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      const names = screen.getAllByRole('menuitem').map((item) => item.textContent);
      expect(names).toEqual(['Pin', 'Mute', 'Rename', 'Delete']);
    });

    it('lists Unpin, Unmute and Leave for a pinned, muted member', async () => {
      const user = userEvent.setup();
      render(
        <ChatItem
          conversation={{ ...mockConversation, privilege: 'write', pinned: true, muted: true }}
        />
      );
      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      const names = screen.getAllByRole('menuitem').map((item) => item.textContent);
      expect(names).toEqual(['Unpin', 'Unmute', 'Leave']);
    });

    it('draws Delete in the danger tone', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);
      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveClass('text-destructive');
    });

    it('draws Leave in the danger tone', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={{ ...mockConversation, privilege: 'read' }} />);
      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      expect(screen.getByRole('menuitem', { name: 'Leave' })).toHaveClass('text-destructive');
    });

    it('draws Pin in the default tone', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);
      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      expect(screen.getByRole('menuitem', { name: 'Pin' })).not.toHaveClass('text-destructive');
    });
  });

  describe('the menu below 768px', () => {
    afterEach(() => {
      Object.defineProperty(globalThis, 'matchMedia', {
        writable: true,
        value: originalMatchMedia,
      });
    });

    /**
     * vaul unmounts a sheet on `animationend`, which this DOM never fires; with the animation
     * stopped the menu's sheet leaves the page as it closes, as it does in a browser.
     */
    function stopSheetAnimations(): void {
      const style = document.createElement('style');
      style.textContent =
        '[data-vaul-drawer], [data-vaul-overlay] { animation-name: none !important; }';
      document.head.append(style);
      onTestFinished(() => {
        style.remove();
      });
    }

    /** Chooses an item by key: a pointer release inside a sheet reads a transform this DOM lacks. */
    async function chooseFromSheet(
      user: ReturnType<typeof userEvent.setup>,
      item: string
    ): Promise<void> {
      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      const menuItem = await screen.findByRole('menuitem', { name: item });
      menuItem.focus();
      await user.keyboard('{Enter}');
      await waitFor(() => {
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
      });
    }

    async function cancelWith(
      user: ReturnType<typeof userEvent.setup>,
      testId: string
    ): Promise<void> {
      const cancel = await screen.findByTestId(testId);
      cancel.focus();
      await user.keyboard('{Enter}');
    }

    it.each([
      { item: 'Rename', cancel: TEST_IDS.cancelRenameButton, privilege: 'owner' },
      { item: 'Delete', cancel: TEST_IDS.cancelDeleteButton, privilege: 'owner' },
      { item: 'Leave', cancel: TEST_IDS.leaveConfirmationCancel, privilege: 'write' },
    ] as const)(
      'returns focus to the trigger when the $item dialog opened from the sheet closes',
      async ({ item, cancel, privilege }) => {
        stubPhoneWidth();
        stopSheetAnimations();
        const user = userEvent.setup();
        render(
          <>
            <ChatItem conversation={{ ...mockConversation, privilege }} />
            <main aria-label="Chat" />
          </>
        );

        await chooseFromSheet(user, item);
        await cancelWith(user, cancel);

        await waitFor(() => {
          expect(screen.getByTestId(TEST_IDS.chatItemMoreButton)).toHaveFocus();
        });
      }
    );

    it('opens the menu as a sheet that keeps the menu roles', async () => {
      stubPhoneWidth();
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);
      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      const sheet = await screen.findByRole('dialog', { name: 'Test Conversation' });
      expect(within(sheet).getByRole('menu')).toBeInTheDocument();
      expect(within(sheet).getAllByRole('menuitem')).toHaveLength(4);
    });

    it('opens the rename dialog from the sheet', async () => {
      stubPhoneWidth();
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);
      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      // Chosen by key: a pointer release inside the sheet reads a computed transform this DOM lacks.
      const rename = await screen.findByRole('menuitem', { name: 'Rename' });
      rename.focus();
      await user.keyboard('{Enter}');
      expect(await screen.findByDisplayValue('Test Conversation')).toBeInTheDocument();
    });
  });

  describe('with the sidebar collapsed', () => {
    beforeEach(() => {
      useUIStore.setState({ sidebarOpen: false });
    });

    it('draws no per-conversation icon', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.queryByTestId(TEST_IDS.messageIcon)).not.toBeInTheDocument();
    });

    it('keeps the row in its one expanded form', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByRole('link', { name: 'Test Conversation' })).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.chatItemMoreButton)).toBeInTheDocument();
    });
  });

  describe('actions dropdown', () => {
    it('shows more options button when sidebar is expanded', () => {
      render(<ChatItem conversation={mockConversation} />);
      expect(screen.getByTestId(TEST_IDS.chatItemMoreButton)).toBeInTheDocument();
    });

    it('opens dropdown menu on more button click', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Rename')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it('prevents navigation when clicking more button', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      const moreButton = screen.getByTestId(TEST_IDS.chatItemMoreButton);
      await user.click(moreButton);

      expect(screen.getByText('Rename')).toBeInTheDocument();
    });
  });

  describe('delete action', () => {
    it('shows delete confirmation dialog when delete is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Delete'));

      expect(screen.getByText('Delete conversation?')).toBeInTheDocument();
      expect(screen.getByText(/This will permanently delete/)).toBeInTheDocument();
    });

    it('calls delete mutation when confirmed', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Delete'));
      await user.click(screen.getByTestId(TEST_IDS.confirmDeleteButton));

      expect(mockDeleteMutateAsync).toHaveBeenCalledWith('conv-123');
    });

    it('closes the dialog and navigates home after a successful delete', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Delete'));
      await user.click(screen.getByTestId(TEST_IDS.confirmDeleteButton));

      expect(mockNavigate).toHaveBeenCalledWith({ to: ROUTES.CHAT });
      await waitFor(() => {
        expect(screen.queryByText('Delete conversation?')).not.toBeInTheDocument();
      });
    });

    it('keeps the delete dialog open while the delete is pending', async () => {
      mockDeleteMutateAsync.mockReturnValue(new Promise<unknown>(() => undefined));
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Delete'));
      await user.click(screen.getByTestId(TEST_IDS.confirmDeleteButton));

      expect(screen.getByTestId(TEST_IDS.deleteConversationDialog)).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.confirmDeleteButton)).toBeDisabled();
    });

    it('keeps the delete dialog open and announces the failure when the delete fails', async () => {
      mockDeleteMutateAsync.mockRejectedValue(new TypeError('Failed to fetch'));
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Delete'));
      await user.click(screen.getByTestId(TEST_IDS.confirmDeleteButton));

      expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
      expect(screen.getByTestId(TEST_IDS.deleteConversationDialog)).toBeInTheDocument();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('closes dialog when cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Delete'));
      await user.click(screen.getByTestId(TEST_IDS.cancelDeleteButton));

      await waitFor(() => {
        expect(screen.queryByText('Delete conversation?')).not.toBeInTheDocument();
      });
      expect(mockDeleteMutateAsync).not.toHaveBeenCalled();
    });
  });

  describe('rename action', () => {
    it('shows rename dialog when rename is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));

      expect(screen.getByText('Rename conversation')).toBeInTheDocument();
      expect(screen.getByDisplayValue('Test Conversation')).toBeInTheDocument();
    });

    it('calls update mutation with encrypted title and titleEpochNumber when saved', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));

      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      expect(mockUpdateMutateAsync).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        data: { title: 'bW9jay1lbmNyeXB0ZWQ', titleEpochNumber: 2 },
      });
    });

    it('binds the renamed title to the conversation and its current epoch', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));

      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      expect(encryptTextForEpoch).toHaveBeenCalledWith(expect.anything(), 'New Title', {
        conversationId: 'conv-123',
        epochNumber: 2,
      });
    });

    it('closes the rename dialog after a successful update', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));
      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      await waitFor(() => {
        expect(screen.queryByText('Rename conversation')).not.toBeInTheDocument();
      });
    });

    it('keeps the rename dialog open while the rename is pending', async () => {
      mockUpdateMutateAsync.mockReturnValue(new Promise<unknown>(() => undefined));
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));
      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      expect(screen.getByTestId(TEST_IDS.renameConversationDialog)).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.saveRenameButton)).toBeDisabled();
    });

    it('keeps the rename dialog open and announces the failure when the rename fails', async () => {
      mockUpdateMutateAsync.mockRejectedValue(new TypeError('Failed to fetch'));
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));
      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      expect(await screen.findByRole('alert')).toHaveTextContent(/something went wrong/i);
      expect(screen.getByDisplayValue('New Title')).toBeInTheDocument();
    });

    it('explains a rename refused while the keys await a rotation', async () => {
      mockUpdateMutateAsync.mockRejectedValue(
        new ApiError('ROTATION_PENDING', 409, { code: 'ROTATION_PENDING' })
      );
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));
      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        friendlyErrorMessage('ROTATION_PENDING')
      );
    });

    it('refuses a rename while the keys failed verification', async () => {
      vi.mocked(getEpochVerdict).mockReturnValue({
        ...VERIFIED_VERDICT,
        rotation: 'bad',
        lastGoodEpoch: 1,
        badEpochs: new Set([2]),
      });
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));
      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        friendlyErrorMessage('EPOCH_KEYS_RESTORING')
      );
      expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    });

    it('renames under keys that verified', async () => {
      vi.mocked(getEpochVerdict).mockReturnValue(VERIFIED_VERDICT);
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));
      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      expect(mockUpdateMutateAsync).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        data: { title: 'bW9jay1lbmNyeXB0ZWQ', titleEpochNumber: 2 },
      });
    });

    it('renames a conversation whose keys have not been judged yet', async () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- getEpochVerdict returns undefined before a keychain is judged; that is the case under test
      vi.mocked(getEpochVerdict).mockReturnValue(undefined);
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));
      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      expect(mockUpdateMutateAsync).toHaveBeenCalled();
    });

    it('does not update when the epoch key is unavailable', async () => {
      // eslint-disable-next-line unicorn/no-useless-undefined -- getEpochKey returns undefined for a missing epoch key; that is the case under test
      vi.mocked(getEpochKey).mockReturnValueOnce(undefined);
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));
      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.type(input, 'New Title');
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    });

    it('closes dialog when cancel is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));
      await user.click(screen.getByTestId(TEST_IDS.cancelRenameButton));

      await waitFor(() => {
        expect(screen.queryByText('Rename conversation')).not.toBeInTheDocument();
      });
      expect(mockUpdateMutateAsync).not.toHaveBeenCalled();
    });

    it('truncates an over-long pasted title instead of sending it', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));

      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.paste('x'.repeat(CONVERSATION_TITLE_MAX_LENGTH * 3));
      await user.click(screen.getByTestId(TEST_IDS.saveRenameButton));

      expect(encryptTextForEpoch).toHaveBeenCalledWith(
        expect.anything(),
        'x'.repeat(CONVERSATION_TITLE_MAX_LENGTH),
        { conversationId: 'conv-123', epochNumber: 2 }
      );
    });

    it('shows the truncated title in the input', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));

      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);
      await user.paste('x'.repeat(CONVERSATION_TITLE_MAX_LENGTH * 3));

      expect(input).toHaveValue('x'.repeat(CONVERSATION_TITLE_MAX_LENGTH));
    });

    it('disables save button when title is empty', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Rename'));

      const input = screen.getByDisplayValue('Test Conversation');
      await user.clear(input);

      expect(screen.getByTestId(TEST_IDS.saveRenameButton)).toBeDisabled();
    });
  });

  describe('non-owner actions', () => {
    const nonOwnerConversation: SidebarConversation = {
      ...mockConversation,
      privilege: 'write',
    };

    it('shows Leave instead of Rename and Delete for non-owner', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Leave')).toBeInTheDocument();
      expect(screen.queryByText('Rename')).not.toBeInTheDocument();
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('shows Leave for read privilege', async () => {
      const user = userEvent.setup();
      render(
        <ChatItem
          conversation={{ ...mockConversation, privilege: 'read' } satisfies SidebarConversation}
        />
      );

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Leave')).toBeInTheDocument();
      expect(screen.queryByText('Rename')).not.toBeInTheDocument();
    });

    it('shows Leave for admin privilege', async () => {
      const user = userEvent.setup();
      render(
        <ChatItem
          conversation={{ ...mockConversation, privilege: 'admin' } satisfies SidebarConversation}
        />
      );

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Leave')).toBeInTheDocument();
      expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('opens leave confirmation modal when Leave is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Leave'));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
      });
    });

    it('sends a bare leave and builds no rotation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Leave'));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
      });
      await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationConfirm));

      await waitFor(() => {
        expect(mockLeaveMutateAsync).toHaveBeenCalledWith({ conversationId: 'conv-123' });
      });
      expect(mockExecuteWithRotation).not.toHaveBeenCalled();
    });

    it('does not call any leave path when cancelled', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Leave'));

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
      });
      await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationCancel));

      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.leaveConfirmationModal)).not.toBeInTheDocument();
      });
      expect(mockExecuteWithRotation).not.toHaveBeenCalled();
      expect(mockLeaveMutateAsync).not.toHaveBeenCalled();
    });

    it('navigates to /chat when leaving the active conversation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} isActive />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Leave'));
      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
      });
      await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationConfirm));

      await waitFor(() => {
        expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat' });
      });
    });

    it('does not navigate when leaving a non-active conversation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={nonOwnerConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Leave'));
      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.leaveConfirmationModal)).toBeInTheDocument();
      });
      await user.click(screen.getByTestId(TEST_IDS.leaveConfirmationConfirm));

      // Wait for the leave action to settle, then assert no navigation
      await waitFor(() => {
        expect(mockLeaveMutateAsync).toHaveBeenCalledOnce();
      });
      expect(mockExecuteWithRotation).not.toHaveBeenCalled();
      expect(mockNavigate).not.toHaveBeenCalled();
    });

    it('shows Rename and Delete for owner privilege', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Rename')).toBeInTheDocument();
      expect(screen.getByText('Delete')).toBeInTheDocument();
      expect(screen.queryByText('Leave')).not.toBeInTheDocument();
    });
  });

  describe('mute action', () => {
    it('shows Mute option for unmuted conversation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Mute')).toBeInTheDocument();
      expect(screen.queryByText('Unmute')).not.toBeInTheDocument();
    });

    it('shows Unmute option for muted conversation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={{ ...mockConversation, muted: true }} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Unmute')).toBeInTheDocument();
      expect(screen.queryByText('Mute')).not.toBeInTheDocument();
    });

    it('calls mute mutation when Mute is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Mute'));

      expect(mockMuteMutate).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        muted: true,
      });
    });

    it('calls unmute mutation when Unmute is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={{ ...mockConversation, muted: true }} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Unmute'));

      expect(mockMuteMutate).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        muted: false,
      });
    });

    it('shows Mute option for non-owner members', async () => {
      const user = userEvent.setup();
      render(
        <ChatItem
          conversation={{ ...mockConversation, privilege: 'write' } satisfies SidebarConversation}
        />
      );

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Mute')).toBeInTheDocument();
    });
  });

  describe('pin action', () => {
    it('shows Pin option for unpinned conversation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Pin')).toBeInTheDocument();
      expect(screen.queryByText('Unpin')).not.toBeInTheDocument();
    });

    it('shows Unpin option for pinned conversation', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={{ ...mockConversation, pinned: true }} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Unpin')).toBeInTheDocument();
      expect(screen.queryByText('Pin')).not.toBeInTheDocument();
    });

    it('calls pin mutation when Pin is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={mockConversation} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Pin'));

      expect(mockPinMutate).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        pinned: true,
      });
    });

    it('calls unpin mutation when Unpin is clicked', async () => {
      const user = userEvent.setup();
      render(<ChatItem conversation={{ ...mockConversation, pinned: true }} />);

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));
      await user.click(screen.getByText('Unpin'));

      expect(mockPinMutate).toHaveBeenCalledWith({
        conversationId: 'conv-123',
        pinned: false,
      });
    });

    it('shows Pin option for non-owner members', async () => {
      const user = userEvent.setup();
      render(
        <ChatItem
          conversation={{ ...mockConversation, privilege: 'write' } satisfies SidebarConversation}
        />
      );

      await user.click(screen.getByTestId(TEST_IDS.chatItemMoreButton));

      expect(screen.getByText('Pin')).toBeInTheDocument();
    });
  });
});
