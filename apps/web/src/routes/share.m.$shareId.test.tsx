import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { asContentKey } from '@hushbox/crypto';
import { HOUR_MS, MINUTE_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { renderRoute } from '@/test-utils/render';
import { useSharedMessage } from '@/hooks/chat/use-shared-message.js';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import { Route } from './share.m.$shareId';
import type { WrappedSecret } from '@hushbox/crypto';
import type { ChatLayoutProps } from '@/components/chat/layout/chat-layout';
import type { SharedMessageData } from '@/hooks/chat/use-shared-message.js';

vi.mock('@/hooks/chat/use-shared-message.js', () => ({
  useSharedMessage: vi.fn(),
}));

vi.mock('@/hooks/auth/use-stable-session', () => ({
  useStableSession: vi.fn(),
}));

// The real AppShell renders, so its main landmark is the one under test; only
// its data-fetching leaves are stubbed.
vi.mock('@/components/sidebar/sidebar', () => ({
  Sidebar: (): React.JSX.Element => <nav data-testid="sidebar" />,
}));

vi.mock('@/components/notifications/notification-activity-layer', () => ({
  NotificationActivityLayer: (): null => null,
}));

vi.mock('@/hooks/models/use-model-validation', () => ({
  useModelValidation: vi.fn(),
}));

vi.mock('@/hooks/notifications/use-push-registration', () => ({
  usePushRegistration: vi.fn(),
}));

// The chat's layout stands in as the thread it draws: its head, its rows by id, its foot,
// and whatever the page puts in the composer's place.
vi.mock('@/components/chat/layout/chat-layout', () => ({
  ChatLayout: (props: ChatLayoutProps): React.JSX.Element => (
    <div data-testid="chat-layout">
      {props.threadHeader}
      <ol>
        {props.messages.map((message) => (
          <li key={message.id} data-message-id={message.id} data-deleted={message.deleted === true}>
            {message.content}
          </li>
        ))}
      </ol>
      {props.threadFooter}
      {props.composerSlot ?? <textarea data-testid="composer" />}
    </div>
  ),
}));

// Keep the real router (createFileRoute must run for the route file); mock only
// useParams, and Link, which needs a router this render does not mount. The link
// keeps the attributes a wrapping Button merges onto it.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useParams: () => ({ shareId: 'share-from-route' }),
    Link: ({
      to,
      children,
      ...rest
    }: Readonly<
      { to: string; children: React.ReactNode } & React.ComponentProps<'a'>
    >): React.JSX.Element => (
      <a href={to} {...rest}>
        {children}
      </a>
    ),
  };
});

const mockUseSharedMessage = vi.mocked(useSharedMessage);
const mockUseStableSession = vi.mocked(useStableSession);

const SIGNED_OUT: ReturnType<typeof useStableSession> = {
  session: null,
  isAuthenticated: false,
  isStable: true,
  isPending: false,
};

/** When the shared message itself was written; the share is created later. */
const MESSAGE_CREATED_AT = isoAt(TEST_DAY_START + 9 * HOUR_MS);
const SHARE_CREATED_AT = isoAt(TEST_DAY_START + 14 * HOUR_MS + 34 * MINUTE_MS);

const LIVE_SHARE: SharedMessageData = {
  deleted: false,
  createdAt: SHARE_CREATED_AT,
  messageCreatedAt: MESSAGE_CREATED_AT,
  contentKey: asContentKey(new Uint8Array(32)),
  // The brand has no constructor; the hook brands the wire bytes the same way.
  wrappedContentKey: new Uint8Array([4, 5, 6]) as WrappedSecret,
  conversationId: 'conv-1',
  messageId: 'msg-1',
  epochNumber: 2,
  senderId: 'sender-1',
  contentItems: [
    {
      type: 'text',
      position: 0,
      content: 'Hello world',
      reasoningTokens: null,
      reasoningEffort: null,
      reasoningDurationMs: null,
      modelName: 'anthropic/claude-sonnet-4.5',
      isSmartModel: false,
    },
  ],
};

const DELETED_SHARE: SharedMessageData = {
  deleted: true,
  messageId: 'msg-1',
  conversationId: 'conv-1',
  createdAt: SHARE_CREATED_AT,
  messageCreatedAt: MESSAGE_CREATED_AT,
};

/** The query result while the share is fetched and opened. */
function pendingShare(): ReturnType<typeof useSharedMessage> {
  return {
    data: undefined,
    dataUpdatedAt: 0,
    error: null,
    errorUpdatedAt: 0,
    errorUpdateCount: 0,
    failureCount: 0,
    failureReason: null,
    fetchStatus: 'fetching',
    isEnabled: true,
    isError: false,
    isFetched: false,
    isFetchedAfterMount: false,
    isFetching: true,
    isInitialLoading: true,
    isLoading: true,
    isLoadingError: false,
    isPaused: false,
    isPending: true,
    isPlaceholderData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: true,
    isSuccess: false,
    promise: new Promise<SharedMessageData>(() => {}),
    refetch: vi.fn(),
    status: 'pending',
  };
}

