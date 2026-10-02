import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, cleanup, fireEvent, within } from '@testing-library/react';
import { REASONING_EFFORT_LABELS, serializeSegments, TEST_IDS } from '@hushbox/shared';
import { asContentKey } from '@hushbox/crypto';
import { HOUR_MS, MINUTE_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { renderRoute } from '@/test-utils/render';
import { useSharedMessage } from '@/hooks/chat/use-shared-message.js';
import { useSegmentViewState } from '@/components/chat/segments/segment-view-state.js';
import { Route } from './share.m.$shareId';
import type { WrappedSecret } from '@hushbox/crypto';

vi.mock('@/hooks/chat/use-shared-message.js', () => ({
  useSharedMessage: vi.fn(),
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

// ChatLayout is mocked for safety: this page does not use it, but if a stale
// reference slips through we want the test to fail on the assertion, not on a
// cascade of env-parsing side effects from the real ChatLayout tree.
vi.mock('@/components/chat/layout/chat-layout.js', () => ({
  ChatLayout: (): React.JSX.Element => <div data-testid="chat-layout-should-not-render" />,
}));

vi.mock('@/components/chat/message/markdown-renderer.js', () => ({
  MarkdownRenderer: ({ content }: { content: string }): React.JSX.Element => (
    <div data-testid="markdown-renderer">{content}</div>
  ),
}));

// The share page renders media through the same MediaContentItem the chat uses
// (via MessageBody → MessageMediaList). Mock the leaf to avoid the fetch +
// decrypt chain; MessageBody / MessageMediaList render for real.
vi.mock('@/components/chat/media/media-content-item.js', () => ({
  MediaContentItem: ({
    item,
  }: {
    item: {
      contentItemId: string;
      contentType: string;
      sizeBytes?: number;
      downloadUrl?: string;
      envelope?: { messageId: string; epochNumber: number; position: number };
    };
  }): React.JSX.Element => (
    <div
      data-testid={`shared-media-${item.contentItemId}`}
      data-content-type={item.contentType}
      data-size-bytes={item.sizeBytes}
      data-download-url={item.downloadUrl}
      data-envelope-message={item.envelope?.messageId}
      data-envelope-epoch={item.envelope?.epochNumber}
      data-envelope-position={item.envelope?.position}
    >
      Shared media: {item.contentItemId}
    </div>
  ),
}));

// Keep the real router (createFileRoute must run for the route file); mock only useParams.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
    useParams: () => ({ shareId: 'share-from-route' }),
  };
});

const mockUseSharedMessage = vi.mocked(useSharedMessage);

// Import the hook's exported data type directly: deriving it through
// NonNullable<ReturnType<...>['data']> wraps it in NoInfer, which trips
// assignability of plain fixture literals under the typechecker.
type SharedMessageData = import('@/hooks/chat/use-shared-message.js').SharedMessageData;
type LiveSharedMessage = Extract<SharedMessageData, { deleted: false }>;

/** A signed media URL's expiry: shortly after the message the share carries. */
const MEDIA_URL_EXPIRES_AT = isoAt(TEST_DAY_START + 15 * HOUR_MS);

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

function mockData(overrides: Partial<LiveSharedMessage> = {}): LiveSharedMessage {
  return {
    deleted: false,
    createdAt: isoAt(TEST_DAY_START + 14 * HOUR_MS + 34 * MINUTE_MS),
    contentKey: asContentKey(new Uint8Array(32)),
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
      },
    ],
    ...overrides,
  };
}

