import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

const { envRef } = vi.hoisted(() => ({
  envRef: {
    current: { isLocalDev: false, isE2E: false } as { isLocalDev: boolean; isE2E: boolean },
  },
}));
vi.mock('@/lib/platform/env', () => ({ env: envRef.current }));
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { noticeText, serializeSegments, TEST_ID_BUILDERS, TEST_IDS } from '@hushbox/shared';
import { expectExposes } from '@hushbox/shared/test-assertions';
import { usePreInferenceActivityStore } from '@/stores/activity/pre-inference';
import { useStreamCycleActivityStore } from '@/stores/activity/stream-cycle';

// Break the import chain that requires VITE_API_URL at module load time.
// Without these mocks, frontendEnvSchema.parse() runs in src/lib/api/api.ts and
// throws ZodError, preventing every test in this file from loading.
vi.mock('@/lib/api/api', () => ({
  getApiUrl: vi.fn(() => 'http://localhost:8787'),
  ApiError: class ApiError extends Error {
    constructor(
      message: string,
      public status: number,
      public data?: unknown
    ) {
      super(message);
      this.name = 'ApiError';
    }
  },
}));

vi.mock('@/lib/api-client', () => ({
  client: {},
  fetchJson: vi.fn(),
}));

import { DECRYPTION_FAILED_MISSING_EPOCH_KEY } from '@/hooks/crypto/use-decrypted-messages';
import { usePromptBudget } from '@/hooks/billing/use-prompt-budget';
import { turnNoticeForCode, turnNoticeText } from '@/lib/chat/turn-notice';
import { MessageList, type MessageListHandle } from '@/components/chat/message/message-list';
import { renderWithProviders } from '@/test-utils/render';
import { modelSwatch } from '@/lib/utils/model-color';
import type {
  FlatScrollIntoViewLocation,
  IndexLocationWithAlign,
  VirtuosoHandle,
} from 'react-virtuoso';
import type { Message } from '@/lib/api/api';
import type { BranchSummary } from '@/lib/chat/branch-summary';
import type { ModelsData } from '@/hooks/models/models';
import type { Model } from '@hushbox/shared';

// Rendering the real message-item reaches markdown-renderer through React.lazy.
// Leaving it real scrambles that module's own coverage report: v8 records a
// lazily-imported module under a different startOffset than a static import of it,
// and vitest merges both raw range sets by URL under one offset. Markdown rendering
// is covered in markdown-renderer.test.tsx; nothing here asserts it.
vi.mock('@/components/chat/message/markdown-renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

// Mock mermaid to avoid actual rendering
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({
      svg: '<svg>Diagram</svg>',
      bindFunctions: vi.fn(),
    }),
  },
}));

// A stable snapshot, as TanStack Query returns one: `data` keeps its identity
// while the query is not refetching, so a row that receives it is not re-rendered
// by the catalog read alone. Tests that need the pre-hydration state swap the
// whole result object, which is also what the query does when data lands.
const { modelsHookCalls, modelsResult } = vi.hoisted(() => {
  interface Snapshot {
    data: ModelsData | undefined;
    isLoading: boolean;
  }
  const hydrated: Snapshot = { data: { models: [], premiumIds: new Set() }, isLoading: false };
  const pending: Snapshot = { data: undefined, isLoading: true };
  return {
    modelsHookCalls: { current: 0 },
    modelsResult: { current: hydrated, hydrated, pending },
  };
});
vi.mock('@/hooks/models/models', () => ({
  useModels: () => {
    modelsHookCalls.current += 1;
    return modelsResult.current;
  },
}));

// `MessageItem` resolves its message's content key on every render, once and
// unconditionally, so the epoch numbers this records are the rows React
// re-rendered — the observation the memoised row exists to make.
const { rowRenders } = vi.hoisted(() => ({ rowRenders: { current: [] as number[] } }));
vi.mock('@/hooks/crypto/use-decrypted-media', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/crypto/use-decrypted-media')>();
  return {
    ...actual,
    useMessageContentKey: (conversationId: string, epochNumber: number, wrapped: string) => {
      rowRenders.current.push(epochNumber);
      return actual.useMessageContentKey(conversationId, epochNumber, wrapped);
    },
  };
});

// The send gate. MessageList consults it ONCE per list (never per row) to learn
// whether re-running a turn is affordable.
const { gateRef } = vi.hoisted(() => ({
  gateRef: { current: { sendRefusal: undefined } as { sendRefusal: string | undefined } },
}));
vi.mock('@/hooks/billing/use-prompt-budget', () => ({
  usePromptBudget: vi.fn(() => gateRef.current),
}));

// Whether the markdown renderer's module has settled, as the list reads it. Ready unless a
// test holds it back; a test that flips it calls `settle`.
const { rendererGate } = vi.hoisted(() => ({
  rendererGate: { ready: true, listeners: new Set<() => void>() },
}));
vi.mock('@/components/chat/segments/segment-renderers', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/components/chat/segments/segment-renderers')>();
  const subscribe = (listener: () => void): (() => void) => {
    rendererGate.listeners.add(listener);
    return () => rendererGate.listeners.delete(listener);
  };
  return {
    ...actual,
    useMarkdownRendererReady: (): boolean =>
      React.useSyncExternalStore(subscribe, () => rendererGate.ready),
  };
});

/** Gives a jsdom element, which lays nothing out, the scroll geometry a test names. */
function setScrollGeometry(
  element: HTMLElement,
  geometry: Readonly<{ scrollHeight: number; clientHeight: number; scrollTop: number }>
): void {
  for (const [key, value] of Object.entries(geometry)) {
    Object.defineProperty(element, key, { configurable: true, value });
  }
}

function settleRenderer(): void {
  rendererGate.ready = true;
  for (const listener of rendererGate.listeners) listener();
}

// Virtuoso holds its item list hidden, through the style it hands its List, until its
// opening row is in place. The mock shows it at once unless a test holds it back; `place`
// then shows it. It holds every row unless a test limits them, as Virtuoso's first render holds
// only its seed row; `showRows` then changes how many it holds.
const { listPlacement } = vi.hoisted(() => ({
  listPlacement: {
    atMount: true,
    withoutRows: false,
    shownRows: Number.POSITIVE_INFINITY,
    place: (): void => undefined,
    showRows: (_count: number): void => undefined,
  },
}));

/** The rows the mock's List holds: none while a test asks for a shown list without rows. */
function listRows(items: React.ReactNode[], limit: number): React.ReactNode[] {
  return listPlacement.withoutRows ? [] : items.slice(0, limit);
}

let capturedVirtuosoProps: Record<string, unknown> = {};
// Module-level imperative-handle mocks so tests can observe calls across
// re-renders (useImperativeHandle's factory runs each render, so per-render
// vi.fn()s lose their call history).
const virtuosoMockHandle = {
  scrollToIndex: vi.fn(),
  scrollTo: vi.fn(),
  scrollBy: vi.fn(),
  scrollIntoView: vi.fn(),
  getState: vi.fn(),
  autoscrollToBottom: vi.fn(),
};

// Mock Virtuoso to render items directly (virtualization doesn't work in jsdom)
vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(function MockVirtuoso(
    props: Record<string, unknown>,
    ref: React.Ref<VirtuosoHandle>
  ) {
    Object.assign(capturedVirtuosoProps, props);
    const data = props['data'] as unknown[];
    const itemContent = props['itemContent'] as (index: number, item: unknown) => React.ReactNode;
    const components = props['components'] as
      | {
          Footer?: React.ComponentType<{ context: unknown }>;
          Header?: React.ComponentType<{ context: unknown }>;
          List?: React.ComponentType<React.HTMLAttributes<HTMLDivElement> & { context: unknown }>;
          Scroller?: React.ComponentType<
            React.HTMLAttributes<HTMLDivElement> &
              React.RefAttributes<HTMLDivElement> & { context: unknown }
          >;
        }
      | undefined;
    // Virtuoso mounts its Header and Footer as components and hands them the list's `context`.
    const Header = components?.Header;
    const Footer = components?.Footer;
    const scrollerRefCallback = props['scrollerRef'] as
      | ((el: HTMLElement | Window | null) => void)
      | undefined;
    React.useImperativeHandle(ref, () => virtuosoMockHandle);
    // Forward the scroller DOM node so tests can dispatch wheel/touchmove/
    // keydown events on it the way MessageList expects in production.
    const scrollerRef = React.useCallback(
      (el: HTMLDivElement | null) => {
        scrollerRefCallback?.(el);
      },
      [scrollerRefCallback]
    );
    const Scroller = components?.Scroller;
    const List = components?.List;
    const [itemsPlaced, setItemsPlaced] = React.useState(listPlacement.atMount);
    const [rowLimit, setRowLimit] = React.useState(listPlacement.shownRows);
    React.useEffect(() => {
      listPlacement.place = (): void => {
        setItemsPlaced(true);
      };
      listPlacement.showRows = (count: number): void => {
        setRowLimit(count);
      };
    }, []);
    const computeItemKey = props['computeItemKey'] as
      | ((index: number, item: unknown) => string)
      | undefined;
    const items = data.map((item, index) => (
      <div key={computeItemKey ? computeItemKey(index, item) : index}>
        {itemContent(index, item)}
      </div>
    ));
    const children = (
      <>
        {Header === undefined ? null : <Header context={props['context']} />}
        {List === undefined ? (
          items
        ) : (
          <List
            data-testid="virtuoso-item-list-mock"
            style={itemsPlaced ? {} : { visibility: 'hidden' }}
            context={props['context']}
          >
            {listRows(items, rowLimit)}
          </List>
        )}
        {Footer === undefined ? null : <Footer context={props['context']} />}
      </>
    );
    // Virtuoso hands a custom Scroller the list's `context`, as it does the Header.
    return Scroller === undefined ? (
      <div data-testid="virtuoso-mock" ref={scrollerRef}>
        {children}
      </div>
    ) : (
      <Scroller data-testid="virtuoso-mock" ref={scrollerRef} context={props['context']}>
        {children}
      </Scroller>
    );
  }),
}));

const messages = [
  {
    id: '1',
    conversationId: 'conv-1',
    role: 'user' as const,
    content: 'Hello!',
    createdAt: isoAt(TEST_DAY_START),
  },
  {
    id: '2',
    conversationId: 'conv-1',
    role: 'assistant' as const,
    content: 'Hi there!',
    createdAt: isoAt(TEST_DAY_START + SECOND_MS),
  },
  {
    id: '3',
    conversationId: 'conv-1',
    role: 'user' as const,
    content: 'How are you?',
    createdAt: isoAt(TEST_DAY_START + 2 * SECOND_MS),
  },
];

