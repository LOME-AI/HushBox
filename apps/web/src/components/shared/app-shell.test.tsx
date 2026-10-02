import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderToStaticMarkup } from 'react-dom/server';
import { TEST_IDS } from '@hushbox/shared';
import { SkipLink } from '@hushbox/ui';
vi.mock('@/lib/api/api', () => ({
  getApiUrl: () => 'http://localhost:8787',
}));

import { useUIStore } from '@/stores/ui/ui';
import { useAuthStore } from '@/lib/auth/auth';
import { useUIModalsStore } from '@/stores/ui/modals';
import { useRightPane } from '@/stores/ui/right-pane';
import { useAccessibilityPanelStore } from '@/stores/ui/accessibility-panel';
import { useNotificationActivityStore } from '@/stores/activity/notification';
import { usePaletteStore } from '@/stores/ui/palette';
import { useModelValidation } from '@/hooks/models/use-model-validation';
import { usePushRegistration } from '@/hooks/notifications/use-push-registration';
import { AppShell } from './app-shell';
import { RightPane } from './right-pane';
import type { ReactNode } from 'react';
import type { NavigateFn } from '@tanstack/react-router';

vi.mock('@/hooks/models/use-model-validation', () => ({
  useModelValidation: vi.fn(),
}));

vi.mock('@/hooks/chat/chat', () => ({
  useDecryptedConversations: vi.fn(() => ({
    data: [],
    isLoading: false,
  })),
  useConversations: vi.fn(() => ({
    data: [],
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  })),
  chatKeys: {
    all: ['chat'] as const,
    conversations: () => ['chat', 'conversations'] as const,
  },
  useDeleteConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useUpdateConversation: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  DECRYPTING_TITLE: 'Decrypting...',
}));

/** The route params the shell reads non-strictly; set per test. */
const { routeParams } = vi.hoisted(() => ({
  routeParams: { current: {} as { id?: string; conversationId?: string } },
}));

/** The one navigate every router hook hands out, so a test can see where the shell went. */
const { routeNavigate } = vi.hoisted(() => ({ routeNavigate: vi.fn<NavigateFn>() }));

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => routeNavigate,
  useLocation: () => ({ pathname: '/' }),
  Link: ({
    children,
    to,
    className,
  }: {
    children: React.ReactNode;
    to: string;
    className?: string;
  }) => (
    <a href={to} className={className}>
      {children}
    </a>
  ),
  useParams: () => routeParams.current,
}));

vi.mock('@/hooks/billing/use-stable-balance', () => ({
  useStableBalance: () => ({
    displayBalance: '10000000000',
    isStable: true,
  }),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: () => ({
    isAuthStable: true,
    isBalanceStable: true,
    isAppStable: true,
  }),
}));