/** The query result once the share could not be read or opened. */
function failedShare(): ReturnType<typeof useSharedMessage> {
  const error = new Error('share unavailable');
  return {
    data: undefined,
    dataUpdatedAt: 0,
    error,
    errorUpdatedAt: TEST_DAY_START,
    errorUpdateCount: 1,
    failureCount: 1,
    failureReason: error,
    fetchStatus: 'idle',
    isEnabled: true,
    isError: true,
    isFetched: true,
    isFetchedAfterMount: true,
    isFetching: false,
    isInitialLoading: false,
    isLoading: false,
    isLoadingError: true,
    isPaused: false,
    isPending: false,
    isPlaceholderData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: true,
    isSuccess: false,
    // Never settles: a rejected promise nothing awaits would surface as an unhandled rejection.
    promise: new Promise<SharedMessageData>(() => {}),
    refetch: vi.fn(),
    status: 'error',
  };
}

/**
 * The settled query result the hook returns once `data` has decrypted, in full, so a
 * change to the hook's data or result shape fails to compile here.
 */
function loadedShare(data: SharedMessageData): ReturnType<typeof useSharedMessage> {
  return {
    data,
    dataUpdatedAt: TEST_DAY_START,
    error: null,
    errorUpdatedAt: 0,
    errorUpdateCount: 0,
    failureCount: 0,
    failureReason: null,
    fetchStatus: 'idle',
    isEnabled: true,
    isError: false,
    isFetched: true,
    isFetchedAfterMount: true,
    isFetching: false,
    isInitialLoading: false,
    isLoading: false,
    isLoadingError: false,
    isPaused: false,
    isPending: false,
    isPlaceholderData: false,
    isRefetchError: false,
    isRefetching: false,
    isStale: false,
    isSuccess: true,
    promise: Promise.resolve(data),
    refetch: vi.fn(),
    status: 'success',
  };
}

/**
 * The route announcer and the skip link both look up `#main`, so each branch
 * must render exactly one, and it must be the page's focusable main landmark.
 */
function expectOneMainFocusTarget(): HTMLElement {
  const targets = document.querySelectorAll<HTMLElement>('#main');
  expect(targets).toHaveLength(1);
  const [target] = targets;
  expect(target).toBe(screen.getByRole('main'));
  expect(target).toHaveAttribute('tabindex', '-1');
  return target!;
}