describe('MessageList', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('renders all messages', () => {
    renderWithProviders(<MessageList messages={messages} />);

    expect(screen.getByText('Hello!')).toBeInTheDocument();
    expect(screen.getByText('Hi there!')).toBeInTheDocument();
    expect(screen.getByText('How are you?')).toBeInTheDocument();
  });

  it('renders empty state when no messages', () => {
    renderWithProviders(<MessageList messages={[]} />);
    expect(screen.getByTestId('message-list-empty')).toBeInTheDocument();
  });

  it('renders role="log" on empty state so waitForConversationLoaded works', () => {
    renderWithProviders(<MessageList messages={[]} />);
    const emptyState = screen.getByTestId('message-list-empty');
    expect(emptyState).toHaveAttribute('role', 'log');
    expect(emptyState).toHaveAttribute('aria-label', 'Chat messages');
  });

  it('renders container with correct test id', () => {
    renderWithProviders(<MessageList messages={messages} />);
    expect(screen.getByTestId('message-list')).toBeInTheDocument();
  });

  it('displays messages in order', () => {
    renderWithProviders(<MessageList messages={messages} />);
    const messageItems = screen.getAllByTestId('message-item');
    expect(messageItems).toHaveLength(3);
  });

  it('container takes full height with min-h-0 for flex', () => {
    renderWithProviders(<MessageList messages={messages} />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveClass('flex-1');
    expect(container).toHaveClass('min-h-0');
  });

  it('passes streamingMessageIds to mark streaming message', () => {
    renderWithProviders(<MessageList messages={messages} streamingMessageIds={new Set(['2'])} />);
    const messageItems = screen.getAllByTestId('message-item');
    expect(messageItems).toHaveLength(3);
  });

  it('exposes data-message-count matching messages.length', () => {
    renderWithProviders(<MessageList messages={messages} />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveAttribute('data-message-count', '3');
  });

  it('exposes data-decrypted-count equal to messages.length when every message has plaintext content', () => {
    renderWithProviders(<MessageList messages={messages} />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveAttribute('data-decrypted-count', '3');
  });

  it('exposes data-at-bottom reflecting Virtuoso atBottomStateChange', () => {
    renderWithProviders(<MessageList messages={messages} />);
    const container = screen.getByTestId('message-list');
    // Pinned at the latest message on mount (initialTopMostItemIndex="LAST").
    expect(container).toHaveAttribute('data-at-bottom', 'true');

    act(() => {
      (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(false);
    });
    expect(container).toHaveAttribute('data-at-bottom', 'false');

    act(() => {
      (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(true);
    });
    expect(container).toHaveAttribute('data-at-bottom', 'true');
  });

  it('re-measures the at-bottom threshold when the viewport height changes', () => {
    const originalInnerHeight = window.innerHeight;
    try {
      Object.defineProperty(globalThis, 'innerHeight', { value: 800, configurable: true });
      renderWithProviders(<MessageList messages={messages} />);
      expect(capturedVirtuosoProps['atBottomThreshold']).toBe(100);

      // A rotation or a mobile URL-bar collapse: window.innerHeight moves, and
      // the threshold must move with it or it stops exceeding the 10dvh footer.
      Object.defineProperty(globalThis, 'innerHeight', { value: 400, configurable: true });
      act(() => {
        globalThis.dispatchEvent(new Event('resize'));
      });

      expect(capturedVirtuosoProps['atBottomThreshold']).toBe(60);
    } finally {
      Object.defineProperty(globalThis, 'innerHeight', {
        value: originalInnerHeight,
        configurable: true,
      });
    }
  });

  it('re-pins to the last row when atBottom drops while auto-follow is engaged', () => {
    renderWithProviders(<MessageList messages={messages} />);
    virtuosoMockHandle.scrollToIndex.mockClear();

    // A late last-item resize (the cost true-up badge growing the final reply
    // after the stream has settled) drops atBottom with no user scroll. Auto-
    // follow is still engaged, so the list must re-pin to the latest row —
    // Virtuoso's followOutput re-pins on new items only, not on a resize.
    act(() => {
      (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(false);
    });

    expect(virtuosoMockHandle.scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end' });
  });

  it('does not re-pin when the user scrolled away from the bottom', () => {
    renderWithProviders(<MessageList messages={messages} />);
    const scroller = screen.getByTestId('virtuoso-mock');
    virtuosoMockHandle.scrollToIndex.mockClear();

    // A real user scroll followed by atBottom dropping is the user deliberately
    // leaving the bottom — auto-follow disengages and must not yank them back.
    act(() => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(false);
    });

    expect(virtuosoMockHandle.scrollToIndex).not.toHaveBeenCalled();
  });

  it('does not re-pin while a turn is still streaming', () => {
    renderWithProviders(
      <MessageList messages={messages} streamingMessageIds={new Set(['streaming-id'])} />
    );
    virtuosoMockHandle.scrollToIndex.mockClear();

    // While streaming, Virtuoso's followOutput owns the bottom-pin; an explicit
    // re-pin here would fight its smooth follow, so the effect stays out.
    act(() => {
      (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(false);
    });

    expect(virtuosoMockHandle.scrollToIndex).not.toHaveBeenCalled();
  });

  it('re-pins when message content grows after a turn settles off the bottom', () => {
    const { rerender } = renderWithProviders(
      <MessageList messages={messages} streamingMessageIds={new Set()} />
    );
    act(() => {
      (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(false);
    });
    virtuosoMockHandle.scrollToIndex.mockClear();

    // A late cost true-up grows the last reply after streaming settled — a fresh
    // messages reference with the viewport already off the bottom and auto-follow
    // engaged must re-pin, since followOutput won't fire on an in-place growth.
    rerender(<MessageList messages={[...messages]} streamingMessageIds={new Set()} />);

    expect(virtuosoMockHandle.scrollToIndex).toHaveBeenCalledWith({ index: 'LAST', align: 'end' });
  });

  it('excludes messages with a decryption-failure fallback content from data-decrypted-count', () => {
    const partiallyDecrypted = [
      { ...messages[0]!, content: DECRYPTION_FAILED_MISSING_EPOCH_KEY },
      messages[1]!,
      messages[2]!,
    ];
    renderWithProviders(<MessageList messages={partiallyDecrypted} />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveAttribute('data-message-count', '3');
    expect(container).toHaveAttribute('data-decrypted-count', '2');
  });

  it('reports data-decrypted-count of 0 on the empty-state log', () => {
    renderWithProviders(<MessageList messages={[]} />);
    const emptyState = screen.getByTestId('message-list-empty');
    expect(emptyState).toHaveAttribute('data-decrypted-count', '0');
    expect(emptyState).toHaveAttribute('data-message-count', '0');
  });

  it('renders data-messages-ready="false" by default so tests can wait for parent readiness', () => {
    renderWithProviders(<MessageList messages={messages} />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveAttribute('data-messages-ready', 'false');
  });

  it('renders data-messages-ready="true" when the parent passes messagesReady', () => {
    renderWithProviders(<MessageList messages={messages} messagesReady />);
    const container = screen.getByTestId('message-list');
    expect(container).toHaveAttribute('data-messages-ready', 'true');
  });

  it('exposes data-messages-ready on the empty-state log too', () => {
    renderWithProviders(<MessageList messages={[]} messagesReady />);
    const emptyState = screen.getByTestId('message-list-empty');
    expect(emptyState).toHaveAttribute('data-messages-ready', 'true');
  });

  it('exposes data-message-id on every rendered message item', () => {
    renderWithProviders(<MessageList messages={messages} />);
    const messageItems = screen.getAllByTestId('message-item');
    expect(messageItems[0]).toHaveAttribute('data-message-id', '1');
    expect(messageItems[1]).toHaveAttribute('data-message-id', '2');
    expect(messageItems[2]).toHaveAttribute('data-message-id', '3');
  });

  describe('memoized message counts', () => {
    const mixed: Message[] = [
      { ...messages[0]!, id: 'm1', role: 'user', content: 'Plain user' },
      { ...messages[1]!, id: 'm2', role: 'assistant', content: 'Priced reply', cost: '0.01' },
      {
        ...messages[2]!,
        id: 'm3',
        role: 'assistant',
        content: DECRYPTION_FAILED_MISSING_EPOCH_KEY,
      },
      { ...messages[0]!, id: 'm4', role: 'assistant', content: 'Free reply' },
    ];

    it('exposes data-assistant-count equal to the number of assistant-role messages', () => {
      renderWithProviders(<MessageList messages={mixed} />);
      const container = screen.getByTestId('message-list');
      expect(container).toHaveAttribute('data-assistant-count', '3');
    });

    it('exposes data-cost-count equal to the number of messages with a non-null cost', () => {
      renderWithProviders(<MessageList messages={mixed} />);
      const container = screen.getByTestId('message-list');
      expect(container).toHaveAttribute('data-cost-count', '1');
    });

    it('exposes data-decrypted-count excluding decryption-failure fallbacks', () => {
      renderWithProviders(<MessageList messages={mixed} />);
      const container = screen.getByTestId('message-list');
      expect(container).toHaveAttribute('data-decrypted-count', '3');
    });

    it('keeps all three counts stable across a re-render with the same messages reference', () => {
      const { rerender } = renderWithProviders(<MessageList messages={mixed} />);
      const container = screen.getByTestId('message-list');
      expect(container).toHaveAttribute('data-assistant-count', '3');
      expect(container).toHaveAttribute('data-cost-count', '1');
      expect(container).toHaveAttribute('data-decrypted-count', '3');

      rerender(<MessageList messages={mixed} streamingMessageIds={new Set(['m2'])} />);
      expect(container).toHaveAttribute('data-assistant-count', '3');
      expect(container).toHaveAttribute('data-cost-count', '1');
      expect(container).toHaveAttribute('data-decrypted-count', '3');
    });
  });

  describe('streaming / error state baked into Virtuoso data', () => {
    beforeEach(() => {
      capturedVirtuosoProps = {};
    });

    it('bakes isStreaming into each row based on streamingMessageIds', () => {
      renderWithProviders(<MessageList messages={messages} streamingMessageIds={new Set(['2'])} />);
      const data = capturedVirtuosoProps['data'] as { key: string; isStreaming: boolean }[];
      expect(data).toHaveLength(3);
      const streamingRow = data.find((r) => r.key === '2');
      expect(streamingRow?.isStreaming).toBe(true);
      const nonStreamingRow = data.find((r) => r.key === '1');
      expect(nonStreamingRow?.isStreaming).toBe(false);
    });

    it('bakes isError into the row matching errorMessageId', () => {
      renderWithProviders(<MessageList messages={messages} errorMessageId="2" />);
      const data = capturedVirtuosoProps['data'] as { key: string; isError: boolean }[];
      const errorRow = data.find((r) => r.key === '2');
      expect(errorRow?.isError).toBe(true);
      const okRow = data.find((r) => r.key === '1');
      expect(okRow?.isError).toBe(false);
    });

    it('produces a new data array reference when streamingMessageIds changes', () => {
      // Regression test for the stale-isStreaming bug that caused regenerate
      // buttons to go missing after streaming completed. Baking streaming
      // state into the data array ensures Virtuoso's data-identity check sees
      // a change and re-renders items.
      const { rerender } = renderWithProviders(
        <MessageList messages={messages} streamingMessageIds={new Set(['2'])} />
      );
      const firstData = capturedVirtuosoProps['data'];

      rerender(<MessageList messages={messages} streamingMessageIds={new Set()} />);
      const secondData = capturedVirtuosoProps['data'];

      expect(firstData).not.toBe(secondData);
    });

    it('exposes data-streams-completed reflecting the stream-cycle store', () => {
      useStreamCycleActivityStore.setState({ streamsCompleted: 5 });
      renderWithProviders(<MessageList messages={messages} persistingMessageIds={new Set()} />);
      expect(screen.getByTestId('message-list')).toHaveAttribute('data-streams-completed', '5');
      act(() => {
        useStreamCycleActivityStore.setState({ streamsCompleted: 0 });
      });
    });

    it('exposes data-pre-inference-stages-seen reflecting the pre-inference store', () => {
      usePreInferenceActivityStore.setState({ preInferenceStagesSeen: 3 });
      renderWithProviders(<MessageList messages={messages} persistingMessageIds={new Set()} />);
      expect(screen.getByTestId('message-list')).toHaveAttribute(
        'data-pre-inference-stages-seen',
        '3'
      );
      act(() => {
        usePreInferenceActivityStore.setState({ preInferenceStagesSeen: 0 });
      });
    });

    // DOM attributes (test signals) read from persistingMessageIds; per-row
    // isStreaming (UX signal) reads from streamingMessageIds. The two
    // diverge during the cost-settlement window: streamingMessageIds clears
    // on the early flip so the toolbar appears immediately, but
    // persistingMessageIds stays populated until the server commits.
    it('data-streaming-count reflects persistingMessageIds, NOT streamingMessageIds', () => {
      renderWithProviders(
        <MessageList
          messages={messages}
          streamingMessageIds={new Set()}
          persistingMessageIds={new Set(['2'])}
        />
      );
      const container = screen.getByTestId('message-list');
      expect(container).toHaveAttribute('data-streaming-count', '1');
    });

    it('data-streaming-count reflects persistingMessageIds size, not streamingMessageIds', () => {
      const { rerender } = renderWithProviders(
        <MessageList
          messages={messages}
          streamingMessageIds={new Set(['2'])}
          persistingMessageIds={new Set(['2'])}
        />
      );
      const container = screen.getByTestId('message-list');
      expect(container).toHaveAttribute('data-streaming-count', '1');

      // Early flip: streamingMessageIds clears but persistingMessageIds stays —
      // the count tracks persistence (server-committed), so it stays 1.
      rerender(
        <MessageList
          messages={messages}
          streamingMessageIds={new Set()}
          persistingMessageIds={new Set(['2'])}
        />
      );
      expect(container).toHaveAttribute('data-streaming-count', '1');

      // SSE done arrives: persistingMessageIds clears.
      rerender(
        <MessageList
          messages={messages}
          streamingMessageIds={new Set()}
          persistingMessageIds={new Set()}
        />
      );
      expect(container).toHaveAttribute('data-streaming-count', '0');
    });

    it('per-row isStreaming still reads from streamingMessageIds, not persistingMessageIds', () => {
      renderWithProviders(
        <MessageList
          messages={messages}
          streamingMessageIds={new Set()}
          persistingMessageIds={new Set(['2'])}
        />
      );
      const data = capturedVirtuosoProps['data'] as { key: string; isStreaming: boolean }[];
      // Message 2 is in persisting (server hasn't committed yet) but NOT in
      // streaming (token stream ended). Per-row isStreaming should be false
      // so the toolbar renders immediately.
      const row2 = data.find((r) => r.key === '2');
      expect(row2?.isStreaming).toBe(false);
    });

    it('clearing streamingMessageIds re-renders items without isStreaming so action buttons appear', () => {
      // End-to-end check of the fix: start with an assistant message streaming
      // (no action buttons), clear streaming, action buttons should appear.
      const singleAssistant: Message[] = [
        {
          id: 'u1',
          conversationId: 'conv-1',
          role: 'user',
          content: 'hi',
          createdAt: isoAt(TEST_DAY_START),
          parentMessageId: null,
        },
        {
          id: 'a1',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'hello back',
          createdAt: isoAt(TEST_DAY_START + SECOND_MS),
          parentMessageId: 'u1',
        },
      ];
      const onRegenerate = vi.fn();

      const { rerender } = renderWithProviders(
        <MessageList
          messages={singleAssistant}
          streamingMessageIds={new Set(['a1'])}
          onRegenerate={onRegenerate}
        />
      );
      expect(screen.queryByLabelText('Regenerate')).not.toBeInTheDocument();

      rerender(
        <MessageList
          messages={singleAssistant}
          streamingMessageIds={new Set()}
          onRegenerate={onRegenerate}
        />
      );
      expect(screen.getByLabelText('Regenerate')).toBeInTheDocument();
    });
  });

  describe('a failed or refused turn', () => {
    const notice = turnNoticeForCode('UNAVAILABLE');
    const question: Message = {
      id: 'u-1',
      conversationId: 'conv-1',
      role: 'user',
      content: 'Hello!',
      createdAt: isoAt(TEST_DAY_START),
    };
    const tile: Message = {
      id: 'tile-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: turnNoticeText(notice),
      turnNotice: notice,
      createdAt: isoAt(TEST_DAY_START + SECOND_MS),
      modelName: 'test-model',
    };

    function tileRow(): HTMLElement {
      const row = screen
        .getByTestId(TEST_IDS.turnNoticeTile)
        .closest<HTMLElement>(`[data-testid="${TEST_IDS.messageItem}"]`);
      if (row === null) throw new Error('the tile sits in no message row');
      return row;
    }

    afterEach(() => {
      gateRef.current = { sendRefusal: undefined };
    });

    it('renders the notice tile with no message actions in its row', () => {
      renderWithProviders(<MessageList messages={[question, tile]} onRegenerate={vi.fn()} />);
      expect(within(tileRow()).queryByTestId(TEST_IDS.messageActions)).not.toBeInTheDocument();
    });

    it('keeps the row marked as an error', () => {
      renderWithProviders(<MessageList messages={[question, tile]} onRegenerate={vi.fn()} />);
      expect(tileRow()).toHaveAttribute('data-error', 'true');
    });

    it("renders no model tag in the tile's row", () => {
      renderWithProviders(<MessageList messages={[question, tile]} onRegenerate={vi.fn()} />);
      expect(within(tileRow()).queryByTestId(TEST_IDS.modelNametag)).not.toBeInTheDocument();
    });

    it("hands the tile's Regenerate the row's handler with the tile's id", () => {
      const onRegenerate = vi.fn();
      renderWithProviders(<MessageList messages={[question, tile]} onRegenerate={onRegenerate} />);
      fireEvent.click(within(tileRow()).getByRole('button', { name: 'Regenerate' }));
      expect(onRegenerate).toHaveBeenCalledWith('tile-1');
    });

    it("refuses the tile's Regenerate when the send verdict refuses a re-run", () => {
      gateRef.current = { sendRefusal: 'insufficient_funds' };
      renderWithProviders(<MessageList messages={[question, tile]} onRegenerate={vi.fn()} />);
      expect(within(tileRow()).getByRole('button', { name: 'Regenerate' })).toHaveAttribute(
        'aria-disabled',
        'true'
      );
    });

    it('offers no Regenerate on the tile to a viewer who may not re-run a turn', () => {
      renderWithProviders(
        <MessageList
          messages={[question, tile]}
          onRegenerate={vi.fn()}
          isGroupChat
          callerPrivilege="read"
          currentUserId="viewer"
        />
      );
      expect(
        within(tileRow()).queryByRole('button', { name: 'Regenerate' })
      ).not.toBeInTheDocument();
    });

    it('prices a re-run without the notice row', () => {
      vi.mocked(usePromptBudget).mockClear();
      renderWithProviders(<MessageList messages={[question, tile]} onRegenerate={vi.fn()} />);
      expect(vi.mocked(usePromptBudget).mock.calls[0]?.[0]).toMatchObject({
        historyCharacters: 'Hello!'.length,
      });
    });
  });

  describe("a watcher's tile waiting for its stored row", () => {
    const answer: Message = {
      id: 'srv-1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'The finished answer',
      createdAt: '',
    };

    // The assistant nameplate reads the conversation's queries, so the list renders
    // inside a query client, as the page provides one.
    function renderRow(row: Message): void {
      render(
        <QueryClientProvider client={new QueryClient()}>
          <MessageList messages={[row]} onRegenerate={vi.fn()} onFork={vi.fn()} onShare={vi.fn()} />
        </QueryClientProvider>
      );
    }

    it('renders no message actions on the tile waiting for its stored row', () => {
      renderRow({ ...answer, awaitingStoredRow: true });

      expect(screen.getByText('The finished answer')).toBeInTheDocument();
      for (const label of ['Copy', 'Regenerate', 'Fork', 'Share']) {
        expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
      }
    });

    it('renders the message actions on the stored row that replaces the tile', () => {
      renderRow(answer);

      expect(screen.getByLabelText('Copy')).toBeInTheDocument();
      expect(screen.getByLabelText('Fork')).toBeInTheDocument();
      expect(screen.getByLabelText('Share')).toBeInTheDocument();
    });
  });

  describe('a message whose sender deleted their account', () => {
    const deletedUserMessage: Message = {
      id: 'u1',
      conversationId: 'conv-1',
      role: 'user',
      content: '',
      createdAt: '',
      parentMessageId: null,
      deleted: true,
    };
    const withDeletedParent: Message[] = [
      deletedUserMessage,
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'a reply to words that are gone',
        createdAt: '',
        parentMessageId: 'u1',
      },
    ];

    it('offers no Regenerate on an assistant reply whose parent message is deleted', () => {
      renderWithProviders(<MessageList messages={withDeletedParent} onRegenerate={vi.fn()} />);

      expect(screen.getByText('a reply to words that are gone')).toBeInTheDocument();
      expect(screen.queryByLabelText('Regenerate')).not.toBeInTheDocument();
    });

    it('keeps the other actions on an assistant reply whose parent message is deleted', () => {
      renderWithProviders(
        <MessageList messages={withDeletedParent} onRegenerate={vi.fn()} onFork={vi.fn()} />
      );

      expect(screen.getByLabelText('Fork')).toBeInTheDocument();
      expect(screen.getByLabelText('Copy')).toBeInTheDocument();
    });

    it('keeps Retry on a user message whose parent message is deleted', () => {
      const userAfterDeleted: Message[] = [
        deletedUserMessage,
        {
          id: 'u2',
          conversationId: 'conv-1',
          role: 'user',
          content: 'my own words',
          createdAt: '',
          parentMessageId: 'u1',
        },
      ];

      renderWithProviders(<MessageList messages={userAfterDeleted} onRegenerate={vi.fn()} />);

      expect(screen.getByLabelText('Retry')).toBeInTheDocument();
    });

    it('counts a deleted message as decrypted', () => {
      renderWithProviders(<MessageList messages={withDeletedParent} />);

      expect(screen.getByTestId('message-list')).toHaveAttribute('data-decrypted-count', '2');
    });
  });

  describe('regenerate reads the send verdict', () => {
    afterEach(() => {
      gateRef.current = { sendRefusal: undefined };
    });

    it('enables Regenerate for a premium model a free-tier payer can afford', () => {
      // The entitlement half only. A re-run does not re-buy premium access, so a
      // free-tier payer whose money is fine keeps the affordance — without this
      // the server-side exemption is unreachable from the UI.
      gateRef.current = { sendRefusal: 'premium_requires_credit' };
      renderWithProviders(<MessageList messages={messages} onRegenerate={vi.fn()} />);
      expect(screen.getByLabelText('Regenerate')).not.toHaveAttribute('aria-disabled');
    });

    it('disables Regenerate when the payer cannot afford the turn', () => {
      gateRef.current = { sendRefusal: 'insufficient_funds' };
      renderWithProviders(<MessageList messages={messages} onRegenerate={vi.fn()} />);
      expect(screen.getByLabelText('Regenerate')).toHaveAttribute('aria-disabled', 'true');
    });

    it('disables Regenerate with the transient reason while a run holds the funds', () => {
      gateRef.current = { sendRefusal: 'funds_held_by_run' };
      renderWithProviders(<MessageList messages={messages} onRegenerate={vi.fn()} />);
      const button = screen.getByLabelText('Regenerate');
      expect(button).toHaveAttribute('aria-disabled', 'true');
      const describedBy = button.getAttribute('aria-describedby');
      expect(document.querySelector(`#${describedBy ?? ''}`)).toHaveTextContent(
        noticeText('funds_held_by_run')
      );
    });

    it('prices the re-run against the conversation and the caller’s privilege', () => {
      // Both name the PAYER: the conversation decides whose wallet is compared,
      // and the privilege decides whether a group budget is read at all. Dropping
      // either misprices a group member's re-run.
      vi.mocked(usePromptBudget).mockClear();
      renderWithProviders(
        <MessageList messages={messages} onRegenerate={vi.fn()} callerPrivilege="write" />
      );
      expect(vi.mocked(usePromptBudget).mock.calls[0]?.[0]).toMatchObject({
        value: '',
        conversationId: 'conv-1',
        currentUserPrivilege: 'write',
      });
    });

    it('prices the re-run over the answer alone when an assistant turn embeds reasoning', () => {
      vi.mocked(usePromptBudget).mockClear();
      const withReasoning = messages.map((m) =>
        m.id === '2'
          ? {
              ...m,
              content: serializeSegments([
                { kind: 'reasoning', children: [{ kind: 'text', text: 'chain of thought' }] },
                { kind: 'text', text: m.content },
              ]),
            }
          : m
      );
      renderWithProviders(<MessageList messages={withReasoning} onRegenerate={vi.fn()} />);
      expect(vi.mocked(usePromptBudget).mock.calls[0]?.[0]).toMatchObject({
        historyCharacters: 'Hello!'.length + 'Hi there!'.length + 'How are you?'.length,
      });
    });

    it('consults the gate once for the whole list, never once per row', () => {
      vi.mocked(usePromptBudget).mockClear();
      renderWithProviders(<MessageList messages={messages} onRegenerate={vi.fn()} />);
      const rows = screen.getAllByTestId('message-item').length;
      expect(rows).toBeGreaterThan(1);
      expect(vi.mocked(usePromptBudget).mock.calls.length).toBeLessThan(rows);
    });

    function gateInput(): Parameters<typeof usePromptBudget>[0] | undefined {
      return vi.mocked(usePromptBudget).mock.calls[0]?.[0];
    }

    describe('a viewer whose row grants no re-run never consults the gate', () => {
      it('for a signed-in message-link reader', () => {
        vi.mocked(usePromptBudget).mockClear();
        renderWithProviders(
          <MessageList messages={messages} isMessageLink isAuthenticated currentUserId="reader-1" />
        );
        expect(usePromptBudget).not.toHaveBeenCalled();
      });

      it('for a signed-out message-link reader', () => {
        vi.mocked(usePromptBudget).mockClear();
        renderWithProviders(
          <MessageList messages={messages} isMessageLink isAuthenticated={false} />
        );
        expect(usePromptBudget).not.toHaveBeenCalled();
      });

      it('for a group member who may only read', () => {
        vi.mocked(usePromptBudget).mockClear();
        renderWithProviders(
          <MessageList messages={messages} isGroupChat currentUserId="u1" callerPrivilege="read" />
        );
        expect(usePromptBudget).not.toHaveBeenCalled();
      });

      it('for a read-link guest', () => {
        vi.mocked(usePromptBudget).mockClear();
        renderWithProviders(
          <MessageList
            messages={messages}
            isAuthenticated={false}
            isLinkGuest
            callerPrivilege="read"
          />
        );
        expect(usePromptBudget).not.toHaveBeenCalled();
      });

      it('for a write-link guest', () => {
        vi.mocked(usePromptBudget).mockClear();
        renderWithProviders(
          <MessageList
            messages={messages}
            isAuthenticated={false}
            isLinkGuest
            callerPrivilege="write"
          />
        );
        expect(usePromptBudget).not.toHaveBeenCalled();
      });
    });

    describe('a viewer whose row grants a re-run prices it as before', () => {
      it('for a group member who may write', () => {
        vi.mocked(usePromptBudget).mockClear();
        renderWithProviders(
          <MessageList messages={messages} isGroupChat currentUserId="u1" callerPrivilege="write" />
        );
        expect(gateInput()).toMatchObject({
          conversationId: 'conv-1',
          currentUserPrivilege: 'write',
        });
      });

      it('for a trial visitor, who names no privilege', () => {
        vi.mocked(usePromptBudget).mockClear();
        renderWithProviders(<MessageList messages={messages} isAuthenticated={false} />);
        expect(gateInput()).toMatchObject({ conversationId: 'conv-1' });
        expect(gateInput()).not.toHaveProperty('currentUserPrivilege');
      });
    });
  });

  describe('the regenerate gate', () => {
    afterEach(() => {
      gateRef.current = { sendRefusal: undefined };
    });

    it('is consulted in an empty thread and stays the same gate when the first message arrives', () => {
      const implementation = vi.mocked(usePromptBudget).getMockImplementation();
      if (implementation === undefined) throw new Error('the gate double has no implementation');
      const consult = implementation;
      const gates = new Set<object>();
      function useCountedGate(
        input: Parameters<typeof usePromptBudget>[0]
      ): ReturnType<typeof usePromptBudget> {
        const [gate] = React.useState(() => ({}));
        gates.add(gate);
        return consult(input);
      }
      vi.mocked(usePromptBudget).mockImplementation(useCountedGate);
      try {
        const { rerender } = renderWithProviders(
          <MessageList messages={[]} onRegenerate={vi.fn<(messageId: string) => void>()} />
        );
        expect(gates.size).toBe(1);

        rerender(
          <MessageList messages={messages} onRegenerate={vi.fn<(messageId: string) => void>()} />
        );
        expect(gates.size).toBe(1);
      } finally {
        vi.mocked(usePromptBudget).mockImplementation(consult);
      }
    });

    it('commits its refusal to the list before the browser paints', () => {
      // An empty thread schedules no layout-effect update of its own, so a refusal reported in a
      // layout effect is the one nested commit: React commits it before paint. Reported from a
      // passive effect, it would be a plain update, after paint.
      function phasesWith(sendRefusal?: string): string[] {
        gateRef.current = { sendRefusal };
        const phases: string[] = [];
        const { unmount } = renderWithProviders(
          <React.Profiler
            id="message-list"
            onRender={(_id, phase) => {
              phases.push(phase);
            }}
          >
            <MessageList messages={[]} onRegenerate={vi.fn<(messageId: string) => void>()} />
          </React.Profiler>
        );
        unmount();
        return phases;
      }

      expect(phasesWith()).toEqual(['mount']);
      expect(phasesWith('insufficient_funds')).toEqual(['mount', 'nested-update']);
    });
  });

  describe('a grant that changes while the list is mounted', () => {
    const handlers = {
      onShare: vi.fn<(messageId: string) => void>(),
      onRegenerate: vi.fn<(messageId: string) => void>(),
      onEdit: vi.fn<(messageId: string, content: string) => void>(),
      onFork: vi.fn<(messageId: string) => void>(),
    };

    it('consults the gate and offers Regenerate once a member who could only read may write', () => {
      vi.mocked(usePromptBudget).mockClear();
      const { rerender } = renderWithProviders(
        <MessageList
          messages={messages}
          isGroupChat
          currentUserId="u1"
          callerPrivilege="read"
          {...handlers}
        />
      );
      expect(usePromptBudget).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Regenerate')).not.toBeInTheDocument();

      rerender(
        <MessageList
          messages={messages}
          isGroupChat
          currentUserId="u1"
          callerPrivilege="write"
          {...handlers}
        />
      );
      expect(usePromptBudget).toHaveBeenCalled();
      expect(screen.getByLabelText('Regenerate')).toBeInTheDocument();
    });

    it("consults no gate and offers no re-run once a link guest's privilege arrives as write", () => {
      vi.mocked(usePromptBudget).mockClear();
      const { rerender } = renderWithProviders(
        <MessageList messages={messages} isAuthenticated={false} isLinkGuest {...handlers} />
      );

      rerender(
        <MessageList
          messages={messages}
          isAuthenticated={false}
          isLinkGuest
          callerPrivilege="write"
          {...handlers}
        />
      );
      expect(usePromptBudget).not.toHaveBeenCalled();
      for (const withheld of ['Regenerate', 'Retry', 'Edit', 'Fork', 'Share']) {
        expect(screen.queryByLabelText(withheld)).not.toBeInTheDocument();
      }
    });

    it('stops consulting the gate and withdraws every re-run action once a member may only read', () => {
      const { rerender } = renderWithProviders(
        <MessageList
          messages={messages}
          isGroupChat
          currentUserId="u1"
          callerPrivilege="write"
          {...handlers}
        />
      );
      expect(screen.getByLabelText('Regenerate')).toBeInTheDocument();
      vi.mocked(usePromptBudget).mockClear();

      rerender(
        <MessageList
          messages={messages}
          isGroupChat
          currentUserId="u1"
          callerPrivilege="read"
          {...handlers}
        />
      );
      expect(usePromptBudget).not.toHaveBeenCalled();
      for (const withdrawn of ['Regenerate', 'Retry', 'Edit', 'Fork', 'Share']) {
        expect(screen.queryByLabelText(withdrawn)).not.toBeInTheDocument();
      }
    });
  });

  describe('a message-link reader', () => {
    const reply: Message = {
      id: 'shared-reply',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'A shared answer',
      createdAt: isoAt(TEST_DAY_START),
    };

    it.each([
      { reader: 'signed in', isAuthenticated: true },
      { reader: 'signed out', isAuthenticated: false },
    ])('offers a $reader reader Copy alone', ({ isAuthenticated }) => {
      renderWithProviders(
        <MessageList
          messages={[reply]}
          isMessageLink
          isAuthenticated={isAuthenticated}
          onShare={vi.fn<(messageId: string) => void>()}
          onRegenerate={vi.fn<(messageId: string) => void>()}
          onEdit={vi.fn<(messageId: string, content: string) => void>()}
          onFork={vi.fn<(messageId: string) => void>()}
        />
      );
      expect(screen.getByLabelText('Copy')).toBeInTheDocument();
      for (const withheld of ['Regenerate', 'Retry', 'Edit', 'Fork', 'Share']) {
        expect(screen.queryByLabelText(withheld)).not.toBeInTheDocument();
      }
    });
  });

  describe('the thread footer', () => {
    it('renders the thread footer after the last row', () => {
      renderWithProviders(<MessageList messages={messages} threadFooter={<p>Thread footer</p>} />);
      const rows = screen.getAllByTestId(TEST_IDS.messageItem);
      const lastRow = rows.at(-1);
      if (lastRow === undefined) throw new Error('the list drew no row');
      expect(
        lastRow.compareDocumentPosition(screen.getByText('Thread footer')) &
          Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
    });

    // Inside the scroller, so it scrolls with the rows rather than sitting fixed below them.
    it('renders the thread footer inside the scroller', () => {
      renderWithProviders(<MessageList messages={messages} threadFooter={<p>Thread footer</p>} />);
      expect(screen.getByTestId('virtuoso-mock')).toContainElement(
        screen.getByText('Thread footer')
      );
    });

    it('draws the footer the caller hands it in place of the one before', () => {
      const { rerender } = renderWithProviders(
        <MessageList messages={messages} threadFooter={<p>First footer</p>} />
      );
      rerender(<MessageList messages={messages} threadFooter={<p>Second footer</p>} />);
      expect([screen.queryByText('First footer'), screen.getByText('Second footer')]).toEqual([
        null,
        expect.any(HTMLElement),
      ]);
    });

    it('renders nothing between the rows and the closing spacer when no footer is given', () => {
      renderWithProviders(<MessageList messages={messages} threadFooter={undefined} />);
      const after: (string | null)[] = [];
      let sibling = screen.getByTestId('virtuoso-item-list-mock').nextElementSibling;
      while (sibling !== null) {
        after.push(sibling.getAttribute('aria-hidden'));
        sibling = sibling.nextElementSibling;
      }
      expect(after).toEqual(['true']);
    });
  });

  describe('initial scroll position', () => {
    beforeEach(() => {
      capturedVirtuosoProps = {};
    });

    it('mounts Virtuoso with initialTopMostItemIndex pointing at the last row', () => {
      renderWithProviders(<MessageList messages={messages} />);
      expect(capturedVirtuosoProps['initialTopMostItemIndex']).toEqual({
        index: 'LAST',
        align: 'end',
      });
    });

    // Index 0 leaves the scroller at its top, so the heading above the first row is in view.
    it('opens a thread with a heading at its first row', () => {
      renderWithProviders(<MessageList messages={messages} threadHeader={<h1>Shared</h1>} />);
      expect(capturedVirtuosoProps['initialTopMostItemIndex']).toBe(0);
    });

    it('opens a thread without a heading at its end', () => {
      renderWithProviders(<MessageList messages={messages} threadHeader={undefined} />);
      expect(capturedVirtuosoProps['initialTopMostItemIndex']).toEqual({
        index: 'LAST',
        align: 'end',
      });
    });

    // A footer is no heading: the thread still opens at its end.
    it('opens a thread with a footer and no heading at its end', () => {
      renderWithProviders(
        <MessageList messages={messages} threadHeader={undefined} threadFooter={<p>Footer</p>} />
      );
      expect(capturedVirtuosoProps['initialTopMostItemIndex']).toEqual({
        index: 'LAST',
        align: 'end',
      });
    });

    it('opens a thread with a heading and a footer at its first row', () => {
      renderWithProviders(
        <MessageList
          messages={messages}
          threadHeader={<h1>Shared</h1>}
          threadFooter={<p>Footer</p>}
        />
      );
      expect(capturedVirtuosoProps['initialTopMostItemIndex']).toBe(0);
    });

    describe('a thread with a heading, after it opens at its top', () => {
      beforeEach(() => {
        virtuosoMockHandle.scrollToIndex.mockClear();
        virtuosoMockHandle.scrollTo.mockClear();
      });

      it('opens at its top again when the conversation changes', () => {
        const { rerender } = renderWithProviders(
          <MessageList messages={messages} conversationKey="a-main" threadHeader={<h1>A</h1>} />
        );
        rerender(
          <MessageList messages={messages} conversationKey="b-main" threadHeader={<h1>B</h1>} />
        );
        expect([
          virtuosoMockHandle.scrollTo.mock.calls,
          virtuosoMockHandle.scrollToIndex.mock.calls,
        ]).toEqual([[[{ top: 0 }]], []]);
      });

      it('does not follow new rows after the conversation changes', () => {
        const { rerender } = renderWithProviders(
          <MessageList messages={messages} conversationKey="a-main" threadHeader={<h1>A</h1>} />
        );
        act(() => {
          (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(true);
        });
        rerender(
          <MessageList messages={messages} conversationKey="b-main" threadHeader={<h1>B</h1>} />
        );
        expect(capturedVirtuosoProps['followOutput']).toBe(false);
      });
    });

    describe('the reveal', () => {
      // Animation frames run only when a test runs them, so it can change the scroller between a
      // reveal decision and the frames that confirm it.
      const pendingFrames = new Map<number, FrameRequestCallback>();
      let nextFrame = 0;

      function runFrames(count = 2): void {
        for (let frame = 0; frame < count; frame += 1) {
          const callbacks = [...pendingFrames.values()];
          pendingFrames.clear();
          act(() => {
            for (const callback of callbacks) callback(frame);
          });
        }
      }

      beforeEach(() => {
        listPlacement.atMount = false;
        vi.spyOn(globalThis, 'requestAnimationFrame').mockImplementation(
          (callback: FrameRequestCallback): number => {
            nextFrame += 1;
            pendingFrames.set(nextFrame, callback);
            return nextFrame;
          }
        );
        vi.spyOn(globalThis, 'cancelAnimationFrame').mockImplementation((id: number): void => {
          pendingFrames.delete(id);
        });
      });

      afterEach(() => {
        listPlacement.atMount = true;
        listPlacement.withoutRows = false;
        listPlacement.shownRows = Number.POSITIVE_INFINITY;
        rendererGate.ready = true;
        pendingFrames.clear();
        vi.mocked(globalThis.requestAnimationFrame).mockRestore();
        vi.mocked(globalThis.cancelAnimationFrame).mockRestore();
      });

      describe('a notice placed out of view', () => {
        let scrolls: IndexLocationWithAlign[] = [];

        const notice = turnNoticeForCode('UNAVAILABLE');
        const turn = (id: string, role: Message['role'], second: number): Message => ({
          id,
          conversationId: 'conv-1',
          role,
          content: `Message ${id}`,
          createdAt: isoAt(TEST_DAY_START + second * SECOND_MS),
        });
        const thread: Message[] = [
          turn('q-1', 'user', 0),
          turn('a-1', 'assistant', 1),
          turn('q-2', 'user', 2),
          turn('a-2', 'assistant', 3),
        ];
        const tile: Message = {
          ...turn('tile-1', 'assistant', 4),
          content: turnNoticeText(notice),
          turnNotice: notice,
        };
        // The failed regenerate's notice sits after the first turn, the reply it re-ran.
        const withNotice: Message[] = [thread[0]!, thread[1]!, tile, thread[2]!, thread[3]!];

        /**
         * Has the mock's `scrollIntoView` stand the notice's row `itemTop` to `itemBottom` px down a
         * view spanning 1000 to 1600 px, and record each scroll its view location asks for, as
         * Virtuoso scrolls only when that location is not null.
         */
        function standNoticeAt(itemTop: number, itemBottom: number): void {
          virtuosoMockHandle.scrollIntoView.mockImplementation(
            (location: FlatScrollIntoViewLocation): void => {
              const { calculateViewLocation, ...locationParams } = location;
              const target = calculateViewLocation?.({
                itemTop,
                itemBottom,
                viewportTop: 1000,
                viewportBottom: 1600,
                locationParams,
              });
              if (typeof target === 'object' && target !== null) scrolls.push(target);
            }
          );
        }

        /** Opens the thread, places it and runs the frames that reveal it. */
        function openRevealed(): ReturnType<typeof renderWithProviders> {
          const opened = renderWithProviders(<MessageList messages={thread} />);
          act(() => {
            listPlacement.place();
          });
          runFrames();
          return opened;
        }

        function following(): boolean {
          return (capturedVirtuosoProps['followOutput'] as () => boolean)();
        }

        beforeEach(() => {
          scrolls = [];
          virtuosoMockHandle.scrollIntoView.mockReset();
        });

        it('brings a notice placed above the view into view', () => {
          standNoticeAt(200, 300);
          const { rerender } = openRevealed();
          rerender(<MessageList messages={withNotice} />);
          runFrames(7);
          expect(scrolls).toEqual([expect.objectContaining({ index: 2, align: 'center' })]);
        });

        it('leaves the list where it is when the notice is placed in view', () => {
          standNoticeAt(1200, 1300);
          const { rerender } = openRevealed();
          rerender(<MessageList messages={withNotice} />);
          runFrames(7);
          expect(scrolls).toEqual([]);
        });

        it('does not bring a notice into view again when the list re-renders', () => {
          standNoticeAt(200, 300);
          const { rerender } = openRevealed();
          rerender(<MessageList messages={withNotice} />);
          runFrames(7);
          rerender(<MessageList messages={[...withNotice]} />);
          runFrames(7);
          expect(virtuosoMockHandle.scrollIntoView).toHaveBeenCalledTimes(1);
        });

        // A failed regenerate's notice is first drawn at the end of the thread its run cut short,
        // and moves after its own turn once the stored replies are drawn again.
        it('brings a notice into view once it moves after its own turn', () => {
          standNoticeAt(1200, 1300);
          const { rerender } = openRevealed();
          rerender(<MessageList messages={[thread[0]!, tile]} />);
          runFrames(7);
          standNoticeAt(200, 300);
          rerender(<MessageList messages={withNotice} />);
          runFrames(7);
          expect(scrolls).toEqual([expect.objectContaining({ index: 2, align: 'center' })]);
        });

        it('counts the stillness afresh once a notice moves', () => {
          standNoticeAt(200, 300);
          const { rerender } = openRevealed();
          rerender(<MessageList messages={[thread[0]!, tile]} />);
          runFrames(5);
          rerender(<MessageList messages={withNotice} />);
          runFrames(3);
          expect(virtuosoMockHandle.scrollIntoView).not.toHaveBeenCalled();
        });

        it('waits for the scroller to stand still before judging where the notice is', () => {
          standNoticeAt(200, 300);
          const { rerender } = openRevealed();
          rerender(<MessageList messages={withNotice} />);
          runFrames(4);
          setScrollGeometry(screen.getByTestId('virtuoso-mock'), {
            scrollHeight: 3000,
            clientHeight: 500,
            scrollTop: 2500,
          });
          runFrames(6);
          expect(virtuosoMockHandle.scrollIntoView).not.toHaveBeenCalled();
        });

        it('judges the notice once the scroller has stood still for six frames', () => {
          standNoticeAt(200, 300);
          const { rerender } = openRevealed();
          rerender(<MessageList messages={withNotice} />);
          runFrames(4);
          setScrollGeometry(screen.getByTestId('virtuoso-mock'), {
            scrollHeight: 3000,
            clientHeight: 500,
            scrollTop: 2500,
          });
          runFrames(7);
          expect(virtuosoMockHandle.scrollIntoView).toHaveBeenCalledTimes(1);
        });

        it('does not bring into view a notice placed while the thread is hidden', () => {
          standNoticeAt(200, 300);
          const { rerender } = renderWithProviders(<MessageList messages={thread} />);
          rerender(<MessageList messages={withNotice} />);
          act(() => {
            listPlacement.place();
          });
          runFrames(9);
          expect(virtuosoMockHandle.scrollIntoView).not.toHaveBeenCalled();
        });

        it('still reveals a thread that gained a notice while hidden', () => {
          standNoticeAt(200, 300);
          const { rerender } = renderWithProviders(<MessageList messages={thread} />);
          rerender(<MessageList messages={withNotice} />);
          act(() => {
            listPlacement.place();
          });
          runFrames(9);
          expect(screen.getByTestId('virtuoso-mock')).not.toHaveClass('invisible');
        });

        // The list drops its scroller while the thread holds no message, and the one it mounts
        // when the messages return is hidden until it is placed again.
        it('does not bring a waiting notice into view while the thread drawn again is hidden', () => {
          standNoticeAt(200, 300);
          const { rerender } = openRevealed();
          rerender(<MessageList messages={withNotice} />);
          runFrames(3);
          rerender(<MessageList messages={[]} />);
          rerender(<MessageList messages={withNotice} />);
          runFrames(9);
          expect(virtuosoMockHandle.scrollIntoView).not.toHaveBeenCalled();
        });

        it('stops following the thread end once it brings a notice into view', () => {
          standNoticeAt(200, 300);
          const { rerender } = openRevealed();
          rerender(<MessageList messages={withNotice} />);
          runFrames(7);
          expect(following()).toBe(false);
        });

        it('keeps following the thread end when the notice was placed in view', () => {
          standNoticeAt(1200, 1300);
          const { rerender } = openRevealed();
          rerender(<MessageList messages={withNotice} />);
          runFrames(7);
          expect(following()).toBe(true);
        });

        // A smooth scroll through rows Virtuoso has not measured is cut short as it corrects their
        // heights, which strands the reader short of the notice.
        it('moves to the notice in one jump', () => {
          standNoticeAt(200, 300);
          const { rerender } = openRevealed();
          rerender(<MessageList messages={withNotice} />);
          runFrames(7);
          expect(scrolls).toEqual([expect.objectContaining({ behavior: 'auto' })]);
        });
      });

      it('keeps the thread hidden at its end until the next frames confirm it is still there', () => {
        renderWithProviders(<MessageList messages={messages} />);
        act(() => {
          listPlacement.place();
        });
        expect(screen.getByTestId('virtuoso-mock')).toHaveClass('invisible');
      });

      it('reveals the thread once its end still holds after the commit that follows', () => {
        renderWithProviders(<MessageList messages={messages} />);
        act(() => {
          listPlacement.place();
        });
        runFrames();
        expect(screen.getByTestId('virtuoso-mock')).not.toHaveClass('invisible');
      });

      it('keeps the thread hidden when its end does not hold after the commit that follows', () => {
        renderWithProviders(<MessageList messages={messages} />);
        const scroller = screen.getByTestId('virtuoso-mock');
        setScrollGeometry(scroller, { scrollHeight: 3000, clientHeight: 500, scrollTop: 2500 });
        act(() => {
          listPlacement.place();
        });
        setScrollGeometry(scroller, { scrollHeight: 3000, clientHeight: 500, scrollTop: 1200 });
        runFrames();
        expect(scroller).toHaveClass('invisible');
      });

      it('keeps the scroller hidden while Virtuoso holds its rows hidden', () => {
        renderWithProviders(<MessageList messages={messages} />);
        expect(screen.getByTestId('virtuoso-mock')).toHaveClass('invisible');
      });

      it('keeps the scroller hidden when the list reports itself at the bottom before its rows are placed', () => {
        renderWithProviders(<MessageList messages={messages} />);
        act(() => {
          (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(true);
        });
        expect(screen.getByTestId('virtuoso-mock')).toHaveClass('invisible');
      });

      it('reveals the scroller once Virtuoso shows its rows', () => {
        renderWithProviders(<MessageList messages={messages} />);
        act(() => {
          listPlacement.place();
        });
        runFrames();
        expect(screen.getByTestId('virtuoso-mock')).not.toHaveClass('invisible');
      });

      // Virtuoso can show its rows before its scroll lands: a render that blocks the main thread
      // past its settle timer marks the opening row placed while the scroller is still at the top.
      it('keeps the scroller hidden when Virtuoso shows its rows before the scroller reaches the end', () => {
        renderWithProviders(<MessageList messages={messages} />);
        const scroller = screen.getByTestId('virtuoso-mock');
        setScrollGeometry(scroller, { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
        act(() => {
          listPlacement.place();
        });
        expect(scroller).toHaveClass('invisible');
      });

      // After placement Virtuoso can render a frame whose range holds no row, at a scroll position
      // computed on estimated heights; the rows land at the end a frame later.
      it('keeps the scroller hidden while Virtuoso shows an item list that holds no row', () => {
        listPlacement.atMount = true;
        listPlacement.withoutRows = true;
        renderWithProviders(<MessageList messages={messages} />);
        expect(screen.getByTestId('virtuoso-mock')).toHaveClass('invisible');
      });

      // Virtuoso's opening scroll can end short of the end and still report success, when the rows'
      // first render blocks the main thread.
      interface Instrumented {
        scroller: HTMLElement;
        moveTo: (at: number) => void;
        rest: (at: number) => void;
        landNextScrollAt: (at: number) => void;
        writes: number[];
      }

      /** Stands the shown scroller `top` px down and records the scrolls written to it. */
      function instrument(top: number): Instrumented {
        const scroller = screen.getByTestId('virtuoso-mock');
        setScrollGeometry(scroller, { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
        const writes: number[] = [];
        let scrollTop = top;
        let landings: number[] = [];
        Object.defineProperty(scroller, 'scrollTop', {
          configurable: true,
          get: (): number => scrollTop,
          // A browser clamps a scroll to the scroller's end; a test can clamp one further back.
          set: (value: number): void => {
            writes.push(value);
            const [landing, ...later] = landings;
            landings = later;
            scrollTop = landing ?? Math.min(value, 2500);
          },
        });
        const moveTo = (at: number): void => {
          scrollTop = at;
        };
        const rest = (at: number): void => {
          const isScrolling = capturedVirtuosoProps['isScrolling'] as (scrolling: boolean) => void;
          act(() => {
            isScrolling(true);
          });
          scrollTop = at;
          act(() => {
            isScrolling(false);
          });
        };
        const landNextScrollAt = (at: number): void => {
          landings = [...landings, at];
        };
        return { scroller, moveTo, rest, landNextScrollAt, writes };
      }

      /** Opens a list whose hidden scroller shows its rows `top` px down, recording scroll writes. */
      function openAt(top: number): Instrumented & { rerender: (ui: React.ReactElement) => void } {
        const { rerender } = renderWithProviders(<MessageList messages={messages} />);
        const opened = instrument(top);
        act(() => {
          listPlacement.place();
        });
        return { ...opened, rerender };
      }

      /** Opens a list whose hidden scroller shows its rows and then comes to rest `top` px down. */
      function restShort(top: number): ReturnType<typeof openAt> {
        const opened = openAt(0);
        opened.rest(top);
        return opened;
      }

      /** Opens a list whose hidden scroller shows its rows at its end. */
      function openAtEnd(): ReturnType<typeof openAt> {
        return openAt(2500);
      }

      it('scrolls a thread whose end did not hold to its end at its next rest', () => {
        const { moveTo, rest, writes } = openAtEnd();
        moveTo(1200);
        runFrames();
        rest(1200);
        expect(writes).toEqual([3000]);
      });

      it('reveals a thread that slipped short of its end and came to rest while its end was being confirmed', () => {
        const { scroller, moveTo, rest } = openAtEnd();
        moveTo(1200);
        rest(1200);
        runFrames();
        fireEvent.scroll(scroller);
        runFrames();
        expect(scroller).not.toHaveClass('invisible');
      });

      it('counts a scroller left short of its end without moving for six frames as at rest', () => {
        const { writes } = openAt(0);
        runFrames(7);
        expect(writes).toEqual([3000]);
      });

      it('reveals a pinned thread that stays still short of its end', () => {
        const { scroller, moveTo } = restShort(1500);
        moveTo(2000);
        // Frames for a rest where it slipped and the confirmation that pins it again, then for a
        // rest at the end and the confirmation that reveals it.
        runFrames(20);
        expect(scroller).not.toHaveClass('invisible');
      });

      it('never scrolls a revealed thread that later comes to rest short of its end', () => {
        const { moveTo, rest, writes } = openAtEnd();
        // Frames for the reveal, then for any check a render after it may start.
        runFrames(4);
        moveTo(1200);
        runFrames(4);
        rest(1200);
        expect(writes).toEqual([]);
      });

      it('scrolls a hidden thread to its end when it first comes to rest short of it', () => {
        const { writes } = restShort(1500);
        expect(writes).toEqual([3000]);
      });

      it('keeps the thread hidden when it first comes to rest short of the end', () => {
        const { scroller } = restShort(1500);
        expect(scroller).toHaveClass('invisible');
      });

      /** Pins a hidden thread `count` times, each pin clamped back to `at` and then at rest there. */
      function pinClampedBack(count: number, at: number): ReturnType<typeof openAt> {
        const opened = openAt(0);
        for (let pin = 0; pin < count; pin += 1) opened.landNextScrollAt(at);
        opened.rest(at);
        for (let pin = 1; pin < count; pin += 1) {
          opened.rest(at);
          runFrames();
        }
        return opened;
      }

      it('pins a hidden thread again when its first pin is clamped back short of the end', () => {
        const { rest, writes } = pinClampedBack(1, 1800);
        rest(1800);
        runFrames();
        expect(writes).toEqual([3000, 3000]);
      });

      it('opens a thread at its end when its first pin is clamped back', () => {
        const { scroller, rest } = pinClampedBack(1, 1800);
        rest(1800);
        runFrames();
        fireEvent.scroll(scroller);
        runFrames();
        expect([scroller.classList.contains('invisible'), scroller.scrollTop]).toEqual([
          false,
          2500,
        ]);
      });

      it('pins a hidden thread at most three times per opening', () => {
        const { rest, writes } = pinClampedBack(3, 1800);
        rest(1800);
        runFrames();
        expect(writes).toEqual([3000, 3000, 3000]);
      });

      it('reveals the thread where it next comes to rest after its third pin, short of the end or not', () => {
        const { scroller, rest } = pinClampedBack(3, 1800);
        rest(1800);
        runFrames();
        expect(scroller).not.toHaveClass('invisible');
      });

      it('scrolls a thread that mounts anew to its end at its first rest short of it', () => {
        const { rest, rerender } = pinClampedBack(3, 1800);
        rest(1800);
        runFrames();
        rerender(<MessageList messages={[]} />);
        rerender(<MessageList messages={messages} />);
        const again = instrument(0);
        act(() => {
          listPlacement.place();
        });
        again.rest(1500);
        expect(again.writes).toEqual([3000]);
      });

      it('waits for a new rest when a decision taken at rest loses its place', () => {
        const { moveTo, rest, landNextScrollAt, writes } = openAt(0);
        landNextScrollAt(1800);
        rest(1500);
        rest(1800);
        moveTo(1700);
        runFrames(4);
        expect(writes).toEqual([3000]);
      });

      it('never scrolls a revealed thread whose rows were not shown when it was revealed', () => {
        const { moveTo, rest, writes } = openAtEnd();
        listPlacement.withoutRows = true;
        runFrames();
        moveTo(1200);
        rest(1200);
        expect(writes).toEqual([]);
      });

      it('keeps a thread short of the end hidden while its scroll is still moving', () => {
        renderWithProviders(<MessageList messages={messages} />);
        const scroller = screen.getByTestId('virtuoso-mock');
        const isScrolling = capturedVirtuosoProps['isScrolling'] as (scrolling: boolean) => void;
        setScrollGeometry(scroller, { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
        act(() => {
          listPlacement.place();
        });
        act(() => {
          isScrolling(true);
        });
        setScrollGeometry(scroller, { scrollHeight: 3000, clientHeight: 500, scrollTop: 1500 });
        fireEvent.scroll(scroller);
        expect(scroller).toHaveClass('invisible');
      });

      it('ignores a scroll that came to rest before Virtuoso showed its rows', () => {
        renderWithProviders(<MessageList messages={messages} />);
        const scroller = screen.getByTestId('virtuoso-mock');
        const isScrolling = capturedVirtuosoProps['isScrolling'] as (scrolling: boolean) => void;
        setScrollGeometry(scroller, { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
        act(() => {
          isScrolling(true);
        });
        act(() => {
          isScrolling(false);
        });
        act(() => {
          listPlacement.place();
        });
        expect(scroller).toHaveClass('invisible');
      });

      it('reveals the scroller once it scrolls to the end after Virtuoso shows its rows', () => {
        renderWithProviders(<MessageList messages={messages} />);
        const scroller = screen.getByTestId('virtuoso-mock');
        setScrollGeometry(scroller, { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
        act(() => {
          listPlacement.place();
        });
        setScrollGeometry(scroller, { scrollHeight: 3000, clientHeight: 500, scrollTop: 2500 });
        fireEvent.scroll(scroller);
        runFrames();
        expect(scroller).not.toHaveClass('invisible');
      });

      it('reveals a thread whose rows Virtuoso shows at once without waiting for an at-bottom report', () => {
        listPlacement.atMount = true;
        renderWithProviders(<MessageList messages={messages} />);
        runFrames();
        expect(screen.getByTestId('virtuoso-mock')).not.toHaveClass('invisible');
      });

      describe('a thread with a heading', () => {
        const heading = <h1 data-testid="thread-head">Shared</h1>;

        /** Opens a thread with a heading whose rows Virtuoso shows at its top, far from its end. */
        function openWithHeading(): Instrumented {
          renderWithProviders(<MessageList messages={messages} threadHeader={heading} />);
          const opened = instrument(0);
          act(() => {
            listPlacement.place();
          });
          return opened;
        }

        it('reveals the thread at its top in the frame Virtuoso shows its rows', () => {
          const { scroller } = openWithHeading();
          expect([scroller.classList.contains('invisible'), scroller.scrollTop]).toEqual([
            false,
            0,
          ]);
        });

        it('leaves no hidden ancestor above its heading once its rows show', () => {
          openWithHeading();
          expect(screen.getByTestId('thread-head').closest('.invisible')).toBeNull();
        });

        it('tells its host the thread is revealed without an at-bottom report or a rest', () => {
          const onRevealedChange = vi.fn<(revealed: boolean) => void>();
          renderWithProviders(
            <MessageList
              messages={messages}
              threadHeader={heading}
              onRevealedChange={onRevealedChange}
            />
          );
          instrument(0);
          act(() => {
            listPlacement.place();
          });
          expect(onRevealedChange).toHaveBeenLastCalledWith(true);
        });

        /** Opens a thread with a heading whose first render holds only its seed row, in view. */
        function openWithSeedRowInView(): Instrumented {
          listPlacement.shownRows = 1;
          renderWithProviders(<MessageList messages={messages} threadHeader={heading} />);
          const opened = instrument(0);
          setScrollGeometry(opened.scroller, {
            scrollHeight: 500,
            clientHeight: 500,
            scrollTop: 0,
          });
          act(() => {
            listPlacement.place();
          });
          return opened;
        }

        // The footer below a seed row that ends in view moves down as the other rows land.
        it('keeps the thread hidden while its seed row alone ends inside the view', () => {
          const { scroller } = openWithSeedRowInView();
          expect(scroller).toHaveClass('invisible');
        });

        // Virtuoso reports that it is not scrolling as soon as it mounts, which is no rest.
        it('keeps the thread hidden when Virtuoso reports no scroll while its seed row alone ends inside the view', () => {
          const { scroller } = openWithSeedRowInView();
          act(() => {
            (capturedVirtuosoProps['isScrolling'] as (scrolling: boolean) => void)(false);
          });
          expect(scroller).toHaveClass('invisible');
        });

        it('reveals the thread once its rows run past the view', () => {
          const { scroller } = openWithSeedRowInView();
          setScrollGeometry(scroller, { scrollHeight: 3000, clientHeight: 500, scrollTop: 0 });
          act(() => {
            listPlacement.showRows(2);
          });
          expect(scroller).not.toHaveClass('invisible');
        });

        it('reveals the thread once every row is shown, though all of them fit the view', () => {
          const { scroller } = openWithSeedRowInView();
          act(() => {
            listPlacement.showRows(messages.length);
          });
          expect(scroller).not.toHaveClass('invisible');
        });

        it('stays at its top when its seed row is reported at the bottom before the reveal', () => {
          openWithSeedRowInView();
          virtuosoMockHandle.scrollToIndex.mockClear();
          const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
            atBottom: boolean
          ) => void;
          act(() => {
            atBottomStateChange(true);
          });
          act(() => {
            atBottomStateChange(false);
          });
          expect(virtuosoMockHandle.scrollToIndex).not.toHaveBeenCalled();
        });

        it('follows new rows when its end is in view as it is revealed', () => {
          openWithSeedRowInView();
          act(() => {
            listPlacement.showRows(messages.length);
          });
          const followOutput = capturedVirtuosoProps['followOutput'] as (
            isAtBottom: boolean
          ) => boolean;
          expect(followOutput(false)).toBe(true);
        });

        it('reveals the thread at its first rest when its rows never fill the view', () => {
          const { scroller } = openWithSeedRowInView();
          runFrames(7);
          expect(scroller).not.toHaveClass('invisible');
        });

        it('stays at its top when Virtuoso reports it is not at the bottom', () => {
          openWithHeading();
          virtuosoMockHandle.scrollToIndex.mockClear();
          act(() => {
            (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(false);
          });
          expect(virtuosoMockHandle.scrollToIndex).not.toHaveBeenCalled();
        });

        // Virtuoso scrolls to the end of a list that grows while it is not there unless
        // `followOutput` is false.
        it('hands Virtuoso no output to follow while the reader has not reached its end', () => {
          openWithHeading();
          expect(capturedVirtuosoProps['followOutput']).toBe(false);
        });

        // Virtuoso's at-bottom report is throttled, so the one it computed for its seed row can
        // arrive after the thread is revealed at its top.
        it('stays at its top when an at-bottom report arrives after the reveal while it is at its top', () => {
          openWithHeading();
          virtuosoMockHandle.scrollToIndex.mockClear();
          const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
            atBottom: boolean
          ) => void;
          act(() => {
            atBottomStateChange(true);
          });
          act(() => {
            atBottomStateChange(false);
          });
          expect(virtuosoMockHandle.scrollToIndex).not.toHaveBeenCalled();
        });

        it('follows new rows once the reader reaches its end', () => {
          const { moveTo } = openWithHeading();
          moveTo(2500);
          act(() => {
            (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(true);
          });
          const followOutput = capturedVirtuosoProps['followOutput'] as (
            isAtBottom: boolean
          ) => boolean;
          expect(followOutput(false)).toBe(true);
        });

        it('hands Virtuoso no output to follow when the list mounts anew after emptying', () => {
          const { rerender } = renderWithProviders(
            <MessageList messages={messages} threadHeader={heading} />
          );
          act(() => {
            listPlacement.place();
          });
          act(() => {
            (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(true);
          });
          rerender(<MessageList messages={[]} threadHeader={heading} />);
          rerender(<MessageList messages={messages} threadHeader={heading} />);
          expect(capturedVirtuosoProps['followOutput']).toBe(false);
        });

        it('never scrolls the thread to its end when it comes to rest at its top', () => {
          const { rest, writes } = openWithHeading();
          rest(0);
          runFrames(7);
          expect(writes).toEqual([]);
        });

        it('reveals the thread again at its top when the list mounts anew after emptying', () => {
          const { rerender } = renderWithProviders(
            <MessageList messages={messages} threadHeader={heading} />
          );
          act(() => {
            listPlacement.place();
          });
          rerender(<MessageList messages={[]} threadHeader={heading} />);
          rerender(<MessageList messages={messages} threadHeader={heading} />);
          const again = instrument(0);
          act(() => {
            listPlacement.place();
          });
          expect(again.scroller).not.toHaveClass('invisible');
        });
      });

      it('mounts no thread while the markdown renderer is still loading', () => {
        rendererGate.ready = false;
        renderWithProviders(<MessageList messages={messages} />);
        expect(screen.queryByTestId('virtuoso-mock')).not.toBeInTheDocument();
      });

      it('reveals the thread once the markdown renderer has loaded and Virtuoso has placed it', () => {
        rendererGate.ready = false;
        renderWithProviders(<MessageList messages={messages} />);
        act(() => {
          settleRenderer();
        });
        act(() => {
          listPlacement.place();
        });
        runFrames();
        expect(screen.getByTestId('virtuoso-mock')).not.toHaveClass('invisible');
      });

      it('keeps the scroller shown when the reader later scrolls away from the bottom', () => {
        renderWithProviders(<MessageList messages={messages} />);
        act(() => {
          listPlacement.place();
        });
        runFrames();
        act(() => {
          (capturedVirtuosoProps['atBottomStateChange'] as (atBottom: boolean) => void)(false);
        });
        expect(screen.getByTestId('virtuoso-mock')).not.toHaveClass('invisible');
      });

      it('tells its host the thread is hidden until Virtuoso places it', () => {
        const onRevealedChange = vi.fn<(revealed: boolean) => void>();
        renderWithProviders(
          <MessageList messages={messages} onRevealedChange={onRevealedChange} />
        );
        expect(onRevealedChange).toHaveBeenLastCalledWith(false);
      });

      it('tells its host once the thread is revealed', () => {
        const onRevealedChange = vi.fn<(revealed: boolean) => void>();
        renderWithProviders(
          <MessageList messages={messages} onRevealedChange={onRevealedChange} />
        );
        act(() => {
          listPlacement.place();
        });
        runFrames();
        expect(onRevealedChange).toHaveBeenLastCalledWith(true);
      });

      it('tells its host the thread is hidden again when the list mounts anew after emptying', () => {
        const onRevealedChange = vi.fn<(revealed: boolean) => void>();
        const { rerender } = renderWithProviders(
          <MessageList messages={messages} onRevealedChange={onRevealedChange} />
        );
        act(() => {
          listPlacement.place();
        });
        runFrames();
        rerender(<MessageList messages={[]} onRevealedChange={onRevealedChange} />);
        rerender(<MessageList messages={messages} onRevealedChange={onRevealedChange} />);
        expect(onRevealedChange).toHaveBeenLastCalledWith(false);
      });

      it('reveals the thread again when the list mounts anew after emptying', () => {
        const { rerender } = renderWithProviders(<MessageList messages={messages} />);
        act(() => {
          listPlacement.place();
        });
        runFrames();
        rerender(<MessageList messages={[]} />);
        rerender(<MessageList messages={messages} />);
        act(() => {
          listPlacement.place();
        });
        runFrames();
        expect(screen.getByTestId('virtuoso-mock')).not.toHaveClass('invisible');
      });

      it('hides the scroller again when the list mounts anew after emptying', () => {
        const { rerender } = renderWithProviders(<MessageList messages={messages} />);
        act(() => {
          listPlacement.place();
        });
        runFrames();
        rerender(<MessageList messages={[]} />);
        rerender(<MessageList messages={messages} />);
        expect(screen.getByTestId('virtuoso-mock')).toHaveClass('invisible');
      });

      describe('while the fonts its rows use are loading', () => {
        /** The part of the document's font set the list reads. */
        type FontSetContract = Pick<
          FontFaceSet,
          'status' | 'addEventListener' | 'removeEventListener'
        >;

        class FakeFontSet extends EventTarget implements FontSetContract {
          status: FontFaceSetLoadStatus = 'loading';
          /** The listeners attached now, by event. */
          readonly listening = new Set<string>();

          override addEventListener(
            type: string,
            listener: EventListenerOrEventListenerObject | null
          ): void {
            this.listening.add(type);
            super.addEventListener(type, listener);
          }

          override removeEventListener(
            type: string,
            listener: EventListenerOrEventListenerObject | null
          ): void {
            this.listening.delete(type);
            super.removeEventListener(type, listener);
          }
        }

        let fonts: FakeFontSet;

        beforeEach(() => {
          fonts = new FakeFontSet();
          Object.defineProperty(document, 'fonts', { configurable: true, value: fonts });
        });

        // A wait a test left running reveals its thread when its 2 s run out, an update to apply
        // under act before the suite flushes its remaining timers outside it.
        afterEach(() => {
          act(() => {
            vi.runOnlyPendingTimers();
          });
          Reflect.deleteProperty(document, 'fonts');
        });

        function finishFonts(event: 'loadingdone' | 'loadingerror'): void {
          act(() => {
            fonts.status = 'loaded';
            fonts.dispatchEvent(new Event(event));
          });
        }

        function advance(ms: number): void {
          act(() => {
            vi.advanceTimersByTime(ms);
          });
        }

        /** Opens a list whose thread Virtuoso places at its end while the fonts load. */
        function placeAtEnd(): void {
          renderWithProviders(<MessageList messages={messages} />);
          act(() => {
            listPlacement.place();
          });
          runFrames();
        }

        it('keeps a placed thread hidden while the fonts its rows requested are loading', () => {
          placeAtEnd();
          expect(screen.getByTestId('virtuoso-mock')).toHaveClass('invisible');
        });

        /** Whether the scroller is hidden before `settle` runs, and after it and the frames that follow. */
        function hiddenAcross(settle: () => void): [boolean, boolean] {
          const scroller = screen.getByTestId('virtuoso-mock');
          const before = scroller.classList.contains('invisible');
          settle();
          runFrames();
          return [before, scroller.classList.contains('invisible')];
        }

        it('reveals the thread when its fonts finish loading', () => {
          placeAtEnd();
          expect(
            hiddenAcross(() => {
              finishFonts('loadingdone');
            })
          ).toEqual([true, false]);
        });

        it('reveals the thread when a font fails to load', () => {
          placeAtEnd();
          expect(
            hiddenAcross(() => {
              finishFonts('loadingerror');
            })
          ).toEqual([true, false]);
        });

        it('keeps the thread hidden just short of 2 s after its rows show when fonts never settle', () => {
          placeAtEnd();
          advance(2 * SECOND_MS - 1);
          runFrames();
          expect(screen.getByTestId('virtuoso-mock')).toHaveClass('invisible');
        });

        it('reveals the thread 2 s after its rows show when fonts never settle', () => {
          placeAtEnd();
          expect(
            hiddenAcross(() => {
              advance(2 * SECOND_MS);
            })
          ).toEqual([true, false]);
        });

        it('counts its 2 s from when its rows first show, not from when it mounts', () => {
          renderWithProviders(<MessageList messages={messages} />);
          advance(SECOND_MS + SECOND_MS / 2);
          act(() => {
            listPlacement.place();
          });
          advance(SECOND_MS);
          runFrames();
          expect(screen.getByTestId('virtuoso-mock')).toHaveClass('invisible');
        });

        it('keeps counting its 2 s from when its rows first show when they render again', () => {
          const { rerender } = renderWithProviders(<MessageList messages={messages} />);
          act(() => {
            listPlacement.place();
          });
          advance(SECOND_MS);
          rerender(<MessageList messages={[...messages]} />);
          advance(SECOND_MS);
          runFrames();
          expect(screen.getByTestId('virtuoso-mock')).not.toHaveClass('invisible');
        });

        it('stops listening to the fonts once its thread unmounts', () => {
          const { rerender } = renderWithProviders(<MessageList messages={messages} />);
          act(() => {
            listPlacement.place();
          });
          rerender(<MessageList messages={[]} />);
          expect(fonts.listening.size).toBe(0);
        });

        it('keeps the thread hidden when its fonts start loading while its end is being confirmed', () => {
          fonts.status = 'loaded';
          renderWithProviders(<MessageList messages={messages} />);
          act(() => {
            listPlacement.place();
          });
          fonts.status = 'loading';
          runFrames();
          expect(screen.getByTestId('virtuoso-mock')).toHaveClass('invisible');
        });

        it('re-pins an end opening whose rows grew while its fonts loaded', () => {
          const { scroller, rest, writes } = openAtEnd();
          runFrames();
          rest(2500);
          Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 3200 });
          finishFonts('loadingdone');
          expect(writes).toEqual([3200]);
        });

        it('keeps a thread with a heading hidden at its top while its fonts load', () => {
          renderWithProviders(<MessageList messages={messages} threadHeader={<h1>Shared</h1>} />);
          const { scroller } = instrument(0);
          act(() => {
            listPlacement.place();
          });
          expect(scroller).toHaveClass('invisible');
        });

        it('reveals a thread with a heading at its top when its fonts finish loading', () => {
          renderWithProviders(<MessageList messages={messages} threadHeader={<h1>Shared</h1>} />);
          const { scroller } = instrument(0);
          act(() => {
            listPlacement.place();
          });
          const hiddenBefore = scroller.classList.contains('invisible');
          finishFonts('loadingdone');
          expect([
            hiddenBefore,
            scroller.classList.contains('invisible'),
            scroller.scrollTop,
          ]).toEqual([true, false, 0]);
        });

        it('reveals a thread with a heading at its top 2 s after its rows show when fonts never settle', () => {
          renderWithProviders(<MessageList messages={messages} threadHeader={<h1>Shared</h1>} />);
          const { scroller } = instrument(0);
          act(() => {
            listPlacement.place();
          });
          runFrames();
          const hiddenBefore = scroller.classList.contains('invisible');
          advance(2 * SECOND_MS);
          expect([hiddenBefore, scroller.classList.contains('invisible')]).toEqual([true, false]);
        });

        it('never waits in a document without a font set', () => {
          Reflect.deleteProperty(document, 'fonts');
          placeAtEnd();
          expect(screen.getByTestId('virtuoso-mock')).not.toHaveClass('invisible');
        });
      });
    });

    // A row swap removes the old rows before it inserts the new ones and moves the spacers; a
    // layout between the two must not see a list shorter than the one last laid out.
    describe('the item list while a commit rewrites it', () => {
      interface ListContextDouble {
        threadHeader: React.ReactNode;
        placed: boolean;
        onRowsShown: () => void;
      }
      type ListComponent = React.ComponentType<
        React.HTMLAttributes<HTMLDivElement> & { context: ListContextDouble }
      >;

      let offsetHeight: { mockRestore: () => void } | undefined;

      afterEach(() => {
        offsetHeight?.mockRestore();
      });

      /** A row that records the list's held height when a commit removes it. */
      function Row({ seen }: Readonly<{ seen: string[] }>): React.JSX.Element {
        const ref = React.useRef<HTMLDivElement>(null);
        React.useLayoutEffect(() => {
          const list = ref.current?.parentElement;
          return (): void => {
            seen.push(list?.style.minHeight ?? 'no list');
          };
        }, [seen]);
        return <div ref={ref} />;
      }

      /** Renders the list Virtuoso is handed, laid out 1000px tall, then swaps its one row. */
      function swapRow(placed: boolean): { list: HTMLElement; seen: string[] } {
        offsetHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(1000);
        renderWithProviders(<MessageList messages={messages} />);
        const { List } = capturedVirtuosoProps['components'] as { List: ListComponent };
        const context: ListContextDouble = {
          threadHeader: null,
          placed,
          onRowsShown: vi.fn<() => void>(),
        };
        const seen: string[] = [];
        const { container, rerender } = render(
          <List context={context}>
            <Row key="old" seen={seen} />
          </List>
        );
        rerender(
          <List context={context}>
            <Row key="new" seen={seen} />
          </List>
        );
        const list = container.firstElementChild;
        if (!(list instanceof HTMLElement)) throw new TypeError('the list rendered no element');
        return { list, seen };
      }

      it('holds the item list at the height it was laid out at while a commit swaps its rows', () => {
        expect(swapRow(false).seen).toEqual(['1000px']);
      });

      it('holds the item list through a commit after the thread is revealed', () => {
        expect(swapRow(true).seen).toEqual(['1000px']);
      });

      it('lets the item list take its own height once the commit is done', () => {
        expect(swapRow(false).list.style.minHeight).toBe('');
      });
    });

    it('mounts Virtuoso with initialItemCount of 1 so a row renders before the scroller is measured', () => {
      // Seeds the first paint against the WebKit zero-height stall (scroller
      // measures 0 before the flex chain resolves, so Virtuoso would render no
      // rows). Pinned at 1: the seed renders forward from the `LAST` anchor, so
      // any higher count overruns `data` and crashes computeItemKey — the real
      // behavior is covered in message-list.initial-paint.test.tsx.
      renderWithProviders(<MessageList messages={messages} />);
      expect(capturedVirtuosoProps['initialItemCount']).toBe(1);
    });
  });

  describe('conversationKey transitions (no-flash refactor)', () => {
    beforeEach(() => {
      virtuosoMockHandle.scrollToIndex.mockClear();
    });

    it('keeps the underlying virtuoso-mock DOM node identity across conversationKey changes', () => {
      // Previously the parent passed `key={conversationId}`, which forced
      // unmount/remount on every conversation switch — including the
      // welcome → first-real-id case, producing a visible blank-frame flash.
      const { rerender } = renderWithProviders(
        <MessageList messages={messages} conversationKey="init-main" />
      );
      const before = screen.getByTestId('virtuoso-mock');

      rerender(<MessageList messages={messages} conversationKey="real-id-main" />);

      // Same DOM node — React preserved the instance because nothing above
      // it keyed on conversationId.
      expect(screen.getByTestId('virtuoso-mock')).toBe(before);
    });

    it('snaps Virtuoso to the last row when conversationKey changes', () => {
      const { rerender } = renderWithProviders(
        <MessageList messages={messages} conversationKey="conv-a-main" />
      );
      // Initial mount registers the conversationKey but should not scroll —
      // Virtuoso already starts at LAST via initialTopMostItemIndex.
      expect(virtuosoMockHandle.scrollToIndex).not.toHaveBeenCalled();

      rerender(<MessageList messages={messages} conversationKey="conv-b-main" />);

      expect(virtuosoMockHandle.scrollToIndex).toHaveBeenCalledWith({
        index: 'LAST',
        align: 'end',
      });
    });

    it('does not snap on re-render when conversationKey is unchanged', () => {
      const { rerender } = renderWithProviders(
        <MessageList messages={messages} conversationKey="conv-a-main" />
      );
      rerender(
        <MessageList
          messages={[...messages, { ...messages[0]!, id: '4' }]}
          conversationKey="conv-a-main"
        />
      );
      expect(virtuosoMockHandle.scrollToIndex).not.toHaveBeenCalled();
    });
  });

  describe('re-rendering while a turn streams', () => {
    // Each message carries its own epoch so the render spy can name the row it
    // observed. Distinct epochs on one conversation are what a key rotation
    // leaves behind.
    const settled: Message[] = [
      {
        id: 's1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Question',
        createdAt: isoAt(TEST_DAY_START),
        epochNumber: 1,
      },
      {
        id: 's2',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Answer',
        createdAt: isoAt(TEST_DAY_START + SECOND_MS),
        epochNumber: 2,
      },
      {
        id: 's3',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Follow-up',
        createdAt: isoAt(TEST_DAY_START + 2 * SECOND_MS),
        epochNumber: 3,
      },
    ];
    const streamingSeed: Message = {
      id: 's4',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'A',
      createdAt: isoAt(TEST_DAY_START + 3 * SECOND_MS),
      epochNumber: 4,
    };

    beforeEach(() => {
      rowRenders.current = [];
      modelsHookCalls.current = 0;
      modelsResult.current = modelsResult.hydrated;
    });

    /**
     * One streamed content update, as the chat pipeline delivers it: a fresh
     * array whose only new element is the message the update landed on. Every
     * other message object survives, which the streaming content setters guarantee.
     */
    function tokenInto(content: string): Message[] {
      return [...settled, { ...streamingSeed, content }];
    }

    it('commits only the streaming row when a token arrives', () => {
      const { rerender } = renderWithProviders(
        <MessageList messages={tokenInto('A')} streamingMessageIds={new Set(['s4'])} />
      );
      rowRenders.current = [];

      rerender(<MessageList messages={tokenInto('Ab')} streamingMessageIds={new Set(['s4'])} />);

      expect(rowRenders.current).toEqual([4]);
    });

    it('commits only the streaming row in a group chat', () => {
      const { rerender } = renderWithProviders(
        <MessageList
          messages={tokenInto('A')}
          streamingMessageIds={new Set(['s4'])}
          isGroupChat
          currentUserId="u1"
        />
      );
      rowRenders.current = [];

      rerender(
        <MessageList
          messages={tokenInto('Ab')}
          streamingMessageIds={new Set(['s4'])}
          isGroupChat
          currentUserId="u1"
        />
      );

      expect(rowRenders.current).toEqual([4]);
    });

    it('reads the model catalog once for the whole list', () => {
      const { rerender } = renderWithProviders(
        <MessageList messages={tokenInto('A')} streamingMessageIds={new Set(['s4'])} />
      );
      // The mount renders the list twice: once hidden, once revealed on placement.
      modelsHookCalls.current = 0;

      rerender(<MessageList messages={tokenInto('Ab')} streamingMessageIds={new Set(['s4'])} />);

      expect(modelsHookCalls.current).toBe(1);
    });

    // A memo that drops a render is a correctness bug in performance clothing,
    // so every input that changes what a row shows is pinned here. Each case
    // holds the message objects still and moves exactly one input.
    describe('the memoised row still commits when', () => {
      const held = tokenInto('A');

      afterEach(() => {
        gateRef.current = { sendRefusal: undefined };
      });

      it('a token lands on its message', () => {
        const { rerender } = renderWithProviders(
          <MessageList messages={held} streamingMessageIds={new Set(['s4'])} />
        );
        rowRenders.current = [];

        rerender(<MessageList messages={tokenInto('Ab')} streamingMessageIds={new Set(['s4'])} />);

        expect(rowRenders.current).toContain(4);
      });

      it('the row stops streaming', () => {
        const { rerender } = renderWithProviders(
          <MessageList messages={held} streamingMessageIds={new Set(['s4'])} />
        );
        rowRenders.current = [];

        rerender(<MessageList messages={held} streamingMessageIds={new Set()} />);

        expect(rowRenders.current).toContain(4);
      });

      it('the row is marked errored', () => {
        const { rerender } = renderWithProviders(<MessageList messages={held} />);
        rowRenders.current = [];

        rerender(<MessageList messages={held} errorMessageId="s4" />);

        expect(rowRenders.current).toContain(4);
        expect(document.querySelector('[data-message-id="s4"]')).toHaveAttribute(
          'data-error',
          'true'
        );
      });

      it('the caller privilege changes which actions the row allows', () => {
        const { rerender } = renderWithProviders(
          <MessageList messages={held} isGroupChat currentUserId="u1" callerPrivilege="read" />
        );
        rowRenders.current = [];

        rerender(
          <MessageList messages={held} isGroupChat currentUserId="u1" callerPrivilege="write" />
        );

        expect(rowRenders.current).toContain(4);
      });

      it('a group behind a row gains a message', () => {
        const grouped: Message[] = [
          { ...settled[0]!, senderId: 'u1' },
          { ...settled[2]!, senderId: 'u1', epochNumber: 1 },
        ];
        const { rerender } = renderWithProviders(
          <MessageList messages={grouped} isGroupChat currentUserId="u1" />
        );
        rowRenders.current = [];

        const joined: Message[] = [
          ...grouped,
          { ...settled[2]!, id: 's5', senderId: 'u1', content: 'And another', epochNumber: 1 },
        ];
        rerender(<MessageList messages={joined} isGroupChat currentUserId="u1" />);

        expect(rowRenders.current).toContain(1);
        expect(screen.getByText('And another')).toBeInTheDocument();
      });

      it('the send gate stops refusing the re-run', () => {
        // A refusal that clears is a prop that DISAPPEARS: `regenerateRefusal`
        // reaches the row through `omitUndefined`, so its absence is the signal.
        // `messagesReady` moves alongside it because the gate is read inside the
        // list — without a changed list prop the list's own memo bails out and
        // the cleared verdict never reaches a row.
        gateRef.current = { sendRefusal: 'funds_held_by_run' };
        const onRegenerate = vi.fn();
        const { rerender } = renderWithProviders(
          <MessageList messages={held} onRegenerate={onRegenerate} messagesReady={false} />
        );
        const disabled = screen.getAllByLabelText('Regenerate');
        expect(disabled.at(-1)).toHaveAttribute('aria-disabled', 'true');
        rowRenders.current = [];

        gateRef.current = { sendRefusal: undefined };
        rerender(<MessageList messages={held} onRegenerate={onRegenerate} messagesReady />);

        expect(rowRenders.current).toContain(4);
        const enabled = screen.getAllByLabelText('Regenerate');
        expect(enabled.at(-1)).not.toHaveAttribute('aria-disabled');
      });

      it('the model catalog finishes loading', () => {
        modelsResult.current = modelsResult.pending;
        const { rerender } = renderWithProviders(
          <MessageList messages={held} streamingMessageIds={new Set()} />
        );
        rowRenders.current = [];

        modelsResult.current = modelsResult.hydrated;
        rerender(<MessageList messages={held} streamingMessageIds={new Set()} />);

        expect(rowRenders.current).toEqual([1, 2, 3, 4]);
      });
    });
  });

  describe('forwardRef', () => {
    it('exposes MessageListHandle via ref', () => {
      const ref = React.createRef<MessageListHandle>();
      renderWithProviders(<MessageList ref={ref} messages={messages} />);

      expect(ref.current).toBeDefined();
    });

    it('exposes no handle while the list is empty', () => {
      const ref = React.createRef<MessageListHandle>();
      renderWithProviders(<MessageList ref={ref} messages={[]} />);

      expect(ref.current).toBeNull();
    });
  });

  describe('error message identification', () => {
    it('passes isError to MessageItem when errorMessageId matches', () => {
      const errorMessages = [
        {
          id: 'err-1',
          conversationId: 'conv-1',
          role: 'assistant' as const,
          content: 'You ran out of messages. [Sign up](/signup) to continue!',
          createdAt: isoAt(TEST_DAY_START),
        },
      ];
      renderWithProviders(<MessageList messages={errorMessages} errorMessageId="err-1" />);

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).toHaveAttribute('data-error', 'true');
    });

    it('does not pass isError when errorMessageId does not match', () => {
      renderWithProviders(<MessageList messages={messages} errorMessageId="nonexistent" />);

      const messageItems = screen.getAllByTestId('message-item');
      for (const item of messageItems) {
        expect(item).not.toHaveAttribute('data-error');
      }
    });
  });

  describe('onShare', () => {
    it('passes onShare to assistant message items', () => {
      const onShare = vi.fn();
      renderWithProviders(<MessageList messages={messages} onShare={onShare} />);

      const shareButtons = screen.getAllByLabelText('Share');
      expect(shareButtons).toHaveLength(1);
    });

    it('does not render share buttons when onShare is not provided', () => {
      renderWithProviders(<MessageList messages={messages} />);

      expect(screen.queryByLabelText('Share')).not.toBeInTheDocument();
    });
  });

  describe('action callbacks', () => {
    it('passes onRegenerate to MessageItem so retry button renders on user messages', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(<MessageList messages={messages} onRegenerate={onRegenerate} />);

      const retryButtons = screen.getAllByLabelText('Retry');
      expect(retryButtons.length).toBeGreaterThan(0);
    });

    it('passes onEdit to MessageItem so edit button renders on user messages', () => {
      const onEdit = vi.fn();
      renderWithProviders(<MessageList messages={messages} onEdit={onEdit} />);

      const editButtons = screen.getAllByLabelText('Edit');
      expect(editButtons.length).toBeGreaterThan(0);
    });

    it('passes onFork to MessageItem so fork button renders', () => {
      const onFork = vi.fn();
      renderWithProviders(<MessageList messages={messages} onFork={onFork} />);

      const forkButtons = screen.getAllByLabelText('Fork');
      expect(forkButtons.length).toBeGreaterThan(0);
    });

    it('does not render action buttons when callbacks are not provided', () => {
      renderWithProviders(<MessageList messages={messages} />);

      expect(screen.queryByLabelText('Retry')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Edit')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Fork')).not.toBeInTheDocument();
    });
  });

  describe('multi-model regeneration', () => {
    const multiModelMessages: Message[] = [
      {
        id: 'u1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Compare models',
        createdAt: isoAt(TEST_DAY_START),
        parentMessageId: null,
      },
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'GPT response',
        createdAt: isoAt(TEST_DAY_START + SECOND_MS),
        parentMessageId: 'u1',
        modelName: 'GPT-4o',
      },
      {
        id: 'a2',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Claude response',
        createdAt: isoAt(TEST_DAY_START + 2 * SECOND_MS),
        parentMessageId: 'u1',
        modelName: 'Claude 3.5',
      },
    ];

    it('shows per-tile regenerate buttons on multi-model assistant messages (regenerate-one)', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageList messages={multiModelMessages} onRegenerate={onRegenerate} />
      );

      // One regenerate icon button per assistant tile.
      expect(screen.getAllByLabelText('Regenerate')).toHaveLength(2);
    });

    it('shows retry/edit buttons on user message with multiple assistant children (retry-all)', () => {
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      renderWithProviders(
        <MessageList messages={multiModelMessages} onRegenerate={onRegenerate} onEdit={onEdit} />
      );

      expect(screen.getByLabelText('Retry')).toBeInTheDocument();
      expect(screen.getByLabelText('Edit')).toBeInTheDocument();
    });

    it('shows regenerate buttons on single-model messages', () => {
      const singleModelMessages: Message[] = [
        {
          id: 'u1',
          conversationId: 'conv-1',
          role: 'user',
          content: 'Hello',
          createdAt: isoAt(TEST_DAY_START),
          parentMessageId: null,
        },
        {
          id: 'a1',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'Hi there',
          createdAt: isoAt(TEST_DAY_START + SECOND_MS),
          parentMessageId: 'u1',
        },
      ];
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageList messages={singleModelMessages} onRegenerate={onRegenerate} />
      );

      expect(screen.getByLabelText('Retry')).toBeInTheDocument();
      expect(screen.getByLabelText('Regenerate')).toBeInTheDocument();
    });
  });

  describe('group chat mode', () => {
    const members = [
      { id: 'member-1', userId: 'user-1', username: 'alice', privilege: 'owner' },
      { id: 'member-2', userId: 'user-2', username: 'bob', privilege: 'admin' },
    ];

    const groupMessages: Message[] = [
      {
        id: 'a1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hello from Alice',
        createdAt: isoAt(TEST_DAY_START),
        senderId: 'user-1',
      },
      {
        id: 'a2',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Second from Alice',
        createdAt: isoAt(TEST_DAY_START + SECOND_MS),
        senderId: 'user-1',
      },
      {
        id: 'b1',
        conversationId: 'conv-1',
        role: 'user',
        content: 'Hi from Bob',
        createdAt: isoAt(TEST_DAY_START + 2 * SECOND_MS),
        senderId: 'user-2',
      },
      {
        id: 'ai1',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'AI response',
        createdAt: isoAt(TEST_DAY_START + 3 * SECOND_MS),
      },
    ];

    it('groups consecutive same-sender messages into fewer Virtuoso rows', () => {
      renderWithProviders(
        <MessageList
          messages={groupMessages}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      // 4 messages should produce 3 groups: alice×2, bob×1, AI×1
      const messageItems = screen.getAllByTestId('message-item');
      expect(messageItems).toHaveLength(3);
    });

    it('shows sender labels in group chat mode', () => {
      renderWithProviders(
        <MessageList
          messages={groupMessages}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      const labels = screen.getAllByTestId('sender-label');
      // Should have labels for: alice group ("You"), bob group ("bob")
      // AI messages don't have labels
      expect(labels).toHaveLength(2);
      expect(labels[0]).toHaveTextContent('You');
      expect(labels[1]).toHaveTextContent('bob');
    });

    it('does not group messages when not in group chat mode', () => {
      renderWithProviders(<MessageList messages={groupMessages} />);

      const messageItems = screen.getAllByTestId('message-item');
      expect(messageItems).toHaveLength(4);
    });

    it('renders both messages within a grouped bubble', () => {
      renderWithProviders(
        <MessageList
          messages={groupMessages}
          isGroupChat
          currentUserId="user-1"
          members={members}
        />
      );

      expect(screen.getByText('Hello from Alice')).toBeInTheDocument();
      expect(screen.getByText('Second from Alice')).toBeInTheDocument();
    });
  });

  describe('scroll breakaway behavior', () => {
    beforeEach(() => {
      capturedVirtuosoProps = {};
    });

    it('passes atBottomStateChange callback to Virtuoso', () => {
      renderWithProviders(<MessageList messages={messages} />);
      expect(capturedVirtuosoProps['atBottomStateChange']).toBeDefined();
      expectExposes(capturedVirtuosoProps, 'atBottomStateChange');
    });

    it('followOutput returns true when user is at bottom', () => {
      renderWithProviders(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      expect(followOutput(true)).toBe(true);
    });

    it('followOutput returns true regardless of isAtBottom when user has not scrolled away', () => {
      renderWithProviders(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      expect(followOutput(false)).toBe(true);
    });

    it('followOutput returns false after user-driven scroll-away even when isAtBottom is true', () => {
      renderWithProviders(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;
      const scroller = screen.getByTestId('virtuoso-mock');

      // Simulate user scrolling on the scroller, then Virtuoso reports
      // the user is no longer at the bottom.
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      act(() => {
        atBottomStateChange(false);
      });

      // Even if Virtuoso reports isAtBottom=true (e.g. smooth scroll animation),
      // followOutput should respect the breakaway state.
      expect(followOutput(true)).toBe(false);
    });

    it('followOutput re-engages once Virtuoso reports atBottom=true again', () => {
      renderWithProviders(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;
      const scroller = screen.getByTestId('virtuoso-mock');

      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      act(() => {
        atBottomStateChange(false);
      });
      expect(followOutput(true)).toBe(false);

      // Whether followOutput catches up or the user scrolled back, the
      // atBottom=true notification should re-engage auto-follow.
      act(() => {
        atBottomStateChange(true);
      });
      expect(followOutput(true)).toBe(true);
    });

    it('does NOT mark scrolled-away on atBottomStateChange(false) without prior user input', () => {
      // Regression: streaming content growth can push the view past the
      // bottom threshold for one frame. Without user input, the auto-follow
      // must keep chasing the bottom — not disengage.
      renderWithProviders(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;

      act(() => {
        atBottomStateChange(false);
      });
      expect(followOutput(true)).toBe(true);
    });

    it('marks scrolled-away on touchmove + atBottomStateChange(false)', () => {
      renderWithProviders(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;
      const scroller = screen.getByTestId('virtuoso-mock');

      scroller.dispatchEvent(new TouchEvent('touchmove', { bubbles: true }));
      act(() => {
        atBottomStateChange(false);
      });

      expect(followOutput(true)).toBe(false);
    });

    it.each([['PageDown'], ['PageUp'], ['Home'], ['End'], ['ArrowDown'], ['ArrowUp'], [' ']])(
      'marks scrolled-away on keydown "%s" + atBottomStateChange(false)',
      (key) => {
        renderWithProviders(<MessageList messages={messages} />);
        const followOutput = capturedVirtuosoProps['followOutput'] as (
          isAtBottom: boolean
        ) => boolean;
        const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
          atBottom: boolean
        ) => void;
        const scroller = screen.getByTestId('virtuoso-mock');

        scroller.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        act(() => {
          atBottomStateChange(false);
        });

        expect(followOutput(true)).toBe(false);
      }
    );

    it('does NOT mark scrolled-away on non-scroll keydown (e.g. typing letters)', () => {
      renderWithProviders(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;
      const scroller = screen.getByTestId('virtuoso-mock');

      scroller.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
      act(() => {
        atBottomStateChange(false);
      });

      expect(followOutput(true)).toBe(true);
    });

    it('user-input flag decays so a later atBottom(false) without input does not mark scrolled-away', () => {
      renderWithProviders(<MessageList messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;
      const scroller = screen.getByTestId('virtuoso-mock');

      // First user input then immediate atBottom(false) sticks.
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      act(() => {
        atBottomStateChange(false);
      });
      expect(followOutput(true)).toBe(false);

      // Re-engage at bottom.
      act(() => {
        atBottomStateChange(true);
      });
      expect(followOutput(true)).toBe(true);

      // Decay window passes — a later content-growth-only atBottom(false)
      // must NOT mark scrolled-away.
      vi.advanceTimersByTime(500);
      act(() => {
        atBottomStateChange(false);
      });
      expect(followOutput(true)).toBe(true);
    });

    it('exposes resetScrollBreakaway via ref', () => {
      const ref = React.createRef<MessageListHandle>();
      renderWithProviders(<MessageList ref={ref} messages={messages} />);

      expect(ref.current).toBeDefined();
      expectExposes(ref.current ?? {}, 'resetScrollBreakaway');
    });

    it('resetScrollBreakaway re-enables auto-scroll after breakaway', () => {
      const ref = React.createRef<MessageListHandle>();
      renderWithProviders(<MessageList ref={ref} messages={messages} />);
      const followOutput = capturedVirtuosoProps['followOutput'] as (
        isAtBottom: boolean
      ) => boolean;
      const atBottomStateChange = capturedVirtuosoProps['atBottomStateChange'] as (
        atBottom: boolean
      ) => void;
      const scroller = screen.getByTestId('virtuoso-mock');

      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true }));
      act(() => {
        atBottomStateChange(false);
      });
      expect(followOutput(true)).toBe(false);

      ref.current?.resetScrollBreakaway();
      expect(followOutput(true)).toBe(true);
    });
  });

  describe('dev scroll hatch and user-scroll decay', () => {
    afterEach(() => {
      envRef.current.isLocalDev = false;
    });

    it('installs a scroll-to-index hatch in local dev and tears it down on unmount', () => {
      envRef.current.isLocalDev = true;
      const scrollHatch = (): ((index: number) => Promise<void>) | undefined =>
        (globalThis as { __virtuosoScrollToIndex?: (index: number) => Promise<void> })
          .__virtuosoScrollToIndex;

      const { unmount } = renderWithProviders(<MessageList messages={messages} />);

      expectExposes(globalThis, '__virtuosoScrollToIndex');
      void scrollHatch()?.(1);
      expect(virtuosoMockHandle.scrollIntoView).toHaveBeenCalledWith(
        expect.objectContaining({ index: 1, align: 'start' })
      );

      unmount();
      expect(scrollHatch()).toBeUndefined();
    });

    it('installs no scroll-to-index hatch outside local dev and E2E', () => {
      envRef.current.isLocalDev = false;
      envRef.current.isE2E = false;

      renderWithProviders(<MessageList messages={messages} />);

      expect(
        (globalThis as { __virtuosoScrollToIndex?: (index: number) => Promise<void> })
          .__virtuosoScrollToIndex
      ).toBeUndefined();
    });

    it('marks a user scroll, decays it after the timeout, and clears a pending timer on unmount', () => {
      const { unmount } = renderWithProviders(<MessageList messages={messages} />);
      const scroller = screen.getByTestId('virtuoso-mock');

      fireEvent.wheel(scroller);
      fireEvent.keyDown(scroller, { key: 'ArrowDown' });
      act(() => {
        vi.advanceTimersByTime(300);
      });

      // A fresh scroll leaves a pending decay timer that unmount must clear.
      fireEvent.keyDown(scroller, { key: 'PageDown' });
      expect(() => {
        unmount();
      }).not.toThrow();
    });

    it('reflects Virtuoso isScrolling transitions', () => {
      renderWithProviders(<MessageList messages={messages} />);
      expect(() => {
        (capturedVirtuosoProps['isScrolling'] as (scrolling: boolean) => void)(true);
      }).not.toThrow();
      (capturedVirtuosoProps['isScrolling'] as (scrolling: boolean) => void)(false);
    });
  });

  describe('the thread header', () => {
    function precedes(earlier: Element, later: Element): boolean {
      return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }

    it('renders inside the scroller before the first message', () => {
      renderWithProviders(
        <MessageList messages={messages} threadHeader={<p data-testid="thread-head">Head</p>} />
      );
      const head = screen.getByTestId('thread-head');
      expect(screen.getByTestId('virtuoso-mock')).toContainElement(head);
      expect(precedes(head, screen.getAllByTestId('message-item')[0]!)).toBe(true);
    });

    it('sits below the top spacer', () => {
      renderWithProviders(
        <MessageList messages={messages} threadHeader={<p data-testid="thread-head">Head</p>} />
      );
      const spacer = screen.getByTestId('virtuoso-mock').firstElementChild!;
      expect(spacer).toHaveClass('h-4');
      expect(spacer).toHaveAttribute('aria-hidden', 'true');
      expect(spacer.nextElementSibling).toBe(screen.getByTestId('thread-head'));
    });

    it('leaves only the top spacer before the first message when none is given', () => {
      renderWithProviders(<MessageList messages={messages} />);
      const spacer = screen.getByTestId('virtuoso-mock').firstElementChild!;
      expect(spacer.outerHTML).toBe('<div class="h-4" aria-hidden="true"></div>');
      expect(spacer.nextElementSibling).toContainElement(screen.getAllByTestId('message-item')[0]!);
    });

    it('updates its content without remounting the rows', () => {
      const { rerender } = renderWithProviders(
        <MessageList messages={messages} threadHeader={<p>First head</p>} />
      );
      const firstRow = screen.getAllByTestId('message-item')[0];
      const components = capturedVirtuosoProps['components'];

      rerender(<MessageList messages={messages} threadHeader={<p>Second head</p>} />);

      expect(screen.getByText('Second head')).toBeInTheDocument();
      expect(screen.queryByText('First head')).not.toBeInTheDocument();
      expect(screen.getAllByTestId('message-item')[0]).toBe(firstRow);
      expect(capturedVirtuosoProps['components']).toBe(components);
    });
  });

  describe('the fork mark', () => {
    function branch(forkId: string, forkPointId: string | null): BranchSummary {
      return { forkId, name: forkId, firstMessage: '', forkPointOrdinal: 2, forkPointId };
    }
    const THREE_AT_TWO: readonly BranchSummary[] = [
      branch('main', '2'),
      branch('f1', '2'),
      branch('f2', '2'),
    ];

    function mark(): HTMLElement {
      return screen.getByRole('button', { name: /^Branched here/ });
    }

    function follows(later: HTMLElement, earlier: HTMLElement): boolean {
      return (earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
    }

    it('counts the other branches parting where the current one does', () => {
      renderWithProviders(
        <MessageList
          messages={messages}
          branches={THREE_AT_TWO}
          activeForkId="f1"
          onOpenBranches={vi.fn<() => void>()}
        />
      );
      expect(mark()).toHaveAccessibleName('Branched here · 2 more');
    });

    it('sits after the message the branches share last', () => {
      renderWithProviders(
        <MessageList
          messages={messages}
          branches={THREE_AT_TWO}
          activeForkId="f1"
          onOpenBranches={vi.fn<() => void>()}
        />
      );
      expect(follows(mark(), screen.getByText('Hi there!'))).toBe(true);
    });

    it('sits before the message the current branch goes on with', () => {
      renderWithProviders(
        <MessageList
          messages={messages}
          branches={THREE_AT_TWO}
          activeForkId="f1"
          onOpenBranches={vi.fn<() => void>()}
        />
      );
      expect(follows(screen.getByText('How are you?'), mark())).toBe(true);
    });

    it('marks each fork point once', () => {
      renderWithProviders(
        <MessageList
          messages={messages}
          branches={THREE_AT_TWO}
          activeForkId="f1"
          onOpenBranches={vi.fn<() => void>()}
        />
      );
      expect(screen.getAllByRole('button', { name: /^Branched here/ })).toHaveLength(1);
    });

    it('marks no point the current branch does not part at', () => {
      renderWithProviders(
        <MessageList
          messages={messages}
          branches={[branch('main', '2'), branch('f2', '2'), branch('f1', null)]}
          activeForkId="f1"
          onOpenBranches={vi.fn<() => void>()}
        />
      );
      expect(screen.queryByRole('button', { name: /^Branched here/ })).not.toBeInTheDocument();
    });

    it('draws no mark without branches', () => {
      renderWithProviders(
        <MessageList messages={messages} activeForkId="f1" onOpenBranches={vi.fn<() => void>()} />
      );
      expect(screen.queryByRole('button', { name: /^Branched here/ })).not.toBeInTheDocument();
    });

    it('draws no mark while no branch is current', () => {
      renderWithProviders(
        <MessageList
          messages={messages}
          branches={THREE_AT_TWO}
          onOpenBranches={vi.fn<() => void>()}
        />
      );
      expect(screen.queryByRole('button', { name: /^Branched here/ })).not.toBeInTheDocument();
    });

    it('draws no mark without a way to open the branches', () => {
      renderWithProviders(
        <MessageList messages={messages} branches={THREE_AT_TWO} activeForkId="f1" />
      );
      expect(screen.queryByRole('button', { name: /^Branched here/ })).not.toBeInTheDocument();
    });

    it('opens the branches', () => {
      const onOpenBranches = vi.fn<() => void>();
      renderWithProviders(
        <MessageList
          messages={messages}
          branches={THREE_AT_TWO}
          activeForkId="f1"
          onOpenBranches={onOpenBranches}
        />
      );
      fireEvent.click(mark());
      expect(onOpenBranches).toHaveBeenCalledTimes(1);
    });

    it('follows the group holding the fork point in a group chat', () => {
      const at = isoAt(TEST_DAY_START);
      const grouped: Message[] = [
        {
          id: 'g1',
          conversationId: 'conv-1',
          role: 'user',
          content: 'First ask',
          createdAt: at,
          senderId: 'u1',
        },
        {
          id: 'g2',
          conversationId: 'conv-1',
          role: 'user',
          content: 'Second ask',
          createdAt: at,
          senderId: 'u1',
          parentMessageId: 'g1',
        },
        {
          id: 'g3',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'The answer',
          createdAt: at,
          parentMessageId: 'g2',
        },
      ];
      renderWithProviders(
        <MessageList
          messages={grouped}
          isGroupChat
          currentUserId="u1"
          branches={[branch('main', 'g1'), branch('f1', 'g1')]}
          activeForkId="f1"
          onOpenBranches={vi.fn<() => void>()}
        />
      );
      expect([
        follows(mark(), screen.getByText('Second ask')),
        follows(screen.getByText('The answer'), mark()),
      ]).toEqual([true, true]);
    });
  });

  describe('a compare turn', () => {
    const at = isoAt(TEST_DAY_START);
    const question: Message = {
      id: 'q1',
      conversationId: 'conv-1',
      role: 'user',
      content: 'Which transport?',
      createdAt: at,
      senderId: 'user-1',
      parentMessageId: null,
    };
    const firstReply: Message = {
      id: 'r1',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'UDP, says one',
      createdAt: at,
      parentMessageId: 'q1',
      modelName: 'openai/gpt-5',
    };
    const secondReply: Message = {
      id: 'r2',
      conversationId: 'conv-1',
      role: 'assistant',
      content: 'UDP, says another',
      createdAt: at,
      parentMessageId: 'q1',
      modelName: 'google/gemini-2.5-pro',
    };
    const turn: Message[] = [question, firstReply, secondReply];

    function group(): HTMLElement {
      return screen.getByTestId(TEST_IDS.compareGroup);
    }

    it("renders a turn's replies together in one compare group", () => {
      renderWithProviders(<MessageList messages={turn} />);

      expect(within(group()).getByText('UDP, says one')).toBeInTheDocument();
      expect(within(group()).getByText('UDP, says another')).toBeInTheDocument();
    });

    it('keeps the question outside the compare group', () => {
      renderWithProviders(<MessageList messages={turn} />);

      expect(within(group()).queryByText('Which transport?')).toBeNull();
    });

    it('draws the turn as one row of the list', () => {
      renderWithProviders(<MessageList messages={turn} />);

      expect(screen.getByTestId(TEST_IDS.messageList)).toHaveAttribute('data-rows-count', '2');
    });

    it('draws no compare group for a lone reply', () => {
      renderWithProviders(<MessageList messages={[question, firstReply]} />);

      expect(screen.queryByTestId(TEST_IDS.compareGroup)).toBeNull();
    });

    it('renders the compare group inside the sender grouping of a group chat', () => {
      const followUp: Message = {
        id: 'q2',
        conversationId: 'conv-1',
        role: 'user',
        content: 'And for chat?',
        createdAt: at,
        senderId: 'user-1',
        parentMessageId: 'r2',
      };
      const again: Message = { ...followUp, id: 'q3', content: 'Or voice?', parentMessageId: 'q2' };
      renderWithProviders(
        <MessageList
          messages={[...turn, followUp, again]}
          isGroupChat
          currentUserId="user-1"
          members={[{ id: 'm1', userId: 'user-1', username: 'alice', privilege: 'owner' }]}
        />
      );

      expect(within(group()).getAllByTestId(TEST_IDS.messageItem)).toHaveLength(2);
      expect(screen.getByTestId(TEST_IDS.messageList)).toHaveAttribute('data-rows-count', '3');
    });

    it("keeps each reply's own streaming state", () => {
      renderWithProviders(
        <MessageList messages={turn} streamingMessageIds={new Set(['r2'])} onShare={vi.fn()} />
      );

      const [settled, streaming] = within(group()).getAllByTestId(TEST_IDS.messageItem);
      expect(within(settled!).queryByTestId(TEST_IDS.messageActions)).not.toBeNull();
      expect(within(streaming!).queryByTestId(TEST_IDS.messageActions)).toBeNull();
    });

    it("keeps each reply's own error state", () => {
      renderWithProviders(<MessageList messages={turn} errorMessageId="r2" />);

      const [answered, failed] = within(group()).getAllByTestId(TEST_IDS.messageItem);
      expect(answered).not.toHaveAttribute('data-error');
      expect(failed).toHaveAttribute('data-error', 'true');
    });

    describe('Continue with this model', () => {
      function catalogModel(id: string, name: string): Model {
        return {
          id,
          name,
          description: 'desc',
          provider: 'Vendor',
          modality: 'text',
          contextLength: 8000,
          supportedParameters: [],
          pricing: { inputPerToken: '10000', outputPerToken: '30000' },
        };
      }
      const catalog = {
        data: {
          models: [
            catalogModel('openai/gpt-5', 'GPT-5'),
            catalogModel('google/gemini-2.5-pro', 'Gemini 2.5 Pro'),
          ],
          premiumIds: new Set<string>(),
        },
        isLoading: false,
      };

      beforeEach(() => {
        modelsResult.current = catalog;
      });

      afterEach(() => {
        modelsResult.current = modelsResult.hydrated;
      });

      function continuesIn(column: number): HTMLElement[] {
        return within(screen.getByTestId(TEST_ID_BUILDERS.compareColumn(column))).queryAllByTestId(
          TEST_IDS.continueWithModel
        );
      }

      it('offers Continue on each reply to the conversation owner', () => {
        renderWithProviders(<MessageList messages={turn} onRegenerate={vi.fn()} />);

        expect(continuesIn(0)).toHaveLength(1);
        expect(continuesIn(1)).toHaveLength(1);
      });

      it('offers Continue while the replies stream, to a viewer who can send', () => {
        renderWithProviders(
          <MessageList messages={turn} streamingMessageIds={new Set(['r1', 'r2'])} />
        );

        expect(continuesIn(0)).toHaveLength(1);
        expect(continuesIn(1)).toHaveLength(1);
      });

      it('offers Continue on an errored reply in a group chat another member has posted in', () => {
        const otherQuestion: Message = {
          id: 'q2',
          conversationId: 'conv-1',
          role: 'user',
          content: 'And for chat?',
          createdAt: at,
          senderId: 'user-2',
          parentMessageId: 'r2',
        };
        renderWithProviders(
          <MessageList
            messages={[...turn, otherQuestion]}
            isGroupChat
            currentUserId="user-1"
            callerPrivilege="write"
            errorMessageId="r2"
            onRegenerate={vi.fn()}
          />
        );

        expect(continuesIn(1)).toHaveLength(1);
      });

      it('offers no Continue to a read-only member', () => {
        renderWithProviders(
          <MessageList messages={turn} isGroupChat currentUserId="user-1" callerPrivilege="read" />
        );

        expect(screen.queryByTestId(TEST_IDS.continueWithModel)).toBeNull();
      });
    });

    it('names each tab from the model id while the catalog loads', () => {
      modelsResult.current = modelsResult.pending;
      try {
        renderWithProviders(<MessageList messages={turn} />);

        expect(screen.getByTestId(TEST_ID_BUILDERS.compareTab(0))).toHaveTextContent('gpt-5');
      } finally {
        modelsResult.current = modelsResult.hydrated;
      }
    });

    it("draws each column's nameplate in its tab's swatch", () => {
      // Two ids whose own swatches are the same, so the turn's set must move one.
      const firstId = 'vendor/model-0';
      const secondId =
        Array.from({ length: 1000 }, (_, index) => `vendor/model-${String(index + 1)}`).find(
          (id) => modelSwatch(id) === modelSwatch(firstId)
        ) ?? '';
      renderWithProviders(
        <MessageList
          messages={[
            question,
            { ...firstReply, modelName: firstId },
            { ...secondReply, modelName: secondId },
          ]}
        />
      );

      const swatchClass = (element: Element | null): string | undefined =>
        [...(element?.classList ?? [])].find((name) => name.startsWith('bg-model-'));
      for (const index of [0, 1]) {
        const tabSwatch = screen
          .getByTestId(TEST_ID_BUILDERS.compareTab(index))
          .querySelector('[data-slot="swatch"]');
        const headSwatch = within(screen.getByTestId(TEST_ID_BUILDERS.compareColumn(index)))
          .getByTestId(TEST_IDS.modelNametagContainer)
          .querySelector('[data-slot="swatch"]');
        expect(swatchClass(headSwatch)).toBe(swatchClass(tabSwatch));
      }
    });

    it('commits only the reply a token lands on', () => {
      const withEpochs: Message[] = [
        { ...question, epochNumber: 1 },
        { ...firstReply, epochNumber: 2 },
        { ...secondReply, epochNumber: 3 },
      ];
      const { rerender } = renderWithProviders(
        <MessageList messages={withEpochs} streamingMessageIds={new Set(['r2'])} />
      );
      rowRenders.current = [];

      const [asked, settled, streaming] = withEpochs;
      rerender(
        <MessageList
          messages={[asked!, settled!, { ...streaming!, content: 'UDP, says another, louder' }]}
          streamingMessageIds={new Set(['r2'])}
        />
      );

      expect(rowRenders.current).toEqual([3]);
    });

    it('marks the fork point after a compare group that holds it', () => {
      renderWithProviders(
        <MessageList
          messages={turn}
          branches={[
            {
              forkId: 'main',
              name: 'Main',
              firstMessage: '',
              forkPointOrdinal: 2,
              forkPointId: 'r2',
            },
            { forkId: 'f1', name: 'f1', firstMessage: '', forkPointOrdinal: 2, forkPointId: 'r2' },
          ]}
          activeForkId="f1"
          onOpenBranches={vi.fn<() => void>()}
        />
      );

      const mark = screen.getByRole('button', { name: /^Branched here/ });
      expect(group().compareDocumentPosition(mark) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    });
  });
});