// The signed-in cases mount the sidebar's prompt slot for an account, which asks the server
// which channel prompt is owed; nothing here is about that prompt.
vi.mock('@/hooks/growth/use-acquisition-source', () => ({
  useAcquisitionSource: () => ({ data: undefined }),
  useSelfReport: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock('@/hooks/feedback/use-submit-feedback', () => ({
  useSubmitFeedback: () => ({ mutateAsync: vi.fn() }),
}));

// The panel's subpath pulls the speech engine; the shell only hosts it.
vi.mock('@hushbox/ui/accessibility/panel', () => ({
  AccessibilityPanel: (): null => null,
}));

vi.mock('@/hooks/notifications/use-push-registration', () => ({
  usePushRegistration: vi.fn(),
}));

vi.mock('@/hooks/notifications/use-enable-prompt', () => ({
  useEnablePrompt: vi.fn(() => ({
    isVisible: true,
    isEnabling: false,
    enable: vi.fn(),
    dismiss: vi.fn(),
  })),
}));

const originalMatchMedia = globalThis.matchMedia;

/** Narrows the window below 768px, which is what puts the sidebar in its phone drawer. */
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

describe('AppShell', () => {
  beforeEach(() => {
    useUIStore.setState({ sidebarOpen: true });
    useUIModalsStore.setState({ feedbackOpen: false });
  });

  it('renders children', () => {
    render(
      <AppShell>
        <div data-testid="child-content">Hello World</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    expect(screen.getByTestId('child-content')).toBeInTheDocument();
    expect(screen.getByText('Hello World')).toBeInTheDocument();
  });

  it('presents observed notification activity', () => {
    document.title = 'HushBox';
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    act(() => {
      useNotificationActivityStore.setState({ unreadCount: 2 });
    });

    expect(document.title).toBe('(2) HushBox');
    useNotificationActivityStore.setState({ unreadCount: 0 });
  });

  it('renders Sidebar', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    expect(screen.getByRole('complementary')).toBeInTheDocument();
  });

  it('has flex layout', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    const shell = screen.getByTestId(TEST_IDS.appShell);
    expect(shell).toHaveClass('flex');
  });

  it('fills its container height', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    const shell = screen.getByTestId(TEST_IDS.appShell);
    // h-full, not h-dvh: the root route's h-dvh flex column owns the viewport
    // height; the shell fills the flex-1 content region below the app-wide banner.
    expect(shell).toHaveClass('h-full');
  });

  it('renders main content area', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    expect(screen.getByRole('main')).toBeInTheDocument();
  });

  it('main area takes remaining space', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    const main = screen.getByRole('main');
    expect(main).toHaveClass('flex-1');
  });

  it('main area handles overflow', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    const main = screen.getByRole('main');
    expect(main).toHaveClass('overflow-hidden');
  });

  it('renders portal target for right sidebar', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    const portalTarget = document.querySelector('#right-sidebar-portal');
    expect(portalTarget).toBeInTheDocument();
    expect(portalTarget).toHaveClass('contents');
  });

  describe('the right pane slot', () => {
    function renderWithPane(): void {
      render(
        <AppShell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            surface="sidebar"
            head="plain"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            member list
          </RightPane>
        </AppShell>,
        { wrapper: createWrapper() }
      );
    }

    beforeEach(() => {
      useRightPane.setState({ active: null });
    });

    it('docks an open pane in the shell row after the main region, outside it', () => {
      renderWithPane();

      act(() => {
        useRightPane.getState().open('members');
      });

      const pane = screen.getByRole('complementary', { name: 'Members' });
      const main = screen.getByRole('main');
      expect(main).not.toContainElement(pane);
      expect(main.compareDocumentPosition(pane) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      expect(screen.getByTestId(TEST_IDS.appShell)).toContainElement(pane);
    });

    it('folds the sidebar to its rail while a pane is docked', () => {
      renderWithPane();

      act(() => {
        useRightPane.getState().open('members');
      });

      expect(screen.getByTestId(TEST_IDS.sidebar)).toHaveClass('w-14');
    });

    it('restores the open sidebar once the pane closes, leaving the saved choice as it was', async () => {
      const user = userEvent.setup();
      renderWithPane();
      act(() => {
        useRightPane.getState().open('members');
      });

      await user.click(screen.getByRole('button', { name: 'Close members' }));

      expect(screen.getByTestId(TEST_IDS.sidebar)).toHaveClass('w-72');
      expect(useUIStore.getState().sidebarOpen).toBe(true);
    });
  });

  it('opens the accessibility panel in the shell row when the panel store opens', async () => {
    useRightPane.setState({ active: null });
    useAccessibilityPanelStore.setState({ open: false });
    render(
      <AppShell>
        <div>page</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    act(() => {
      useAccessibilityPanelStore.getState().setOpen(true);
    });

    const pane = screen.getByRole('complementary', { name: 'Accessibility' });
    expect(screen.getByTestId(TEST_IDS.appShell)).toContainElement(pane);
    expect(screen.getByRole('main')).not.toContainElement(pane);
    // The panel loads lazily and draws nothing here; awaiting its module lets it settle inside
    // the test.
    await act(async () => {
      await import('@hushbox/ui/accessibility/panel');
    });
  });

  describe('the page under a full-screen phone pane', () => {
    function renderWithPanes(): void {
      render(
        <AppShell>
          <RightPane
            id="members"
            title="Members"
            width="20rem"
            surface="sidebar"
            head="plain"
            phone="fullscreen"
            onClose={vi.fn()}
          >
            <button type="button">member action</button>
          </RightPane>
          <RightPane
            id="accessibility"
            title="Accessibility"
            width="22rem"
            surface="background"
            head="display"
            phone="sheet"
            onClose={vi.fn()}
          >
            <button type="button">setting</button>
          </RightPane>
        </AppShell>,
        { wrapper: createWrapper() }
      );
    }

    function mainRegion(): HTMLElement {
      const main = document.querySelector<HTMLElement>('main#main');
      if (main === null) throw new Error('the shell rendered no main region');
      return main;
    }

    function openPane(id: string): void {
      act(() => {
        useRightPane.getState().open(id);
      });
    }

    beforeEach(() => {
      useRightPane.setState({ active: null });
    });

    afterEach(() => {
      Object.defineProperty(globalThis, 'matchMedia', {
        writable: true,
        value: originalMatchMedia,
      });
    });

    it('hides the page behind a full-screen phone pane from assistive technology', () => {
      stubPhoneWidth();
      renderWithPanes();

      openPane('members');

      expect(mainRegion().closest('[aria-hidden="true"]')).not.toBeNull();
    });

    it('releases the page once the full-screen pane closes', () => {
      stubPhoneWidth();
      renderWithPanes();
      openPane('members');

      act(() => {
        useRightPane.getState().close();
      });

      expect(mainRegion().closest('[aria-hidden="true"]')).toBeNull();
    });

    it('leaves the page exposed under the non-modal sheet', () => {
      stubPhoneWidth();
      renderWithPanes();

      openPane('accessibility');

      expect(mainRegion().closest('[aria-hidden="true"]')).toBeNull();
    });
  });

  it('re-registers this device for push once the shell mounts', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    expect(usePushRegistration).toHaveBeenCalled();
  });

  it('offers notifications from the sidebar, never from the main region', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    expect(
      within(screen.getByRole('complementary')).getByRole('button', { name: 'Enable' })
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('main')).queryByRole('button', { name: 'Enable' })
    ).not.toBeInTheDocument();
  });

  it('never asks the browser for notification permission on mount', () => {
    const requestPermission = vi.fn();
    vi.stubGlobal('Notification', { permission: 'default', requestPermission });

    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    expect(requestPermission).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('calls useModelValidation to validate cached model selection', () => {
    vi.mocked(useModelValidation).mockClear();

    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    expect(useModelValidation).toHaveBeenCalled();
  });

  describe('the funding scope handed to model validation', () => {
    function renderShell(): void {
      vi.mocked(useModelValidation).mockClear();
      render(
        <AppShell>
          <div>Content</div>
        </AppShell>,
        { wrapper: createWrapper() }
      );
    }

    it('is the open conversation on a chat route', () => {
      routeParams.current = { id: 'conv-7' };
      renderShell();
      expect(useModelValidation).toHaveBeenCalledWith('conv-7');
    });

    it('is the shared conversation on the link-guest share route', () => {
      routeParams.current = { conversationId: 'conv-shared' };
      renderShell();
      expect(useModelValidation).toHaveBeenCalledWith('conv-shared');
    });

    it('is none for a conversation that does not exist yet', () => {
      routeParams.current = { id: 'new' };
      renderShell();
      expect(useModelValidation).toHaveBeenCalledWith(null);
    });

    it('is none on a route that names no conversation', () => {
      routeParams.current = {};
      renderShell();
      expect(useModelValidation).toHaveBeenCalledWith(null);
    });
  });

  it('renders a skip-to-content link as the first focusable element', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    const shell = screen.getByTestId(TEST_IDS.appShell);
    const focusables = shell.querySelectorAll('a, button, input, [tabindex]');
    expect(focusables[0]).toBe(screen.getByRole('link', { name: /skip to content/i }));
  });

  it('points the skip link at the main content region', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    expect(screen.getByRole('link', { name: /skip to content/i })).toHaveAttribute('href', '#main');
  });

  it('renders the shared skip link', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    expect(screen.getByRole('link', { name: /skip to content/i }).outerHTML).toBe(
      renderToStaticMarkup(<SkipLink />)
    );
  });

  it('gives main a focusable target for the skip link', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main');
    expect(main).toHaveAttribute('tabindex', '-1');
  });

  describe('Send feedback from the phone drawer', () => {
    beforeEach(() => {
      stubPhoneWidth();
      useAuthStore.setState({
        user: {
          id: 'user-1',
          email: 'alice@hushbox.ai',
          username: 'alice',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: true,
        },
        isLoading: false,
      });
      useUIStore.setState({ sidebarOpen: true, mobileSidebarOpen: true });
    });

    afterEach(() => {
      Object.defineProperty(globalThis, 'matchMedia', {
        writable: true,
        value: originalMatchMedia,
      });
      // The shell is still mounted here, so the reset is a render like any other.
      act(() => {
        useAuthStore.setState({ user: null, isLoading: true });
        useUIStore.setState({ mobileSidebarOpen: false });
      });
    });

    it('keeps the feedback dialog open after the drawer closes', async () => {
      const user = userEvent.setup();
      render(
        <AppShell>
          <div>Content</div>
        </AppShell>,
        { wrapper: createWrapper() }
      );

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuFeedback));

      await waitFor(() => {
        expect(useUIStore.getState().mobileSidebarOpen).toBe(false);
      });
      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.sidebar)).not.toBeInTheDocument();
      });
      expect(screen.getByTestId(TEST_IDS.feedbackModal)).toBeInTheDocument();
    });
  });

  it('returns focus to the account button when the feedback dialog closes', async () => {
    useAuthStore.setState({
      user: {
        id: 'user-1',
        email: 'alice@hushbox.ai',
        username: 'alice',
        emailVerified: true,
        totpEnabled: false,
        hasAcknowledgedPhrase: true,
      },
      isLoading: false,
    });
    const user = userEvent.setup();
    try {
      render(
        <AppShell>
          <div>Content</div>
        </AppShell>,
        { wrapper: createWrapper() }
      );

      await user.click(screen.getByTestId(TEST_IDS.accountButton));
      await user.click(screen.getByTestId(TEST_IDS.menuFeedback));
      await screen.findByTestId(TEST_IDS.feedbackModal);
      await waitFor(() => {
        expect(screen.queryByRole('menu', { hidden: true })).not.toBeInTheDocument();
      });
      await user.keyboard('{Escape}');
      await waitFor(() => {
        expect(screen.queryByTestId(TEST_IDS.feedbackModal)).not.toBeInTheDocument();
      });

      await waitFor(() => {
        expect(screen.getByTestId(TEST_IDS.accountButton)).toHaveFocus();
      });
    } finally {
      act(() => {
        useAuthStore.setState({ user: null, isLoading: true });
      });
    }
  });

  it('opens the feedback dialog when the shared store asks for it', () => {
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );

    act(() => {
      useUIModalsStore.getState().setFeedbackOpen(true);
    });

    expect(screen.getByTestId(TEST_IDS.feedbackModal)).toBeInTheDocument();
  });

  describe('the command palette', () => {
    beforeEach(() => {
      usePaletteStore.setState({ open: false });
      routeNavigate.mockClear();
    });

    afterEach(() => {
      act(() => {
        usePaletteStore.setState({ open: false });
        useAuthStore.setState({ user: null, isLoading: true });
      });
    });

    it('opens from the Search row', async () => {
      const user = userEvent.setup();
      render(
        <AppShell>
          <div>Content</div>
        </AppShell>,
        { wrapper: createWrapper() }
      );

      await user.click(screen.getByTestId(TEST_IDS.sidebarSearchRow));

      expect(await screen.findByTestId(TEST_IDS.commandPalette)).toBeInTheDocument();
    });

    it('opens on Ctrl K', async () => {
      render(
        <AppShell>
          <div>Content</div>
        </AppShell>,
        { wrapper: createWrapper() }
      );

      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true })
        );
      });

      expect(await screen.findByTestId(TEST_IDS.commandPalette)).toBeInTheDocument();
    });

    it('starts a new chat on Ctrl Shift O', () => {
      render(
        <AppShell>
          <div>Content</div>
        </AppShell>,
        { wrapper: createWrapper() }
      );

      act(() => {
        document.body.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'O', ctrlKey: true, shiftKey: true, bubbles: true })
        );
      });

      expect(routeNavigate).toHaveBeenCalledWith({ to: '/chat' });
    });

    it('opens the feedback dialog when Send feedback is chosen', async () => {
      useAuthStore.setState({
        user: {
          id: 'user-1',
          email: 'alice@hushbox.ai',
          username: 'alice',
          emailVerified: true,
          totpEnabled: false,
          hasAcknowledgedPhrase: true,
        },
        isLoading: false,
      });
      const user = userEvent.setup();
      render(
        <AppShell>
          <div>Content</div>
        </AppShell>,
        { wrapper: createWrapper() }
      );
      act(() => {
        usePaletteStore.getState().setOpen(true);
      });

      await user.click(await screen.findByRole('option', { name: /Send feedback/ }));

      expect(await screen.findByTestId(TEST_IDS.feedbackModal)).toBeInTheDocument();
    });
  });

  it('writes a dismissal back to the shared store', async () => {
    const user = userEvent.setup();
    render(
      <AppShell>
        <div>Content</div>
      </AppShell>,
      { wrapper: createWrapper() }
    );
    act(() => {
      useUIModalsStore.getState().setFeedbackOpen(true);
    });

    await user.keyboard('{Escape}');

    await waitFor(() => {
      expect(useUIModalsStore.getState().feedbackOpen).toBe(false);
    });
  });
});
