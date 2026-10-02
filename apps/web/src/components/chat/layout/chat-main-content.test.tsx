import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as React from 'react';
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { ChatMainContent } from '@/components/chat/layout/chat-main-content';
import { renderWithProviders } from '@/test-utils/render';
import type { VirtuosoHandle } from 'react-virtuoso';

// Break the import chain that requires VITE_API_URL at module load time (see
// message-list.test.tsx for the same rationale).
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

vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn().mockResolvedValue({ svg: '<svg>Diagram</svg>', bindFunctions: vi.fn() }),
  },
}));

// Rendering the real message-item reaches markdown-renderer through React.lazy.
// Leaving it real scrambles that module's own coverage report: v8 records a
// lazily-imported module under a different startOffset than a static import of it,
// and vitest merges both raw range sets by URL under one offset. This suite asserts
// re-render counts only; markdown rendering is covered in markdown-renderer.test.tsx.
vi.mock('@/components/chat/message/markdown-renderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@/hooks/models/models', () => ({
  useModels: () => ({ data: { models: [], premiumIds: new Set() }, isLoading: false }),
}));
// MessageList reads the send gate once per list (the regenerate money verdict).
// Neither suite mounts a QueryClientProvider, so the real hook's query stack
// cannot load here.
vi.mock('@/hooks/billing/use-prompt-budget', () => ({
  usePromptBudget: () => ({ sendRefusal: undefined }),
}));

// MessageList renders <Virtuoso> exactly once per MessageList render, so a
// commit of the mock is a faithful proxy for "MessageList re-rendered". The
// count is bumped in an effect (not during render) to satisfy the
// react-hooks/globals rule; an effect with no dependency array runs after every
// commit, and a render skipped by React.memo commits nothing.
const onVirtuosoRender = vi.fn();
vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(function MockVirtuoso(
    props: Record<string, unknown>,
    ref: React.Ref<VirtuosoHandle>
  ) {
    const data = props['data'] as unknown[];
    const itemContent = props['itemContent'] as (index: number, item: unknown) => React.ReactNode;
    React.useImperativeHandle(ref, () => ({}) as VirtuosoHandle);
    React.useEffect(() => {
      onVirtuosoRender();
    });
    return (
      <div data-testid="virtuoso-mock">
        {data.map((item, index) => (
          <div key={index}>{itemContent(index, item)}</div>
        ))}
      </div>
    );
  }),
}));

import type { MessageListHandle } from '@/components/chat/message/message-list';
import type { Message } from '@/lib/api/api';

const messages: Message[] = [
  {
    id: '1',
    conversationId: 'c1',
    role: 'user',
    content: 'Hello!',
    createdAt: isoAt(TEST_DAY_START),
  },
  {
    id: '2',
    conversationId: 'c1',
    role: 'assistant',
    content: 'Hi there!',
    createdAt: isoAt(TEST_DAY_START + SECOND_MS),
  },
];

const EMPTY_STREAMING_IDS = new Set<string>();

/**
 * Harness mirroring the production wiring: the prompt-input value lives in
 * parent state (a keystroke re-renders the harness), while the props flowing
 * into ChatMainContent are referentially stable across that re-render. If
 * ChatMainContent / MessageList are not memoized — or the stable props are
 * rebuilt each render — typing re-renders the virtualized list.
 */
function Harness(): React.JSX.Element {
  const [inputValue, setInputValue] = React.useState('');
  const virtuosoRef = React.useRef<MessageListHandle>(null);
  const onShare = React.useCallback((_id: string): void => {}, []);

  return (
    <>
      <ChatMainContent
        messages={messages}
        streamingMessageIds={EMPTY_STREAMING_IDS}
        persistingMessageIds={undefined}
        errorMessageId={undefined}
        modelName="gpt-4o"
        onShare={onShare}
        onRegenerate={undefined}
        onEdit={undefined}
        onFork={undefined}
        isDecrypting={false}
        groupChat={undefined}
        virtuosoRef={virtuosoRef}
        isAuthenticated={true}
        isLinkGuest={false}
        callerPrivilege={undefined}
        conversationId="c1"
        activeForkId={null}
        messagesReady={true}
      />
      <input
        aria-label="prompt"
        value={inputValue}
        onChange={(e) => {
          setInputValue(e.target.value);
        }}
      />
    </>
  );
}

describe('ChatMainContent', () => {
  it('does not re-render MessageList when a keystroke updates the prompt input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<Harness />);

    const renderCountBeforeTyping = onVirtuosoRender.mock.calls.length;
    expect(renderCountBeforeTyping).toBeGreaterThan(0);

    await user.type(screen.getByLabelText('prompt'), 'h');

    expect(onVirtuosoRender.mock.calls.length).toBe(renderCountBeforeTyping);
  });
});