describe('/share/m/$shareId route', () => {
  beforeEach(() => {
    useSegmentViewState.setState({ open: new Set() });
    vi.clearAllMocks();
    Object.defineProperty(globalThis, 'location', {
      value: { hash: '#c2hhcmUta2V5LWI2NA' },
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders loading state when data is loading', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.sharedMessageLoading)).toBeInTheDocument();
  });

  it('renders the loading state inside a main landmark', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(screen.getByRole('main')).toContainElement(
      screen.getByTestId(TEST_IDS.sharedMessageLoading)
    );
  });

  it('gives the loading state one focusable main#main', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(expectOneMainFocusTarget()).toContainElement(
      screen.getByTestId(TEST_IDS.sharedMessageLoading)
    );
  });

  it('gives the error state one focusable main#main', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(expectOneMainFocusTarget()).toContainElement(
      screen.getByTestId(TEST_IDS.sharedMessageError)
    );
  });

  it('gives the shared message one focusable main#main', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData(),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(expectOneMainFocusTarget()).toContainElement(
      screen.getByTestId(TEST_IDS.sharedMessageContent)
    );
  });

  it('keeps focus on the same main#main when the decrypted message replaces the loading state', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);
    const { rerender } = renderRoute(Route);
    // The loading state has no heading, so the route announcer focuses `#main` itself.
    const loadingMain = expectOneMainFocusTarget();
    loadingMain.focus();

    mockUseSharedMessage.mockReturnValue({
      data: mockData(),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);
    const SharedMessagePage = Route.options.component!;
    rerender(<SharedMessagePage />);

    expect(screen.getByTestId(TEST_IDS.sharedMessageContent)).toBeInTheDocument();
    expect(expectOneMainFocusTarget()).toBe(loadingMain);
    expect(loadingMain).toContainElement(document.activeElement as HTMLElement);
  });

  it('sizes the loading state to its container, not the viewport', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    // h-full, not h-dvh: the root route's h-dvh banner-row layout owns the
    // viewport height; h-dvh here would overflow by the banner's height when a
    // banner is active.
    expect(screen.getByTestId(TEST_IDS.sharedMessageLoading)).toHaveClass('h-full');
  });

  it('announces loading state via role="status" and aria-live="polite"', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    const loading = screen.getByTestId(TEST_IDS.sharedMessageLoading);
    expect(loading).toHaveAttribute('role', 'status');
    expect(loading).toHaveAttribute('aria-live', 'polite');
  });

  it('renders error state wrapped in AppShell', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.appShell)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.sharedMessageError)).toBeInTheDocument();
  });

  it('passes a null key to the hook when the URL has no hash fragment', () => {
    // An empty fragment collapses `slice(1) || null` to null, so the hook is
    // told there is no decryption key rather than an empty string.
    Object.defineProperty(globalThis, 'location', { value: { hash: '' }, writable: true });
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(mockUseSharedMessage).toHaveBeenCalledWith('share-from-route', null);
  });

  it('announces error state via role="alert"', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.sharedMessageError)).toHaveAttribute('role', 'alert');
  });

  it('shows AlertTriangle icon in error state', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    const errorContainer = screen.getByTestId(TEST_IDS.sharedMessageError);
    const icon = errorContainer.querySelector('svg');
    expect(icon).toBeInTheDocument();
  });

  it('shows descriptive error messages', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(screen.getByText('Unable to access message')).toBeInTheDocument();
    expect(screen.getByText('This share link may be invalid or expired.')).toBeInTheDocument();
  });

  it('renders AppShell with shared message content when data loads', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData(),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(screen.getByTestId(TEST_IDS.appShell)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.sharedMessageContent)).toBeInTheDocument();
  });

  it("sets the heading on the message body's edge, with no inset of its own", () => {
    const data = mockData();
    const loaded: ReturnType<typeof useSharedMessage> = {
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
    mockUseSharedMessage.mockReturnValue(loaded);

    renderRoute(Route);

    expect(screen.getByRole('heading', { name: 'Shared message' })).not.toHaveClass('px-4');
  });

  describe('a share whose message is deleted', () => {
    const deletedShare: SharedMessageData = {
      deleted: true,
      createdAt: isoAt(TEST_DAY_START + 14 * HOUR_MS),
    };

    it('renders Message deleted inside the shared message region', () => {
      mockUseSharedMessage.mockReturnValue({
        data: deletedShare,
        isLoading: false,
        isError: false,
      } as unknown as ReturnType<typeof useSharedMessage>);

      renderRoute(Route);

      const region = screen.getByTestId(TEST_IDS.sharedMessageContent);
      expect(within(region).getByTestId(TEST_IDS.messageDeleted)).toHaveTextContent(
        'Message deleted'
      );
    });

    it('renders no error state', () => {
      mockUseSharedMessage.mockReturnValue({
        data: deletedShare,
        isLoading: false,
        isError: false,
      } as unknown as ReturnType<typeof useSharedMessage>);

      renderRoute(Route);

      expect(screen.queryByTestId(TEST_IDS.sharedMessageError)).not.toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.appShell)).toBeInTheDocument();
    });

    it('renders a live share’s content with no deleted notice', () => {
      mockUseSharedMessage.mockReturnValue({
        data: mockData(),
        isLoading: false,
        isError: false,
      } as unknown as ReturnType<typeof useSharedMessage>);

      renderRoute(Route);

      expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('Hello world');
      expect(screen.queryByTestId(TEST_IDS.messageDeleted)).not.toBeInTheDocument();
    });
  });

  it('renders text content items via MarkdownRenderer', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData({
        contentItems: [
          {
            type: 'text',
            position: 0,
            content: 'First paragraph',
            reasoningTokens: null,
            reasoningEffort: null,
          },
          {
            type: 'text',
            position: 1,
            content: 'Second paragraph',
            reasoningTokens: null,
            reasoningEffort: null,
          },
        ],
      }),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    const renderers = screen.getAllByTestId(TEST_IDS.markdownRenderer);
    expect(renderers).toHaveLength(2);
    expect(renderers[0]).toHaveTextContent('First paragraph');
    expect(renderers[1]).toHaveTextContent('Second paragraph');
  });

  it('renders media content items via the shared media renderer', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData({
        contentItems: [
          {
            type: 'media',
            position: 0,
            contentItemId: 'img-1',
            contentType: 'image',
            mimeType: 'image/png',
            sizeBytes: 1024,
            width: 512,
            height: 512,
            durationMs: null,
            downloadUrl: 'https://signed.example/a',
            expiresAt: MEDIA_URL_EXPIRES_AT,
          },
          {
            type: 'media',
            position: 1,
            contentItemId: 'vid-1',
            contentType: 'video',
            mimeType: 'video/mp4',
            sizeBytes: 4096,
            width: 1920,
            height: 1080,
            durationMs: 5000,
            downloadUrl: 'https://signed.example/b',
            expiresAt: MEDIA_URL_EXPIRES_AT,
          },
        ],
      }),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    const img = screen.getByTestId('shared-media-img-1');
    expect(img).toHaveAttribute('data-content-type', 'image');
    expect(img).toHaveAttribute('data-download-url', 'https://signed.example/a');
    // The content-item sizeBytes flows through so the client size guard fires
    // on the public-share path too.
    expect(img).toHaveAttribute('data-size-bytes', '1024');
    const vid = screen.getByTestId('shared-media-vid-1');
    expect(vid).toHaveAttribute('data-content-type', 'video');
    expect(vid).toHaveAttribute('data-size-bytes', '4096');
  });

  it('hands each media item its own location-bound envelope', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData({
        contentItems: [
          {
            type: 'media',
            position: 3,
            contentItemId: 'img-1',
            contentType: 'image',
            mimeType: 'image/png',
            sizeBytes: 1024,
            width: 512,
            height: 512,
            durationMs: null,
            downloadUrl: 'https://signed.example/a',
            expiresAt: MEDIA_URL_EXPIRES_AT,
          },
        ],
      }),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    const img = screen.getByTestId('shared-media-img-1');
    // The message-level AAD inputs plus this item's own position: the same
    // tuple the server bound, so the bytes open on the public share page.
    expect(img).toHaveAttribute('data-envelope-message', 'msg-1');
    expect(img).toHaveAttribute('data-envelope-epoch', '2');
    expect(img).toHaveAttribute('data-envelope-position', '3');
  });

  it('groups all text before media, matching how chat renders an assistant message', () => {
    mockUseSharedMessage.mockReturnValue({
      data: mockData({
        contentItems: [
          {
            type: 'text',
            position: 0,
            content: 'before',
            reasoningTokens: null,
            reasoningEffort: null,
          },
          {
            type: 'media',
            position: 1,
            contentItemId: 'img-mid',
            contentType: 'image',
            mimeType: 'image/png',
            sizeBytes: 1,
            width: 1,
            height: 1,
            durationMs: null,
            downloadUrl: 'https://signed.example/mid',
            expiresAt: MEDIA_URL_EXPIRES_AT,
          },
          {
            type: 'text',
            position: 2,
            content: 'after',
            reasoningTokens: null,
            reasoningEffort: null,
          },
        ],
      }),
      isLoading: false,
      isError: false,
    } as unknown as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    // Text blocks render in position order, then the media tile — text-then-media
    // like a chat assistant message (not interleaved by raw position).
    const texts = screen.getAllByTestId(TEST_IDS.markdownRenderer);
    expect(texts.map((t) => t.textContent)).toEqual(['before', 'after']);

    const media = screen.getByTestId('shared-media-img-mid');
    expect(media).toBeInTheDocument();

    const lastText = texts.at(-1)!;
    expect(lastText.compareDocumentPosition(media) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  describe('reasoning', () => {
    const TRACE = 'First I check the units, then the exponent.';
    const ANSWER = 'The slope is 16.';

    function reasoningItem(
      overrides: { reasoningTokens?: number | null; reasoningEffort?: 'high' | null } = {}
    ): Extract<LiveSharedMessage['contentItems'][number], { type: 'text' }> {
      return {
        type: 'text',
        position: 0,
        content: serializeSegments([
          { kind: 'reasoning', children: [{ kind: 'text', text: TRACE }] },
          { kind: 'text', text: ANSWER },
        ]),
        reasoningTokens: overrides.reasoningTokens ?? null,
        reasoningEffort: overrides.reasoningEffort ?? null,
      };
    }

    function renderShare(items: LiveSharedMessage['contentItems']): void {
      mockUseSharedMessage.mockReturnValue({
        data: mockData({ contentItems: items }),
        isLoading: false,
        isError: false,
      } as unknown as ReturnType<typeof useSharedMessage>);
      renderRoute(Route);
    }

    /**
     * Opens the row and blocks until the lazily-loaded markdown stack has
     * mounted. The panel appears before that stack resolves — the Suspense
     * fallback holds the raw trace — so waiting on the panel alone leaves the
     * renderer absent on a cold module graph and present on a warm one.
     */
    async function openTrace(): Promise<HTMLElement> {
      fireEvent.click(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle));
      const content = await screen.findByTestId(TEST_IDS.thinkingDisclosureContent);
      await within(content).findByTestId(TEST_IDS.markdownRenderer);
      return content;
    }

    it('renders the reasoning row closed for a shared message whose text carries reasoning', () => {
      renderShare([reasoningItem()]);

      expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveAttribute(
        'aria-expanded',
        'false'
      );
      expect(screen.queryByTestId(TEST_IDS.thinkingDisclosureContent)).not.toBeInTheDocument();
    });

    it('labels the row with the rung the shared turn ran at', () => {
      renderShare([reasoningItem({ reasoningEffort: 'high' })]);

      expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent(
        `Reasoning · ${REASONING_EFFORT_LABELS.high} effort`
      );
    });

    it('labels the row without a rung when the share records no level', () => {
      renderShare([reasoningItem()]);

      expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent('Reasoning');
      expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).not.toHaveTextContent('effort');
    });

    it('shows the whole trace when the row is expanded', async () => {
      renderShare([reasoningItem()]);

      const content = await openTrace();
      expect(within(content).getByTestId(TEST_IDS.markdownRenderer)).toHaveTextContent(TRACE);
    });

    it('shows the reasoning token count inside the opened trace', async () => {
      renderShare([reasoningItem({ reasoningTokens: 1204 })]);
      await openTrace();

      expect(screen.getByTestId(TEST_IDS.thinkingDisclosure)).toHaveTextContent(
        '1,204 reasoning tokens'
      );
    });

    it('keeps the answer body rendering the answer half alone', () => {
      // Storage doctrine: reasoning rides in the same text field, so the answer
      // body receives the parsed half and never the raw delimited text.
      renderShare([reasoningItem()]);

      const answers = screen
        .getAllByTestId(TEST_IDS.markdownRenderer)
        .map((element) => element.textContent);
      expect(answers).toEqual([ANSWER]);
    });

    it('renders no reasoning row for a shared message that carries none', () => {
      renderShare([
        {
          type: 'text',
          position: 0,
          content: ANSWER,
          reasoningTokens: null,
          reasoningEffort: null,
        },
      ]);

      expect(screen.queryByTestId(TEST_IDS.thinkingDisclosure)).not.toBeInTheDocument();
      // The text block is the answer body alone: the surface is the only element
      // a reasoning row can add here, and this message adds none of it.
      const textBlock = screen.getByTestId(TEST_IDS.markdownRenderer).parentElement;
      expect(textBlock?.childElementCount).toBe(1);
    });

    it('states withheld reasoning a share was billed for, as its author sees it', () => {
      // A turn billed for reasoning that emitted no trace is a state of the
      // message, not a page-level choice: the share publishes the same line the
      // author's transcript carries.
      renderShare([
        {
          type: 'text',
          position: 0,
          content: ANSWER,
          reasoningTokens: 900,
          reasoningEffort: 'high',
        },
      ]);

      // Anchored, not a substring: the rung supplied above is the one thing this
      // line may not carry. A public share may publish that the turn reasoned and
      // the token volume it was billed for; the effort it ran at rides only on a
      // row that has a trace to label, and no other test pins that boundary.
      expect(screen.getByTestId(TEST_IDS.reasoningNotShared)).toHaveTextContent(
        /^Reasoning not shared · 900 tokens$/
      );
    });

    it('announces nothing as live on a settled shared message', () => {
      // A share is always settled, so the surface's status states are
      // unreachable here and the page holds no live region of its own.
      renderShare([reasoningItem({ reasoningEffort: 'high' })]);

      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
  });

  it('passes hash fragment as keyBase64 to hook', () => {
    mockUseSharedMessage.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    } as ReturnType<typeof useSharedMessage>);

    renderRoute(Route);

    expect(mockUseSharedMessage).toHaveBeenCalledWith('share-from-route', 'c2hhcmUta2V5LWI2NA');
  });
});