describe('/share/m/$shareId route', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseStableSession.mockReturnValue(SIGNED_OUT);
    Object.defineProperty(globalThis, 'location', {
      value: { hash: '#c2hhcmUta2V5LWI2NA' },
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
  });

  describe('while the share is opened', () => {
    beforeEach(() => {
      mockUseSharedMessage.mockReturnValue(pendingShare());
    });

    it('renders the loading state', () => {
      renderRoute(Route);

      expect(screen.getByTestId(TEST_IDS.sharedMessageLoading)).toBeInTheDocument();
    });

    it('gives the loading state one focusable main#main', () => {
      renderRoute(Route);

      expect(expectOneMainFocusTarget()).toContainElement(
        screen.getByTestId(TEST_IDS.sharedMessageLoading)
      );
    });

    it('sizes the loading state to its container, not the viewport', () => {
      renderRoute(Route);

      // h-full, not h-dvh: the root route's h-dvh banner-row layout owns the
      // viewport height; h-dvh here would overflow by the banner's height when a
      // banner is active.
      expect(screen.getByTestId(TEST_IDS.sharedMessageLoading)).toHaveClass('h-full');
    });

    it('announces the loading state politely', () => {
      renderRoute(Route);

      const loading = screen.getByTestId(TEST_IDS.sharedMessageLoading);
      expect(loading).toHaveAttribute('role', 'status');
      expect(loading).toHaveAttribute('aria-live', 'polite');
    });

    it('draws no thread yet', () => {
      renderRoute(Route);

      expect(screen.queryByTestId('chat-layout')).not.toBeInTheDocument();
    });

    it('passes the hash fragment to the hook as the key', () => {
      renderRoute(Route);

      expect(mockUseSharedMessage).toHaveBeenCalledWith('share-from-route', 'c2hhcmUta2V5LWI2NA');
    });

    it('passes a null key to the hook when the URL has no hash fragment', () => {
      // An empty fragment collapses `slice(1) || null` to null, so the hook is
      // told there is no decryption key rather than an empty string.
      Object.defineProperty(globalThis, 'location', { value: { hash: '' }, writable: true });

      renderRoute(Route);

      expect(mockUseSharedMessage).toHaveBeenCalledWith('share-from-route', null);
    });
  });

  describe('when the share cannot be opened', () => {
    beforeEach(() => {
      mockUseSharedMessage.mockReturnValue(failedShare());
    });

    it('renders the error state inside the app shell', () => {
      renderRoute(Route);

      expect(screen.getByTestId(TEST_IDS.appShell)).toContainElement(
        screen.getByTestId(TEST_IDS.sharedMessageError)
      );
    });

    it('gives the error state one focusable main#main', () => {
      renderRoute(Route);

      expect(expectOneMainFocusTarget()).toContainElement(
        screen.getByTestId(TEST_IDS.sharedMessageError)
      );
    });

    it('announces the error state as an alert', () => {
      renderRoute(Route);

      expect(screen.getByTestId(TEST_IDS.sharedMessageError)).toHaveAttribute('role', 'alert');
    });

    it('shows an icon in the error state', () => {
      renderRoute(Route);

      expect(
        screen.getByTestId(TEST_IDS.sharedMessageError).querySelector('svg')
      ).toBeInTheDocument();
    });

    it('says the link may be invalid or expired', () => {
      renderRoute(Route);

      expect(screen.getByText('Unable to access message')).toBeInTheDocument();
      expect(screen.getByText('This share link may be invalid or expired.')).toBeInTheDocument();
    });

    it('draws no thread', () => {
      renderRoute(Route);

      expect(screen.queryByTestId('chat-layout')).not.toBeInTheDocument();
    });
  });

  describe('once the share is opened', () => {
    it("draws the shared reply as the chat's own thread", () => {
      mockUseSharedMessage.mockReturnValue(loadedShare(LIVE_SHARE));

      renderRoute(Route);

      const row = screen.getByTestId('chat-layout').querySelector('[data-message-id="msg-1"]');
      expect(row).toHaveTextContent('Hello world');
    });

    it('gives the thread one focusable main#main', () => {
      mockUseSharedMessage.mockReturnValue(loadedShare(LIVE_SHARE));

      renderRoute(Route);

      expect(expectOneMainFocusTarget()).toContainElement(screen.getByTestId('chat-layout'));
    });

    // The shell holds the pane slot a document panel portals into; outside it the panel
    // draws in place.
    it("draws the thread inside the page shell's region", () => {
      mockUseSharedMessage.mockReturnValue(loadedShare(LIVE_SHARE));

      renderRoute(Route);

      expect(screen.getByTestId('chat-layout').closest('[data-page-slot="region"]')).not.toBeNull();
    });

    it('titles the page Shared reply in its one heading of the first level', () => {
      mockUseSharedMessage.mockReturnValue(loadedShare(LIVE_SHARE));

      renderRoute(Route);

      expect(screen.getAllByRole('heading', { level: 1 })).toEqual([
        screen.getByRole('heading', { level: 1, name: 'Shared reply' }),
      ]);
    });

    it('draws no composer', () => {
      mockUseSharedMessage.mockReturnValue(loadedShare(LIVE_SHARE));

      renderRoute(Route);

      expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
    });

    it('keeps focus on the same main#main when the decrypted message replaces the loading state', () => {
      mockUseSharedMessage.mockReturnValue(pendingShare());
      const { rerender } = renderRoute(Route);
      // The loading state has no heading, so the route announcer focuses `#main` itself.
      const loadingMain = expectOneMainFocusTarget();
      loadingMain.focus();

      mockUseSharedMessage.mockReturnValue(loadedShare(LIVE_SHARE));
      const SharedMessagePage = Route.options.component!;
      rerender(<SharedMessagePage />);

      expect(screen.getByTestId('chat-layout')).toBeInTheDocument();
      expect(expectOneMainFocusTarget()).toBe(loadingMain);
      expect(loadingMain).toContainElement(document.activeElement as HTMLElement);
    });
  });

  describe('a share whose message is deleted', () => {
    beforeEach(() => {
      mockUseSharedMessage.mockReturnValue(loadedShare(DELETED_SHARE));
    });

    it('draws the deleted reply as the thread draws one', () => {
      renderRoute(Route);

      const row = screen.getByTestId('chat-layout').querySelector('[data-message-id="msg-1"]');
      expect(row).toHaveAttribute('data-deleted', 'true');
    });

    it('renders no error state', () => {
      renderRoute(Route);

      expect(screen.queryByTestId(TEST_IDS.sharedMessageError)).not.toBeInTheDocument();
    });

    it('still titles the page Shared reply in its one heading of the first level', () => {
      renderRoute(Route);

      expect(screen.getAllByRole('heading', { level: 1 })).toEqual([
        screen.getByRole('heading', { level: 1, name: 'Shared reply' }),
      ]);
    });
  });
});
