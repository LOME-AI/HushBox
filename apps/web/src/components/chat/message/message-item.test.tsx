import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, fireEvent, act, within } from '@testing-library/react';
import { noticeText, serializeSegments, TEST_IDS } from '@hushbox/shared';
import { useTtsPlaybackStore } from '@hushbox/ui/accessibility/store';
import { LAYOUT } from '@hushbox/shared/design-tokens';
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { MessageItem } from '@/components/chat/message/message-item';
import { useSegmentViewState } from '@/components/chat/segments/segment-view-state';
import { modelSwatch } from '@/lib/utils/model-color';
import { renderWithProviders } from '@/test-utils/render';
import type { MessageGroup } from '@/lib/chat/sender';
import type { Message } from '@/lib/api/api';
import type { MessageAction } from '@/lib/chat/message-actions';
import type { ResolvedReasoningEffort } from '@hushbox/shared';
import type { ModelsData } from '@/hooks/models/models';

// Counts the row's reads of the raw text field. Reasoning, search rows and
// answer ride the same field, and every block needs the tree, so the row parses
// once and hands the tree down.
const { messageParses } = vi.hoisted(() => ({ messageParses: { current: 0 } }));
vi.mock('@hushbox/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...actual,
    parseAssistantMessage: (text: string) => {
      messageParses.current += 1;
      return actual.parseAssistantMessage(text);
    },
  };
});

/** Assistant text carrying a reasoning span, then the answer when one is given. */
function withReasoning(reasoning: string, answer: string): string {
  return serializeSegments([
    { kind: 'reasoning', children: reasoning === '' ? [] : [{ kind: 'text', text: reasoning }] },
    ...(answer === '' ? [] : [{ kind: 'text' as const, text: answer }]),
  ]);
}

vi.mock('@/lib/tts/chat-tts-stream', () => ({
  stopTtsForMessage: vi.fn(),
}));

// The notice's link uses TanStack Router which requires Router context. Mock
// to a marker element here — the real link behavior is exercised in
// tts-stopped-notice.test.tsx with a full router setup. This test asserts
// only that the notice is mounted in the right slot when the store flags it.
// Uses vi.importActual so the gating mirrors what MessageItem will see in
// production; only the Link-rendering DOM is swapped for a marker div.
vi.mock('@/components/chat/indicators/tts-stopped-notice', async () => {
  const { useTtsPlaybackStore } = await vi.importActual<
    typeof import('@hushbox/ui/accessibility/store')
  >('@hushbox/ui/accessibility/store');
  return {
    TtsStoppedNotice: ({ messageId }: { messageId: string }) => {
      const stopped = useTtsPlaybackStore((s) => s.stoppedStreamIds.has(messageId));
      if (!stopped) return null;
      return (
        <div data-testid="mock-tts-stopped-notice" data-message-id={messageId}>
          You can disable auto-read in Accessibility settings
        </div>
      );
    },
  };
});

vi.mock('@/stores/document', () => ({
  useDocumentStore: () => ({
    activeDocumentId: null,
    setActiveDocument: vi.fn(),
  }),
}));

// MarkdownRenderer is consumed via React.lazy(() => import('@/components/chat/message/markdown-renderer')).
// Stub it with a lightweight double so the dynamic import resolves promptly:
// the real streamdown/shiki/katex stack pulls its own lazy chunks that never
// settle under jsdom. Markdown rendering itself (links, code, math) is covered
// directly in markdown-renderer.test.tsx. The stub honours the contract
// message-item relies on — the markdown-renderer testid and forwarded props
// surfaced as data attributes (React.lazy captures the resolved component, so
// forwarding is asserted via the DOM rather than a spy on the named export).
// `mockMarkdownSuspendForever` holds the stub in a synchronously-suspended state
// so the outer Suspense fallback (the plain-text first paint) is observable;
// once React.lazy resolves the first time it stays resolved file-wide, so the
// natural unresolved state can't otherwise be re-observed.
const mockMarkdownSuspendForever = { current: false };
const neverResolves = new Promise<never>(() => {});
vi.mock('@/components/chat/message/markdown-renderer', () => ({
  MarkdownRenderer: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => {
    // Throwing a never-resolving promise is React Suspense's contract for
    // "still loading" — that is what keeps the outer fallback visible here.
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Suspense suspends by throwing a thenable, not an Error
    if (mockMarkdownSuspendForever.current) throw neverResolves;
    return (
      <div data-testid="markdown-renderer" data-streaming={isStreaming === true ? 'true' : 'false'}>
        {content}
      </div>
    );
  },
}));

// Which blocks a reader opened is app-wide view state, so each test starts closed.
beforeEach(() => {
  useSegmentViewState.setState({ open: new Set() });
});

const mockModelsData: { data: ModelsData; isLoading: boolean } = {
  data: {
    models: [
      {
        id: 'anthropic/claude-3-5-sonnet-20241022',
        name: 'Claude 3.5 Sonnet',
        provider: 'Anthropic',
        modality: 'text',
        contextLength: 200_000,
        description: 'Claude model',
        supportedParameters: [],
        pricing: { inputPerToken: '3000', outputPerToken: '15000' },
      },
      {
        id: 'openai/gpt-4o-2024-08-06',
        name: 'GPT-4o',
        provider: 'OpenAI',
        modality: 'text',
        contextLength: 128_000,
        description: 'GPT model',
        supportedParameters: [],
        pricing: { inputPerToken: '5000', outputPerToken: '15000' },
      },
      {
        id: 'smart-model',
        name: 'Smart Model',
        provider: 'HushBox',
        modality: 'text',
        contextLength: 200_000,
        description: 'Auto-router model',
        supportedParameters: [],
        isSmartModel: true,
        pricing: { inputPerToken: '3000', outputPerToken: '15000' },
      },
    ],
    premiumIds: new Set<string>(),
  },
  isLoading: false,
};

// Mock MediaContentItem to avoid the full fetch + decrypt chain in tests, but
// keep the real `messageMediaToRenderable` mapper the bubble uses to normalize
// media. Tests assert one <MediaContentItem> renders per media item.
vi.mock('@/components/chat/media/media-content-item', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/chat/media/media-content-item')>()),
  MediaContentItem: ({ item }: { item: { contentItemId: string; contentType: string } }) => (
    <div
      data-testid={`mock-media-item-${item.contentItemId}`}
      data-content-type={item.contentType}
    />
  ),
}));

// Stub the epoch key cache + crypto primitives to count content-key unwraps.
// We assert the unwrap runs once per message regardless of how many media items
// the message carries (the content key is hoisted to the parent). `asEpochPrivateKey`
// is stubbed to identity so the fake short epoch key isn't length-validated.
const mockUnwrapContentKeyFromEpoch = vi.fn(() => new Uint8Array([1, 2, 3]));
vi.mock('@hushbox/crypto', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/crypto')>();
  return {
    ...original,
    asEpochPrivateKey: (key: Uint8Array) => key,
    unwrapContentKeyFromEpoch: (...args: unknown[]) =>
      mockUnwrapContentKeyFromEpoch(...(args as [])),
  };
});
vi.mock('@/lib/crypto/epoch-key-cache', () => ({
  getEpochKey: vi.fn(() => new Uint8Array([9, 9, 9])),
  setEpochKey: vi.fn(),
  subscribe: vi.fn(() => () => {}),
  getSnapshot: vi.fn(() => 0),
}));

const ALL_USER_ACTIONS = new Set<MessageAction>(['copy', 'retry', 'edit', 'fork']);
const ALL_AI_ACTIONS = new Set<MessageAction>(['copy', 'regenerate', 'fork', 'share']);
const NO_ACTIONS = new Set<MessageAction>();
const ERROR_AI_ACTIONS = new Set<MessageAction>(['copy', 'regenerate']);

describe('MessageItem', () => {
  const userMessage = {
    id: '1',
    conversationId: 'conv-1',
    role: 'user' as const,
    content: 'Hello, how are you?',
    createdAt: isoAt(TEST_DAY_START),
  };

  const assistantMessage = {
    id: '2',
    conversationId: 'conv-1',
    role: 'assistant' as const,
    content: 'I am doing well, thank you!',
    createdAt: isoAt(TEST_DAY_START + SECOND_MS),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    // The copy confirmation resets on a timer, which is a state update.
    act(() => {
      vi.runOnlyPendingTimers();
    });
    vi.useRealTimers();
  });

  it('renders message content', () => {
    renderWithProviders(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    expect(screen.getByText('Hello, how are you?')).toBeInTheDocument();
  });

  it('renders user message with user styling', () => {
    renderWithProviders(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveAttribute('data-role', 'user');
  });

  it('renders assistant message with assistant styling', () => {
    renderWithProviders(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveAttribute('data-role', 'assistant');
  });

  it('sets each message in the chat column: the chat measure, centred', () => {
    renderWithProviders(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const column = screen.getByTestId('message-item').parentElement;
    expect(column).toHaveClass('mx-auto', 'box-content');
    expect(column?.style.maxWidth).toBe(LAYOUT.measureChat);
  });

  it("gives the chat column the composer's gutters", () => {
    renderWithProviders(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const column = screen.getByTestId('message-item').parentElement;
    expect(column).toHaveClass('px-4', 'md:px-6');
  });

  it('applies fit-content width with right alignment for user messages', () => {
    renderWithProviders(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('w-fit');
    expect(container).toHaveClass('ml-auto');
    expect(container).toHaveClass('max-w-[82%]');
    expect(container).not.toHaveClass('mr-4');
  });

  it('lets an assistant message fill the column with no inset of its own', () => {
    renderWithProviders(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    expect(container).toHaveClass('w-full');
    expect(container).not.toHaveClass('px-4');
  });

  it('wraps text at word boundaries for user messages', () => {
    renderWithProviders(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
    const text = screen.getByText(userMessage.content);
    expect(text).toHaveClass('break-words');
    expect(text).not.toHaveClass('break-all');
  });

  it('wraps text at word boundaries for assistant messages', () => {
    renderWithProviders(<MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />);
    const container = screen.getByTestId('message-item');
    const contentDiv = container.querySelector('.break-words');
    expect(contentDiv).toBeInTheDocument();
  });

  describe('a message whose sender deleted their account', () => {
    const deletedMessage: Message = {
      id: 'deleted-1',
      conversationId: 'conv-1',
      role: 'user',
      content: '',
      createdAt: '',
      deleted: true,
    };
    const deletedGroup: MessageGroup = {
      id: 'deleted-1',
      role: 'user',
      messages: [deletedMessage],
    };

    it('renders Message deleted with its test id', () => {
      renderWithProviders(
        <MessageItem message={deletedMessage} allowedActions={ALL_USER_ACTIONS} />
      );

      expect(screen.getByTestId(TEST_IDS.messageDeleted)).toHaveTextContent('Message deleted');
    });

    it('renders no action buttons even when the actions are allowed', () => {
      renderWithProviders(
        <MessageItem message={deletedMessage} allowedActions={ALL_USER_ACTIONS} />
      );

      expect(screen.queryByTestId(TEST_IDS.messageActions)).not.toBeInTheDocument();
      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('unwraps no content key for a deleted message', () => {
      mockUnwrapContentKeyFromEpoch.mockClear();

      renderWithProviders(
        <MessageItem
          message={{ ...deletedMessage, wrappedContentKey: 'd3JhcA==', epochNumber: 1 }}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      expect(mockUnwrapContentKeyFromEpoch).not.toHaveBeenCalled();
    });

    it('renders Message deleted in a group chat', () => {
      renderWithProviders(
        <MessageItem
          message={deletedMessage}
          group={deletedGroup}
          isGroupChat
          currentUserId="user-1"
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      expect(screen.getByTestId(TEST_IDS.messageDeleted)).toHaveTextContent('Message deleted');
      expect(screen.queryByTestId(TEST_IDS.messageActions)).not.toBeInTheDocument();
    });

    it('renders a live message with its content and no deleted notice', () => {
      renderWithProviders(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);

      expect(screen.getByText(userMessage.content)).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.messageActions)).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.messageDeleted)).not.toBeInTheDocument();
    });
  });

  describe('copy button', () => {
    it('renders copy button for each message', () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copies message content to clipboard when clicked', async () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

      expect(assistantMessage.content).toBe('I am doing well, thank you!');
    });

    it('copies only the answer of a reasoning-bearing assistant message', async () => {
      // Store raw, parse on demand: reasoning rides in the same text field, and
      // every user-facing surface, the clipboard included, emits the answer.
      const reasoningMessage = {
        ...assistantMessage,
        content: withReasoning('secret thoughts', 'The answer.'),
      };
      renderWithProviders(
        <MessageItem message={reasoningMessage} allowedActions={ALL_AI_ACTIONS} />
      );

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      await act(async () => {
        await Promise.resolve();
      });

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('The answer.');
    });

    it('copies the answer text either side of a search row, joined by a blank line', async () => {
      const searched = {
        ...assistantMessage,
        content: serializeSegments([
          { kind: 'text', text: 'Let me look.' },
          {
            kind: 'webSearch',
            row: {
              v: 1,
              searches: [{ query: 'q', status: 'done', sources: [] }],
              notRun: { limit: 0, invalidQuery: 0 },
            },
          },
          { kind: 'text', text: 'Found it.' },
        ]),
      };
      renderWithProviders(<MessageItem message={searched} allowedActions={ALL_AI_ACTIONS} />);

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      await act(async () => {
        await Promise.resolve();
      });

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Let me look.\n\nFound it.');
    });

    it('parses the raw text field once for the whole row', () => {
      const reasoningMessage = {
        ...assistantMessage,
        content: withReasoning('secret thoughts', 'The answer.'),
      };
      messageParses.current = 0;

      renderWithProviders(
        <MessageItem message={reasoningMessage} allowedActions={ALL_AI_ACTIONS} />
      );

      expect(messageParses.current).toBe(1);
    });

    it("never parses a user bubble's text", () => {
      messageParses.current = 0;

      renderWithProviders(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);

      expect(messageParses.current).toBe(0);
    });

    it('copies user message content verbatim', async () => {
      // User content is never parsed — matches display, which renders it raw.
      const raw = withReasoning('typed by a user', 'literally');
      renderWithProviders(
        <MessageItem message={{ ...userMessage, content: raw }} allowedActions={ALL_USER_ACTIONS} />
      );

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      await act(async () => {
        await Promise.resolve();
      });

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(raw);
    });

    it('shows copied feedback after clicking', async () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();
    });

    it('resets to copy state after delay', async () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      await act(async () => {
        await Promise.resolve();
      });

      expect(screen.getByRole('button', { name: /copied/i })).toBeInTheDocument();

      act(() => {
        vi.advanceTimersByTime(2500);
      });

      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('copies a multi-kilobyte message body in full', async () => {
      const longBody = Array.from(
        { length: 400 },
        (_, index) => `Paragraph ${String(index)} of a long assistant answer.`
      ).join('\n\n');
      expect(longBody.length).toBeGreaterThan(4000);
      renderWithProviders(
        <MessageItem
          message={{ ...assistantMessage, content: longBody }}
          allowedActions={ALL_AI_ACTIONS}
        />
      );

      fireEvent.click(screen.getByRole('button', { name: /copy/i }));

      await act(async () => {
        await Promise.resolve();
      });

      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(longBody);
    });

    it('draws the copy button as a 2rem ghost icon button', () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );
      const button = screen.getByRole('button', { name: /copy/i });
      expect(button).toHaveAttribute('data-slot', 'icon-button');
      expect(button).toHaveAttribute('data-variant', 'ghost');
      expect(button).toHaveClass('size-8');
    });

    it('grows the copy button to a 2.75rem target on a coarse pointer', () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /copy/i })).toHaveClass('pointer-coarse:size-11');
    });

    it('lays the controls in the row rather than over the next one', () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );
      const controls = screen.getByTestId(TEST_IDS.messageActions);
      expect(controls).not.toHaveClass('absolute');
      expect(controls.parentElement).not.toHaveClass('absolute');
      expect(screen.getByTestId('message-item')).toContainElement(controls);
    });
  });

  describe('error messages', () => {
    const errorMessage = {
      id: 'err-1',
      conversationId: 'conv-1',
      role: 'assistant' as const,
      content: 'Please wait for your current messages to finish.',
      createdAt: isoAt(TEST_DAY_START),
    };

    it('renders error content with markdown', async () => {
      renderWithProviders(
        <MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />
      );
      // MarkdownRenderer is lazy; flush the dynamic-import microtask under fake
      // timers (findBy/waitFor poll on timers that fake timers stall).
      await act(async () => {});
      const renderer = screen.getByTestId('markdown-renderer');
      expect(renderer).toHaveTextContent('Please wait for your current messages to finish.');
    });

    it('renders with assistant styling (data-role=assistant)', () => {
      renderWithProviders(
        <MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />
      );
      const container = screen.getByTestId('message-item');
      expect(container).toHaveAttribute('data-role', 'assistant');
    });

    it('renders copy button on errored assistant messages', () => {
      // With the standalone retry button removed, the toolbar carries every
      // affordance — including Copy — even on errored turns. Pre-fix, errored
      // messages had only the orphan Retry button and no toolbar.
      renderWithProviders(
        <MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it('does not render a standalone retry-error button (folded into toolbar Regenerate)', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageItem
          message={errorMessage}
          isError
          onRegenerate={onRegenerate}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      // The dedicated `retry-error-button` testid belonged to the lone
      // RetryButton that rendered above the error bubble; deleting it removes
      // the duplicate retry affordance and the misplaced position.
      expect(screen.queryByTestId('retry-error-button')).not.toBeInTheDocument();
    });

    it('renders Regenerate in the toolbar on errored assistant messages', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageItem
          message={errorMessage}
          isError
          onRegenerate={onRegenerate}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
    });

    it('calls onRegenerate when the errored message Regenerate button is clicked', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageItem
          message={errorMessage}
          isError
          onRegenerate={onRegenerate}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));
      expect(onRegenerate).toHaveBeenCalledWith(errorMessage.id);
    });

    it('marks Regenerate unavailable when the money verdict refuses it', () => {
      renderWithProviders(
        <MessageItem
          message={errorMessage}
          isError
          onRegenerate={vi.fn()}
          allowedActions={ERROR_AI_ACTIONS}
          regenerateRefusal="insufficient_funds"
        />
      );
      expect(screen.getByRole('button', { name: /regenerate/i })).toHaveAttribute(
        'aria-disabled',
        'true'
      );
    });

    it('does not regenerate when the money verdict refuses it', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageItem
          message={errorMessage}
          isError
          onRegenerate={onRegenerate}
          allowedActions={ERROR_AI_ACTIONS}
          regenerateRefusal="insufficient_funds"
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));
      expect(onRegenerate).not.toHaveBeenCalled();
    });

    it('gives the refused Regenerate an accessible description naming the reason', () => {
      renderWithProviders(
        <MessageItem
          message={errorMessage}
          isError
          onRegenerate={vi.fn()}
          allowedActions={ERROR_AI_ACTIONS}
          regenerateRefusal="funds_held_by_run"
        />
      );
      const button = screen.getByRole('button', { name: /regenerate/i });
      const describedBy = button.getAttribute('aria-describedby');
      expect(describedBy).not.toBeNull();
      expect(document.querySelector(`#${describedBy ?? ''}`)).toHaveTextContent(
        noticeText('funds_held_by_run')
      );
    });

    it('leaves Regenerate available when the money verdict permits it', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageItem
          message={errorMessage}
          isError
          onRegenerate={onRegenerate}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      const button = screen.getByRole('button', { name: /regenerate/i });
      expect(button).not.toHaveAttribute('aria-disabled');
      fireEvent.click(button);
      expect(onRegenerate).toHaveBeenCalledWith(errorMessage.id);
    });

    it('applies error styling with data-error attribute', () => {
      renderWithProviders(
        <MessageItem message={errorMessage} isError allowedActions={ERROR_AI_ACTIONS} />
      );
      const container = screen.getByTestId('message-item');
      expect(container).toHaveAttribute('data-error', 'true');
    });

    it('does not set data-error on non-error messages', () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );
      const container = screen.getByTestId('message-item');
      expect(container).not.toHaveAttribute('data-error');
    });
  });

  // Retry re-runs the turn through the same handler Regenerate uses, so it is the
  // same paid action and carries the same verdict.
  describe('retry on a user message', () => {
    it('marks Retry unavailable when the money verdict refuses it', () => {
      renderWithProviders(
        <MessageItem
          message={userMessage}
          allowedActions={ALL_USER_ACTIONS}
          onRegenerate={vi.fn()}
          regenerateRefusal="insufficient_funds"
        />
      );
      expect(screen.getByRole('button', { name: /retry/i })).toHaveAttribute(
        'aria-disabled',
        'true'
      );
    });

    it('does not retry when the money verdict refuses it', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageItem
          message={userMessage}
          allowedActions={ALL_USER_ACTIONS}
          onRegenerate={onRegenerate}
          regenerateRefusal="insufficient_funds"
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      expect(onRegenerate).not.toHaveBeenCalled();
    });

    it('leaves Retry available when the money verdict permits it', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageItem
          message={userMessage}
          allowedActions={ALL_USER_ACTIONS}
          onRegenerate={onRegenerate}
        />
      );
      const button = screen.getByRole('button', { name: /retry/i });
      expect(button).not.toHaveAttribute('aria-disabled');
      fireEvent.click(button);
      expect(onRegenerate).toHaveBeenCalledWith(userMessage.id);
    });
  });

  describe('share button', () => {
    it('renders share button for assistant messages', () => {
      const onShare = vi.fn();
      renderWithProviders(
        <MessageItem message={assistantMessage} onShare={onShare} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /share/i })).toBeInTheDocument();
    });

    it('does not render share button for user messages', () => {
      const onShare = vi.fn();
      renderWithProviders(
        <MessageItem message={userMessage} onShare={onShare} allowedActions={ALL_USER_ACTIONS} />
      );
      expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
    });

    it('calls onShare with message id when clicked', () => {
      const onShare = vi.fn();
      renderWithProviders(
        <MessageItem message={assistantMessage} onShare={onShare} allowedActions={ALL_AI_ACTIONS} />
      );
      fireEvent.click(screen.getByRole('button', { name: /share/i }));
      expect(onShare).toHaveBeenCalledWith('2');
    });

    it('does not render share button when onShare is not provided', () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
    });

    it('does not render share button for error messages', () => {
      const errorMsg = {
        id: 'err-1',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Error occurred',
        createdAt: isoAt(TEST_DAY_START),
      };
      const onShare = vi.fn();
      renderWithProviders(
        <MessageItem
          message={errorMsg}
          isError
          onShare={onShare}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      expect(screen.queryByRole('button', { name: /share/i })).not.toBeInTheDocument();
    });
  });

  describe('assistant footer row', () => {
    const assistantMessageWithCost = {
      ...assistantMessage,
      cost: '1360000',
    };

    it('right-justifies the controls in the footer row', () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getByTestId(TEST_IDS.messageActions)).toHaveClass('ml-auto');
    });

    it('puts the cost at the start of the row, before the controls', () => {
      renderWithProviders(
        <MessageItem message={assistantMessageWithCost} allowedActions={ALL_AI_ACTIONS} />
      );
      const cost = screen.getByTestId('message-cost');
      const controls = screen.getByTestId(TEST_IDS.messageActions);
      expect(cost.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it('keeps the cost out of the controls group', () => {
      renderWithProviders(
        <MessageItem message={assistantMessageWithCost} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getByTestId(TEST_IDS.messageActions)).not.toContainElement(
        screen.getByTestId('message-cost')
      );
    });

    it('shares one row between the cost and the controls', () => {
      renderWithProviders(
        <MessageItem message={assistantMessageWithCost} allowedActions={ALL_AI_ACTIONS} />
      );
      const row = screen.getByTestId(TEST_IDS.messageActions).parentElement;
      expect(row).toContainElement(screen.getByTestId('message-cost'));
      expect(row).toHaveClass('flex', 'items-center');
    });

    it('shows the cost of a reply that offers no controls', () => {
      renderWithProviders(
        <MessageItem message={assistantMessageWithCost} allowedActions={NO_ACTIONS} />
      );
      expect(screen.getByTestId('message-cost')).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.messageActions)).not.toBeInTheDocument();
    });

    it('holds the touch-sized control row open while a reply streams, so nothing jumps', () => {
      renderWithProviders(
        <MessageItem message={assistantMessageWithCost} allowedActions={NO_ACTIONS} />
      );
      expect(screen.getByTestId('message-cost').parentElement).toHaveClass(
        'min-h-8',
        'pointer-coarse:min-h-11'
      );
    });

    it('draws no footer row while a reply streams', () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} isStreaming allowedActions={NO_ACTIONS} />
      );
      expect(screen.queryByTestId(TEST_IDS.messageActions)).not.toBeInTheDocument();
      expect(screen.queryByTestId('message-cost')).not.toBeInTheDocument();
    });
  });

  describe('a long unbroken string', () => {
    const longRun = 'x'.repeat(500);

    it('caps your own bubble at the width of its message, so the string wraps inside it', () => {
      renderWithProviders(
        <MessageItem message={{ ...userMessage, content: longRun }} allowedActions={NO_ACTIONS} />
      );
      expect(screen.getByText(longRun).closest('.bg-message-user')).toHaveClass(
        'min-w-0',
        'max-w-full'
      );
    });

    it("caps another member's bubble at the width of its message", () => {
      const msg = { ...userMessage, content: longRun, senderId: 'user-2' };
      const group: MessageGroup = { id: '1', role: 'user', senderId: 'user-2', messages: [msg] };
      renderWithProviders(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.getByText(longRun).closest('.bg-muted')).toHaveClass('min-w-0', 'max-w-full');
    });
  });

  describe('user message controls', () => {
    it('sets the controls under the bubble, right-justified', () => {
      renderWithProviders(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
      const controls = screen.getByTestId(TEST_IDS.messageActions);
      const bubble = screen.getByText(userMessage.content);
      expect(bubble.compareDocumentPosition(controls) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
      expect(controls.parentElement).toHaveClass('items-end');
    });

    it("keeps another member's controls at the bubble's right end", () => {
      const msg = { ...userMessage, senderId: 'user-2' };
      const group: MessageGroup = { id: '1', role: 'user', senderId: 'user-2', messages: [msg] };
      renderWithProviders(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          allowedActions={new Set<MessageAction>(['copy'])}
        />
      );
      const controls = screen.getByTestId(TEST_IDS.messageActions);
      expect(controls.parentElement).not.toHaveClass('items-end');
      expect(controls).toHaveClass('justify-end');
    });
  });

  describe('streaming', () => {
    it('forwards isStreaming=true to MarkdownRenderer', async () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} isStreaming allowedActions={NO_ACTIONS} />
      );

      await act(async () => {});
      expect(screen.getByTestId('markdown-renderer')).toHaveAttribute('data-streaming', 'true');
    });

    it('forwards isStreaming=undefined when not set', async () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );

      await act(async () => {});
      expect(screen.getByTestId('markdown-renderer')).toHaveAttribute('data-streaming', 'false');
    });

    it('paints streaming text via the plain-text fallback while the markdown renderer is loading', () => {
      // The markdown stack is lazy-loaded behind Suspense. While it loads, the
      // fallback must show the raw text so a streaming token is visible without
      // waiting for streamdown/shiki/katex to download.
      mockMarkdownSuspendForever.current = true;
      try {
        const streamingMsg = {
          id: 'stream-1',
          conversationId: 'conv-1',
          role: 'assistant' as const,
          content: 'partial answer so far',
          createdAt: isoAt(TEST_DAY_START),
        };
        renderWithProviders(
          <MessageItem message={streamingMsg} isStreaming allowedActions={NO_ACTIONS} />
        );

        // Markdown renderer still loading: raw text shows, renderer absent.
        expect(screen.getByText('partial answer so far')).toBeInTheDocument();
        expect(screen.queryByTestId('markdown-renderer')).not.toBeInTheDocument();
      } finally {
        mockMarkdownSuspendForever.current = false;
      }
    });

    it('swaps the fallback for the markdown renderer once it loads', async () => {
      const streamingMsg = {
        id: 'stream-2',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'final answer',
        createdAt: isoAt(TEST_DAY_START),
      };
      renderWithProviders(
        <MessageItem message={streamingMsg} isStreaming allowedActions={NO_ACTIONS} />
      );

      await act(async () => {});
      expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
    });

    it('marks the streaming AI message container with aria-live="polite"', () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} isStreaming allowedActions={NO_ACTIONS} />
      );
      const live = screen.getByTestId('ai-message-live-region');
      expect(live).toHaveAttribute('aria-live', 'polite');
    });

    it('does not mark non-streaming AI message text with aria-live', () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );
      const region = screen.queryByTestId('ai-message-live-region');
      if (region) expect(region.getAttribute('aria-live')).toBe('off');
    });
  });

  describe('thinking indicator', () => {
    const emptyAssistantMessage = {
      id: 'thinking-1',
      conversationId: 'conv-1',
      role: 'assistant' as const,
      content: '',
      createdAt: isoAt(TEST_DAY_START),
    };

    it('shows thinking indicator when streaming with empty content', () => {
      renderWithProviders(
        <MessageItem
          message={emptyAssistantMessage}
          isStreaming
          modelName="Claude"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.getByTestId('thinking-indicator')).toBeInTheDocument();
    });

    it('does not show thinking indicator when content is non-empty', () => {
      renderWithProviders(
        <MessageItem
          message={assistantMessage}
          isStreaming
          modelName="Claude"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    it('does not show thinking indicator when not streaming', () => {
      renderWithProviders(
        <MessageItem
          message={emptyAssistantMessage}
          modelName="Claude"
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    it('does not show thinking indicator for user messages', () => {
      const emptyUserMessage = {
        id: 'user-empty',
        conversationId: 'conv-1',
        role: 'user' as const,
        content: '',
        createdAt: isoAt(TEST_DAY_START),
      };
      renderWithProviders(
        <MessageItem
          message={emptyUserMessage}
          isStreaming
          modelName="Claude"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });

    it('displays model name in thinking indicator', () => {
      renderWithProviders(
        <MessageItem
          message={emptyAssistantMessage}
          isStreaming
          modelName="GPT-4 Turbo"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.getByText('GPT-4 Turbo is thinking')).toBeInTheDocument();
    });

    it('resolves auto model ID to display name in thinking indicator', () => {
      const autoMessage = {
        ...emptyAssistantMessage,
        id: 'auto-thinking',
        modelName: 'smart-model',
      };
      renderWithProviders(
        <MessageItem
          message={autoMessage}
          isStreaming
          modelName="smart-model"
          allowedActions={NO_ACTIONS}
          models={mockModelsData.data}
        />
      );
      expect(screen.getByText('Smart Model is thinking')).toBeInTheDocument();
    });

    it('resolves auto model ID from modelName prop in thinking indicator', () => {
      renderWithProviders(
        <MessageItem
          message={emptyAssistantMessage}
          isStreaming
          modelName="smart-model"
          allowedActions={NO_ACTIONS}
          models={mockModelsData.data}
        />
      );
      expect(screen.getByText('Smart Model is thinking')).toBeInTheDocument();
    });

    it('shows MarkdownRenderer when streaming with content', async () => {
      renderWithProviders(
        <MessageItem
          message={assistantMessage}
          isStreaming
          modelName="Claude"
          allowedActions={NO_ACTIONS}
        />
      );
      await act(async () => {});
      expect(screen.getByTestId('markdown-renderer')).toBeInTheDocument();
      expect(screen.queryByTestId('thinking-indicator')).not.toBeInTheDocument();
    });
  });

  describe('group chat rendering', () => {
    const members = [
      { id: 'member-1', userId: 'user-1', username: 'alice', privilege: 'owner' },
      { id: 'member-2', userId: 'user-2', username: 'bob', privilege: 'admin' },
    ];

    function createMsg(overrides: Partial<Message> = {}): Message {
      return {
        id: crypto.randomUUID(),
        conversationId: 'conv-1',
        role: 'user',
        content: 'test',
        createdAt: isoAt(TEST_DAY_START),
        ...overrides,
      };
    }

    it('shows sender label "You" for own user message group', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-1', content: 'Hello' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-1', messages: [msg] };

      renderWithProviders(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('You');
    });

    it('shows sender username for other member message group', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-2', content: 'Hi there' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-2', messages: [msg] };

      renderWithProviders(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('bob');
    });

    it('shows left user label for unknown senderId', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-deleted', content: 'Old message' });
      const group: MessageGroup = {
        id: 'm1',
        role: 'user',
        senderId: 'user-deleted',
        messages: [msg],
      };

      renderWithProviders(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('This user has left the conversation');
    });

    it('shows link guest displayName when senderId matches a link', () => {
      const links = [
        {
          id: 'link-001',
          displayName: 'Guest Alice',
          privilege: 'write',
          createdAt: isoAt(TEST_DAY_START),
        },
      ];
      const msg = createMsg({ id: 'm1', senderId: 'link-001', content: 'Guest message' });
      const group: MessageGroup = {
        id: 'm1',
        role: 'user',
        senderId: 'link-001',
        messages: [msg],
      };

      renderWithProviders(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          links={links}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const label = screen.getByTestId('sender-label');
      expect(label).toHaveTextContent('Guest Alice');
    });

    it('renders multiple messages in one group bubble', () => {
      const msg1 = createMsg({ id: 'm1', senderId: 'user-1', content: 'First message' });
      const msg2 = createMsg({ id: 'm2', senderId: 'user-1', content: 'Second message' });
      const group: MessageGroup = {
        id: 'm1',
        role: 'user',
        senderId: 'user-1',
        messages: [msg1, msg2],
      };

      renderWithProviders(
        <MessageItem
          message={msg1}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      expect(screen.getByText('First message')).toBeInTheDocument();
      expect(screen.getByText('Second message')).toBeInTheDocument();
      expect(screen.getAllByTestId('sender-label')).toHaveLength(1);
    });

    it('applies left alignment for other member messages', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-2', content: 'Bob says hi' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-2', messages: [msg] };

      renderWithProviders(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).not.toHaveClass('ml-4');
      expect(messageItem).toHaveClass('mr-auto');
    });

    it('applies right alignment for own messages', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-1', content: 'My message' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-1', messages: [msg] };

      renderWithProviders(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).not.toHaveClass('mr-4');
      expect(messageItem).toHaveClass('ml-auto');
    });

    it('uses bg-muted for other member bubbles', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-2', content: 'Bob says' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-2', messages: [msg] };

      renderWithProviders(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      const bubble = messageItem.querySelector('.bg-muted');
      expect(bubble).toBeInTheDocument();
    });

    it('uses bg-message-user for own message bubbles in group', () => {
      const msg = createMsg({ id: 'm1', senderId: 'user-1', content: 'My msg' });
      const group: MessageGroup = { id: 'm1', role: 'user', senderId: 'user-1', messages: [msg] };

      renderWithProviders(
        <MessageItem
          message={msg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_USER_ACTIONS}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      const bubble = messageItem.querySelector('.bg-message-user');
      expect(bubble).toBeInTheDocument();
    });

    it('does not show sender label for AI messages in group chat', () => {
      const aiMsg = createMsg({ id: 'ai1', role: 'assistant', content: 'AI response' });
      const group: MessageGroup = { id: 'ai1', role: 'assistant', messages: [aiMsg] };

      renderWithProviders(
        <MessageItem
          message={aiMsg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_AI_ACTIONS}
        />
      );

      expect(screen.queryByTestId('sender-label')).not.toBeInTheDocument();
    });

    it('renders AI messages full-width in group chat (same as 1:1)', () => {
      const aiMsg = createMsg({ id: 'ai1', role: 'assistant', content: 'AI response' });
      const group: MessageGroup = { id: 'ai1', role: 'assistant', messages: [aiMsg] };

      renderWithProviders(
        <MessageItem
          message={aiMsg}
          group={group}
          isGroupChat
          currentUserId="user-1"
          members={members}
          allowedActions={ALL_AI_ACTIONS}
        />
      );

      const messageItem = screen.getByTestId('message-item');
      expect(messageItem).toHaveClass('w-full');
      expect(messageItem).not.toHaveClass('px-4');
    });

    it('does not show sender label in 1:1 mode (no group prop)', () => {
      renderWithProviders(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
      expect(screen.queryByTestId('sender-label')).not.toBeInTheDocument();
    });
  });

  describe('model nametag', () => {
    it('shows model nametag from message.modelName', () => {
      const aiMsg = {
        id: 'ai-1',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'GPT-4o',
      };
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('GPT-4o');
    });

    it('shows streaming modelName when message has no modelName', () => {
      const aiMsg = {
        id: 'ai-2',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: isoAt(TEST_DAY_START),
        modelName: null,
      };
      renderWithProviders(
        <MessageItem
          message={aiMsg}
          modelName="Claude 3.5 Sonnet"
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('Claude 3.5 Sonnet');
    });

    it('shows "AI" fallback when neither source has modelName', () => {
      const aiMsg = {
        id: 'ai-3',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: isoAt(TEST_DAY_START),
        modelName: null,
      };
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('AI');
    });

    it('does not show nametag on user messages', () => {
      renderWithProviders(<MessageItem message={userMessage} allowedActions={ALL_USER_ACTIONS} />);
      expect(screen.queryByTestId('model-nametag')).not.toBeInTheDocument();
    });

    // The a11y "Easier to read" preset applies `line-height: 2 !important` to
    // <p> elements via `html.a11y-line-height-double p`. If the nametag is a
    // <p>, it gets distorted relative to the inline Smart chip (a <span>),
    // breaking the visual centering of the two badges.
    it('does not render the nametag as a <p> element', () => {
      const aiMsg = {
        id: 'ai-tag',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'GPT-4o',
      };
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag.tagName).not.toBe('P');
    });

    it('renders the Smart chip when isSmartModel is true', () => {
      const knownModel = mockModelsData.data.models[0];
      if (!knownModel) throw new Error('test fixture must include at least one model');
      const aiMsg = {
        id: 'ai-smart',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Routed by Smart Model',
        createdAt: isoAt(TEST_DAY_START),
        modelName: knownModel.id,
        isSmartModel: true,
      };
      renderWithProviders(
        <MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} models={mockModelsData.data} />
      );
      expect(screen.getByTestId('smart-model-chip')).toBeInTheDocument();
      expect(screen.getByTestId('model-nametag')).toHaveTextContent(knownModel.name);
    });

    it('does not render the Smart chip when isSmartModel is absent', () => {
      const knownModel = mockModelsData.data.models[0];
      if (!knownModel) throw new Error('test fixture must include at least one model');
      const aiMsg = {
        id: 'ai-non-smart',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Direct selection',
        createdAt: isoAt(TEST_DAY_START),
        modelName: knownModel.id,
      };
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId('smart-model-chip')).not.toBeInTheDocument();
    });
  });

  describe('reasoning effort rung', () => {
    function aiMessageWithLevel(reasoningEffort?: ResolvedReasoningEffort): Message {
      const knownModel = mockModelsData.data.models[0];
      if (!knownModel) throw new Error('test fixture must include at least one model');
      return {
        id: 'ai-effort',
        conversationId: 'conv-1',
        role: 'assistant',
        content: withReasoning('Weighing the options.', 'An answer'),
        createdAt: isoAt(TEST_DAY_START),
        modelName: knownModel.id,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      };
    }

    // Inverted from four assertions that placed the rung in the nametag as an
    // uppercase bordered chip. A reasoned turn stacked three cost idioms in
    // three vocabularies (chip, token count, money); the rung now rides the
    // reasoning row, which takes that to two.
    it('renders no effort chip beside the model name', async () => {
      renderWithProviders(
        <MessageItem message={aiMessageWithLevel('high')} allowedActions={ALL_AI_ACTIONS} />
      );
      await act(async () => {});
      expect(screen.queryByTestId('message-effort-chip')).not.toBeInTheDocument();
    });

    it('labels the reasoning row with the resolved level', async () => {
      renderWithProviders(
        <MessageItem message={aiMessageWithLevel('high')} allowedActions={ALL_AI_ACTIONS} />
      );
      await act(async () => {});
      expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent(
        'Reasoning · High effort'
      );
    });

    it('labels the row with no rung when no level was recorded', async () => {
      renderWithProviders(
        <MessageItem message={aiMessageWithLevel()} allowedActions={ALL_AI_ACTIONS} />
      );
      await act(async () => {});
      expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent('Reasoning');
      expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).not.toHaveTextContent('effort');
    });

    it('labels multi-model siblings with their own levels, so a downgraded one says so', async () => {
      renderWithProviders(
        <>
          <MessageItem message={aiMessageWithLevel('max')} allowedActions={ALL_AI_ACTIONS} />
          <MessageItem
            message={{ ...aiMessageWithLevel('lite'), id: 'ai-effort-sibling' }}
            allowedActions={ALL_AI_ACTIONS}
          />
        </>
      );
      await act(async () => {});
      const rows = screen.getAllByTestId(TEST_IDS.thinkingDisclosureToggle);
      expect(rows.map((row) => row.textContent)).toEqual([
        'Reasoning · Max effort',
        'Reasoning · Lite effort',
      ]);
    });

    // The ruled cost of moving the rung onto the reasoning row: a turn with no
    // reasoning has no row, so it shows no rung. Pinned so a reader meets this
    // as a decision rather than as a gap.
    it('shows no rung at all on a turn that did not reason', async () => {
      const unreasoned = {
        ...aiMessageWithLevel('high'),
        id: 'ai-effort-unreasoned',
        content: 'An answer',
      };
      renderWithProviders(<MessageItem message={unreasoned} allowedActions={ALL_AI_ACTIONS} />);
      await act(async () => {});
      expect(screen.queryByTestId(TEST_IDS.thinkingDisclosure)).not.toBeInTheDocument();
      expect(screen.queryByTestId('message-effort-chip')).not.toBeInTheDocument();
    });

    // The other retirement, and the reason it is an absence rather than a
    // label: `off` is a hard-off reasoning wire, so the generation emits no
    // trace and bills no reasoning tokens, and a turn recorded at `off` has no
    // row for a rung to ride. The Min rung is therefore unreachable on this
    // surface; the label map's own Min entry is pinned where the map is
    // defined and rendered by the composer's effort menu.
    it('shows no reasoning row on an explicit Min turn', async () => {
      const minTurn = {
        ...aiMessageWithLevel('off'),
        id: 'ai-effort-min',
        content: 'An answer',
      };
      renderWithProviders(<MessageItem message={minTurn} allowedActions={ALL_AI_ACTIONS} />);
      await act(async () => {});
      expect(screen.queryByTestId(TEST_IDS.thinkingDisclosure)).not.toBeInTheDocument();
    });
  });

  describe('TTS stop button slot', () => {
    beforeEach(() => {
      useTtsPlaybackStore.setState({
        speakingStreamId: null,
        stoppedStreamIds: new Set<string>(),
      });
    });

    afterEach(() => {
      useTtsPlaybackStore.setState({
        speakingStreamId: null,
        stoppedStreamIds: new Set<string>(),
      });
    });

    it('renders the Stop button inside model-nametag-container when this message is being read', () => {
      const aiMsg: Message = {
        id: 'speaking-msg',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      useTtsPlaybackStore.getState().setSpeakingStream('speaking-msg');
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const container = screen.getByTestId('model-nametag-container');
      expect(within(container).getByRole('button', { name: /stop reading/i })).toBeInTheDocument();
    });

    it('does not render the Stop button when no message is being read', () => {
      const aiMsg: Message = {
        id: 'idle-msg',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByRole('button', { name: /stop reading/i })).not.toBeInTheDocument();
    });

    it('does not render the Stop button when a different message is being read', () => {
      const aiMsg: Message = {
        id: 'this-msg',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      useTtsPlaybackStore.getState().setSpeakingStream('other-msg');
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByRole('button', { name: /stop reading/i })).not.toBeInTheDocument();
    });
  });

  describe('TTS stopped notice slot', () => {
    beforeEach(() => {
      useTtsPlaybackStore.setState({
        speakingStreamId: null,
        stoppedStreamIds: new Set<string>(),
      });
    });

    afterEach(() => {
      useTtsPlaybackStore.setState({
        speakingStreamId: null,
        stoppedStreamIds: new Set<string>(),
      });
    });

    it('renders the stopped notice when the user stopped this message', () => {
      const aiMsg: Message = {
        id: 'stopped-msg',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      useTtsPlaybackStore.getState().markStreamStopped('stopped-msg');
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.getByTestId('mock-tts-stopped-notice')).toHaveAttribute(
        'data-message-id',
        'stopped-msg'
      );
    });

    it('positions the notice above the message body so the body is pushed down', () => {
      const aiMsg: Message = {
        id: 'stopped-msg-pos',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello body',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      useTtsPlaybackStore.getState().markStreamStopped('stopped-msg-pos');
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const notice = screen.getByTestId('mock-tts-stopped-notice');
      const liveRegion = screen.getByTestId('ai-message-live-region');
      const position = notice.compareDocumentPosition(liveRegion);
      // DOCUMENT_POSITION_FOLLOWING (4) means liveRegion comes after the notice.
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    it('does not render the notice when the user has not stopped this message', () => {
      const aiMsg: Message = {
        id: 'untouched-msg',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId('mock-tts-stopped-notice')).not.toBeInTheDocument();
    });

    it('does not render the notice for other messages stopped by the user', () => {
      const aiMsg: Message = {
        id: 'innocent-msg',
        conversationId: 'conv-1',
        role: 'assistant',
        content: 'Hello',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'openai/gpt-4o-2024-08-06',
      };
      useTtsPlaybackStore.getState().markStreamStopped('some-other-msg');
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId('mock-tts-stopped-notice')).not.toBeInTheDocument();
    });
  });

  describe('smart-model resolution rendering', () => {
    it('uses resolvedModelName in the nametag when set live during streaming', () => {
      const aiMsg = {
        id: 'ai-resolved',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Streaming output…',
        createdAt: isoAt(TEST_DAY_START),
        // Once the classifier resolves, the optimistic message has the
        // resolved id and resolvedModelName set; the useModels lookup may not
        // yet contain the id.
        modelName: 'unknown/just-resolved',
        resolvedModelName: 'Just Resolved 4.6',
        isSmartModel: true,
      };
      renderWithProviders(
        <MessageItem message={aiMsg} isStreaming allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getByTestId('model-nametag')).toHaveTextContent('Just Resolved 4.6');
      expect(screen.getByTestId('smart-model-chip')).toBeInTheDocument();
    });

    it('renders a friendly error when the streaming slot carries an errorCode', () => {
      const aiMsg = {
        id: 'ai-stream-failed',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'smart-model',
        errorCode: 'NETWORK_ERROR',
      };
      renderWithProviders(
        <MessageItem
          message={aiMsg}
          isStreaming
          modelName="Smart Model"
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      const errorEl = screen.getByTestId('model-error-message');
      expect(errorEl).toHaveTextContent(
        "We couldn't reach the AI provider. Check your connection and try again."
      );
    });

    it.each([
      [
        'STREAM_ERROR',
        'This model stopped before it finished answering. Try again, or choose a different model.',
      ],
      ['CHAT_STREAM_FAILED', "The answer didn't reach you. Check your connection and try again."],
    ])('renders %s with its own sentence rather than the generic one', (errorCode, sentence) => {
      const aiMsg = {
        id: `ai-${errorCode}`,
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'GPT-4o',
        errorCode,
      };
      renderWithProviders(
        <MessageItem message={aiMsg} allowedActions={ERROR_AI_ACTIONS} isError />
      );
      expect(screen.getByTestId('model-error-message')).toHaveTextContent(sentence);
    });

    it('renders the generic sentence for a code outside the registry, without throwing', () => {
      const aiMsg = {
        id: 'ai-unregistered',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'GPT-4o',
        errorCode: 'A_CODE_THIS_CLIENT_DOES_NOT_KNOW',
      };
      renderWithProviders(
        <MessageItem message={aiMsg} allowedActions={ERROR_AI_ACTIONS} isError />
      );
      expect(screen.getByTestId('model-error-message')).toHaveTextContent(
        'Something went wrong. Please try again.'
      );
    });

    it('hides nametag when assistant message has no content and is not streaming', () => {
      const aiMsg = {
        id: 'ai-empty',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'GPT-4o',
      };
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId('model-nametag')).not.toBeInTheDocument();
    });

    it('shows nametag when streaming with empty content', () => {
      const aiMsg = {
        id: 'ai-streaming',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'GPT-4o',
      };
      renderWithProviders(
        <MessageItem
          message={aiMsg}
          isStreaming={true}
          modelName="GPT-4o"
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.getByTestId('model-nametag')).toBeInTheDocument();
    });

    it('shows nametag for image/video/audio messages whose body is empty but mediaItems carry media', () => {
      // Media-only assistant messages have no text body — the bytes live in
      // mediaItems. The nametag should still render so the user can see which
      // model produced the image/video/audio.
      const aiMsg = {
        id: 'ai-image',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: '',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'google/imagen-4.0-generate-001',
        mediaItems: [
          {
            id: 'ci-1',
            position: 0,
            contentType: 'image' as const,
            mimeType: 'image/jpeg',
            sizeBytes: 1024,
          },
        ],
      };
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.getByTestId('model-nametag')).toBeInTheDocument();
    });

    it('resolves model ID to display name via models list', () => {
      const aiMsg = {
        id: 'ai-resolve',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'anthropic/claude-3-5-sonnet-20241022',
      };
      renderWithProviders(
        <MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} models={mockModelsData.data} />
      );
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('Claude 3.5 Sonnet');
    });

    it('falls back to shortenModelName when model not in list', () => {
      const aiMsg = {
        id: 'ai-unknown',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'mistral/mistral-large-2024-11-01',
      };
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nametag = screen.getByTestId('model-nametag');
      expect(nametag).toHaveTextContent('mistral-large');
    });

    it("draws the message's model swatch on its nameplate", () => {
      const aiMsg = {
        id: 'ai-color',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Hello!',
        createdAt: isoAt(TEST_DAY_START),
        modelName: 'GPT-4o',
      };
      renderWithProviders(<MessageItem message={aiMsg} allowedActions={ALL_AI_ACTIONS} />);
      const nameplate = screen.getByTestId(TEST_IDS.modelNametagContainer);
      expect(nameplate.querySelector('[data-slot="swatch"]')).toHaveClass(
        `bg-model-${String(modelSwatch('GPT-4o'))}`
      );
    });
  });

  describe('regeneration buttons', () => {
    it('renders regenerate button on AI messages when onRegenerate is provided', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageItem
          message={assistantMessage}
          onRegenerate={onRegenerate}
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
    });

    it('calls onRegenerate with message id when regenerate button is clicked on AI message', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageItem
          message={assistantMessage}
          onRegenerate={onRegenerate}
          allowedActions={ALL_AI_ACTIONS}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /regenerate/i }));
      expect(onRegenerate).toHaveBeenCalledWith('2');
    });

    it('does not render regenerate button on AI messages when onRegenerate is not provided', () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
    });

    it('renders retry button on user messages when onRegenerate is provided (non-error)', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageItem
          message={userMessage}
          onRegenerate={onRegenerate}
          allowedActions={ALL_USER_ACTIONS}
        />
      );
      expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
    });

    it('calls onRegenerate with message id when retry button is clicked on user message', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageItem
          message={userMessage}
          onRegenerate={onRegenerate}
          allowedActions={ALL_USER_ACTIONS}
        />
      );
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));
      expect(onRegenerate).toHaveBeenCalledWith('1');
    });

    it('renders edit button on user messages when onEdit is provided', () => {
      const onEdit = vi.fn();
      renderWithProviders(
        <MessageItem message={userMessage} onEdit={onEdit} allowedActions={ALL_USER_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /edit/i })).toBeInTheDocument();
    });

    it('calls onEdit with message id and content when edit button is clicked', () => {
      const onEdit = vi.fn();
      renderWithProviders(
        <MessageItem message={userMessage} onEdit={onEdit} allowedActions={ALL_USER_ACTIONS} />
      );
      fireEvent.click(screen.getByRole('button', { name: /edit/i }));
      expect(onEdit).toHaveBeenCalledWith('1', 'Hello, how are you?');
    });

    it('renders fork button on AI messages when onFork is provided', () => {
      const onFork = vi.fn();
      renderWithProviders(
        <MessageItem message={assistantMessage} onFork={onFork} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getByRole('button', { name: /fork/i })).toBeInTheDocument();
    });

    it('never renders a fork button on a user message, even when the set allows it', () => {
      const onFork = vi.fn();
      renderWithProviders(
        <MessageItem message={userMessage} onFork={onFork} allowedActions={ALL_USER_ACTIONS} />
      );
      expect(screen.queryByRole('button', { name: /fork/i })).not.toBeInTheDocument();
    });

    it('calls onFork with message id when fork button is clicked', () => {
      const onFork = vi.fn();
      renderWithProviders(
        <MessageItem message={assistantMessage} onFork={onFork} allowedActions={ALL_AI_ACTIONS} />
      );
      fireEvent.click(screen.getByRole('button', { name: /fork/i }));
      expect(onFork).toHaveBeenCalledWith('2');
    });

    it('does not render regeneration buttons during streaming', () => {
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      const onFork = vi.fn();
      renderWithProviders(
        <MessageItem
          message={assistantMessage}
          isStreaming
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          onFork={onFork}
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /fork/i })).not.toBeInTheDocument();
    });

    it('does not render retry/edit on user messages during streaming', () => {
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      renderWithProviders(
        <MessageItem
          message={userMessage}
          isStreaming
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          allowedActions={NO_ACTIONS}
        />
      );
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    });

    it('does not render retry/edit/regenerate when canRegenerate is false', () => {
      const onRegenerate = vi.fn();
      const onEdit = vi.fn();
      renderWithProviders(
        <MessageItem
          message={userMessage}
          onRegenerate={onRegenerate}
          onEdit={onEdit}
          allowedActions={new Set(['copy', 'fork'] as MessageAction[])}
        />
      );
      expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    });

    it('does not render regenerate on AI message when canRegenerate is false', () => {
      const onRegenerate = vi.fn();
      renderWithProviders(
        <MessageItem
          message={assistantMessage}
          onRegenerate={onRegenerate}
          allowedActions={new Set(['copy', 'fork'] as MessageAction[])}
        />
      );
      expect(screen.queryByRole('button', { name: /regenerate/i })).not.toBeInTheDocument();
    });

    it('still renders fork button when canRegenerate is false', () => {
      const onFork = vi.fn();
      renderWithProviders(
        <MessageItem
          message={assistantMessage}
          onFork={onFork}
          allowedActions={new Set(['copy', 'fork'] as MessageAction[])}
        />
      );
      expect(screen.getByRole('button', { name: /fork/i })).toBeInTheDocument();
    });

    it('renders Regenerate (folded from the deleted Retry button) but not Fork on errored messages', () => {
      const errorMsg = {
        id: 'err-1',
        conversationId: 'conv-1',
        role: 'assistant' as const,
        content: 'Error occurred',
        createdAt: isoAt(TEST_DAY_START),
      };
      const onRegenerate = vi.fn();
      const onFork = vi.fn();
      renderWithProviders(
        <MessageItem
          message={errorMsg}
          isError
          onRegenerate={onRegenerate}
          onFork={onFork}
          allowedActions={ERROR_AI_ACTIONS}
        />
      );
      expect(screen.getByRole('button', { name: /regenerate/i })).toBeInTheDocument();
      // Fork stays off on errored messages — there's no successful assistant
      // turn to branch from.
      expect(screen.queryByRole('button', { name: /fork/i })).not.toBeInTheDocument();
    });

    it('does not render edit button on AI messages', () => {
      const onEdit = vi.fn();
      renderWithProviders(
        <MessageItem message={assistantMessage} onEdit={onEdit} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.queryByRole('button', { name: /edit/i })).not.toBeInTheDocument();
    });
  });

  describe('media content items', () => {
    const messageWithMedia: Message = {
      ...assistantMessage,
      id: 'msg-with-media',
      content: '',
      wrappedContentKey: 'base64-wrapped-key',
      epochNumber: 1,
      mediaItems: [
        {
          id: 'ci-image-1',
          contentType: 'image',
          position: 0,
          mimeType: 'image/png',
          sizeBytes: 1_000_000,
          width: 1024,
          height: 1024,
        },
      ],
    };

    it('renders MediaContentItem for each media item', () => {
      renderWithProviders(
        <MessageItem message={messageWithMedia} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getByTestId('mock-media-item-ci-image-1')).toBeInTheDocument();
      expect(screen.getByTestId('mock-media-item-ci-image-1')).toHaveAttribute(
        'data-content-type',
        'image'
      );
    });

    it('renders media items in position order', () => {
      const msg: Message = {
        ...messageWithMedia,
        mediaItems: [
          {
            id: 'ci-b',
            contentType: 'image',
            position: 1,
            mimeType: 'image/png',
            sizeBytes: 100,
          },
          {
            id: 'ci-a',
            contentType: 'image',
            position: 0,
            mimeType: 'image/png',
            sizeBytes: 100,
          },
        ],
      };
      renderWithProviders(<MessageItem message={msg} allowedActions={ALL_AI_ACTIONS} />);
      const rendered = screen.getAllByTestId(/^mock-media-item-/);
      expect(rendered[0]).toHaveAttribute('data-testid', 'mock-media-item-ci-a');
      expect(rendered[1]).toHaveAttribute('data-testid', 'mock-media-item-ci-b');
    });

    it('renders nothing when mediaItems is empty', () => {
      const msg: Message = { ...messageWithMedia, mediaItems: [] };
      renderWithProviders(<MessageItem message={msg} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId(/^mock-media-item-/)).not.toBeInTheDocument();
    });

    it('renders nothing when wrappedContentKey is missing', () => {
      // eslint-disable-next-line sonarjs/no-unused-vars -- omitting the key from the copy
      const { wrappedContentKey: _omitKey, ...rest } = messageWithMedia;
      renderWithProviders(<MessageItem message={rest} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId(/^mock-media-item-/)).not.toBeInTheDocument();
    });

    it('renders nothing when epochNumber is missing', () => {
      // eslint-disable-next-line sonarjs/no-unused-vars -- omitting the field from the copy
      const { epochNumber: _omitEpoch, ...rest } = messageWithMedia;
      renderWithProviders(<MessageItem message={rest} allowedActions={ALL_AI_ACTIONS} />);
      expect(screen.queryByTestId(/^mock-media-item-/)).not.toBeInTheDocument();
    });

    describe('media-in-flight placeholder', () => {
      const inFlightMessage: Message = {
        ...assistantMessage,
        id: 'msg-in-flight',
        content: '',
      };

      it('shows "Generating image…" when mediaInFlight.mediaType is image', () => {
        const msg: Message = {
          ...inFlightMessage,
          mediaInFlight: { mediaType: 'image', mimeType: 'image/png' },
        };
        renderWithProviders(<MessageItem message={msg} allowedActions={NO_ACTIONS} isStreaming />);
        expect(screen.getByRole('status', { name: /generating image/i })).toBeInTheDocument();
      });

      it('shows "Generating video…" when mediaInFlight.mediaType is video', () => {
        const msg: Message = {
          ...inFlightMessage,
          mediaInFlight: { mediaType: 'video', mimeType: 'application/octet-stream' },
        };
        renderWithProviders(<MessageItem message={msg} allowedActions={NO_ACTIONS} isStreaming />);
        expect(screen.getByRole('status', { name: /generating video/i })).toBeInTheDocument();
      });

      it('shows "Generating audio…" when mediaInFlight.mediaType is audio', () => {
        const msg: Message = {
          ...inFlightMessage,
          mediaInFlight: { mediaType: 'audio', mimeType: 'audio/mpeg' },
        };
        renderWithProviders(<MessageItem message={msg} allowedActions={NO_ACTIONS} isStreaming />);
        expect(screen.getByRole('status', { name: /generating audio/i })).toBeInTheDocument();
      });

      it('renders the progress bar when mediaProgress.percent is set', () => {
        const msg: Message = {
          ...inFlightMessage,
          mediaInFlight: { mediaType: 'video', mimeType: 'application/octet-stream' },
          mediaProgress: { percent: 42 },
        };
        renderWithProviders(<MessageItem message={msg} allowedActions={NO_ACTIONS} isStreaming />);
        const bar = screen.getByTestId('media-progress-bar');
        expect(bar).toBeInTheDocument();
        const fill = bar.querySelector('div');
        expect(fill?.getAttribute('style')).toContain('42%');
      });

      it('shapes the in-flight placeholder to the requested aspect ratio', () => {
        const msg: Message = {
          ...inFlightMessage,
          mediaInFlight: { mediaType: 'image', mimeType: 'image/png', aspectRatio: '16:9' },
        };
        renderWithProviders(<MessageItem message={msg} allowedActions={NO_ACTIONS} isStreaming />);
        const placeholder = screen.getByRole('status', { name: /generating image/i });
        expect(placeholder.style.aspectRatio).toBe('16 / 9');
      });
    });

    it('unwraps the message contentKey once even with multiple media items', () => {
      // The parent resolves contentKey once and passes it to each
      // MediaContentItem, so an N-image message does ONE unwrap, not N.
      // Asserts on `unwrapContentKeyFromEpoch` call count.
      mockUnwrapContentKeyFromEpoch.mockClear();
      const msgWithThreeMedia: Message = {
        ...messageWithMedia,
        mediaItems: [
          {
            id: 'ci-a',
            contentType: 'image',
            position: 0,
            mimeType: 'image/png',
            sizeBytes: 100,
          },
          {
            id: 'ci-b',
            contentType: 'image',
            position: 1,
            mimeType: 'image/png',
            sizeBytes: 100,
          },
          {
            id: 'ci-c',
            contentType: 'image',
            position: 2,
            mimeType: 'image/png',
            sizeBytes: 100,
          },
        ],
      };
      renderWithProviders(
        <MessageItem message={msgWithThreeMedia} allowedActions={ALL_AI_ACTIONS} />
      );
      expect(screen.getAllByTestId(/^mock-media-item-/)).toHaveLength(3);
      expect(mockUnwrapContentKeyFromEpoch).toHaveBeenCalledTimes(1);
    });
  });

  describe('reasoning disclosure', () => {
    const reasoningSettled = {
      id: 'r-1',
      conversationId: 'conv-1',
      role: 'assistant' as const,
      content: withReasoning('Working through the derivative.', 'The answer is 16.'),
      createdAt: isoAt(TEST_DAY_START),
    };
    // Reasoning streaming, no answer yet.
    const reasoningStreaming = {
      ...reasoningSettled,
      id: 'r-2',
      content: withReasoning('Working through', ''),
    };

    it('renders the disclosure for a message with embedded reasoning', async () => {
      renderWithProviders(<MessageItem message={reasoningSettled} allowedActions={NO_ACTIONS} />);
      await act(async () => {});
      expect(screen.getByTestId(TEST_IDS.thinkingDisclosure)).toBeInTheDocument();
    });

    it('feeds only the parsed answer to the markdown renderer', async () => {
      renderWithProviders(<MessageItem message={reasoningSettled} allowedActions={NO_ACTIONS} />);
      await act(async () => {});
      const markdown = screen.getByTestId('markdown-renderer');
      expect(markdown).toHaveTextContent('The answer is 16.');
      expect(markdown).not.toHaveTextContent('Working through the derivative.');
    });

    it('keeps the disclosure out of the answer region announcements', async () => {
      renderWithProviders(<MessageItem message={reasoningSettled} allowedActions={NO_ACTIONS} />);
      await act(async () => {});
      const block = screen.getByTestId(TEST_IDS.thinkingDisclosure).parentElement;
      expect(block).toHaveAttribute('aria-live', 'off');
    });

    // Inverted from an assertion that pinned the indicator and the disclosure
    // rendering together, which was two thinking affordances for one state. The
    // reasoning row is now the turn's single announcement surface, so the
    // indicator must be gone while it is up.
    it('makes the reasoning row the only status surface while reasoning streams', () => {
      renderWithProviders(
        <MessageItem message={reasoningStreaming} isStreaming allowedActions={NO_ACTIONS} />
      );
      expect(screen.queryByTestId(TEST_IDS.thinkingIndicator)).not.toBeInTheDocument();
      const disclosure = screen.getByTestId(TEST_IDS.thinkingDisclosure);
      expect(screen.getAllByRole('status')).toHaveLength(1);
      // Both terms: one status on the row, and it is this surface's. The two
      // surfaces now share one label, so text alone cannot tell them apart.
      expect(within(disclosure).getByRole('status')).toBeInTheDocument();
    });

    it('names the model in the reasoning row while it thinks', () => {
      const knownModel = mockModelsData.data.models[0];
      if (!knownModel) throw new Error('test fixture must include at least one model');
      const named = { ...reasoningStreaming, id: 'r-7', modelName: knownModel.id };
      renderWithProviders(
        <MessageItem
          message={named}
          isStreaming
          allowedActions={NO_ACTIONS}
          models={mockModelsData.data}
        />
      );
      expect(screen.getByRole('status')).toHaveTextContent('Claude 3.5 Sonnet is thinking');
    });

    it('makes the reasoning row the only status surface before the first thought arrives', () => {
      // A reasoning span carrying nothing yet: the turn is known to be
      // reasoning, so the row announces even with no thought to show.
      const waiting = {
        ...reasoningSettled,
        id: 'r-5',
        content: withReasoning('', ''),
      };
      renderWithProviders(
        <MessageItem message={waiting} isStreaming allowedActions={NO_ACTIONS} />
      );
      expect(screen.queryByTestId(TEST_IDS.thinkingIndicator)).not.toBeInTheDocument();
      expect(screen.getAllByRole('status')).toHaveLength(1);
    });

    // The other half of the coupling above: absorbing the indicator into the
    // reasoning row must not cost a turn its announcement, and a turn that
    // never reasons has no row to announce from.
    it('still announces through the indicator when the turn never reasons', () => {
      const noReasoning = { ...reasoningSettled, id: 'r-6', content: '' };
      renderWithProviders(
        <MessageItem message={noReasoning} isStreaming allowedActions={NO_ACTIONS} />
      );
      expect(screen.getByTestId(TEST_IDS.thinkingIndicator)).toBeInTheDocument();
      expect(screen.queryByTestId(TEST_IDS.thinkingDisclosure)).not.toBeInTheDocument();
      expect(screen.getAllByRole('status')).toHaveLength(1);
    });

    it('swaps the indicator for the answer once answer tokens arrive', async () => {
      renderWithProviders(
        <MessageItem message={reasoningSettled} isStreaming allowedActions={NO_ACTIONS} />
      );
      await act(async () => {});
      expect(screen.queryByTestId(TEST_IDS.thinkingIndicator)).not.toBeInTheDocument();
      expect(screen.getByTestId('markdown-renderer')).toHaveTextContent('The answer is 16.');
    });

    it('renders no disclosure for a message without reasoning', async () => {
      renderWithProviders(
        <MessageItem message={assistantMessage} allowedActions={ALL_AI_ACTIONS} />
      );
      await act(async () => {});
      expect(screen.queryByTestId(TEST_IDS.thinkingDisclosure)).not.toBeInTheDocument();
    });

    it('shows the not-shared line for a message with billed but invisible reasoning', async () => {
      const oSeries = { ...assistantMessage, id: 'r-3', reasoningTokens: 1204 };
      renderWithProviders(<MessageItem message={oSeries} allowedActions={ALL_AI_ACTIONS} />);
      await act(async () => {});
      expect(screen.getByTestId(TEST_IDS.reasoningNotShared)).toHaveTextContent(
        'Reasoning not shared · 1,204 tokens'
      );
    });

    it('keeps the settled reasoning row above an error the tile failed with', () => {
      const errored = { ...reasoningSettled, id: 'r-4', errorCode: 'STREAM_ERROR' };
      renderWithProviders(
        <MessageItem message={errored} allowedActions={ERROR_AI_ACTIONS} isError />
      );
      expect(screen.getByTestId(TEST_IDS.thinkingDisclosure)).toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.modelErrorMessage)).toBeInTheDocument();
    });

    it('shows the parsed answer, not the raw text, in the plain-text fallback while markdown loads', () => {
      mockMarkdownSuspendForever.current = true;
      try {
        renderWithProviders(<MessageItem message={reasoningSettled} allowedActions={NO_ACTIONS} />);
        const liveRegion = screen.getByTestId(TEST_IDS.aiMessageLiveRegion);
        expect(within(liveRegion).getByText('The answer is 16.')).toBeInTheDocument();
        expect(
          within(liveRegion).queryByText(/Working through the derivative/)
        ).not.toBeInTheDocument();
      } finally {
        mockMarkdownSuspendForever.current = false;
      }
    });
  });
});

describe('MessageItem re-render comparison', () => {
  const groupedMessage = {
    id: 'g-msg-1',
    conversationId: 'conv-1',
    role: 'user' as const,
    content: 'first',
    createdAt: isoAt(TEST_DAY_START),
  };
  const secondMessage = { ...groupedMessage, id: 'g-msg-2', content: 'second' };
  const assistantTile = { ...groupedMessage, id: 'a-msg-1', role: 'assistant' as const };

  it('swaps the action row when the allowed set changes without changing size', () => {
    const handlers = { onFork: vi.fn(), onShare: vi.fn() };
    const { rerender } = renderWithProviders(
      <MessageItem
        message={assistantTile}
        allowedActions={new Set<MessageAction>(['copy', 'fork'])}
        {...handlers}
      />
    );
    expect(screen.getByRole('button', { name: 'Fork' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Share' })).not.toBeInTheDocument();

    rerender(
      <MessageItem
        message={assistantTile}
        allowedActions={new Set<MessageAction>(['copy', 'share'])}
        {...handlers}
      />
    );
    expect(screen.queryByRole('button', { name: 'Fork' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Share' })).toBeInTheDocument();
  });

  it('renders the grouped bodies once a group arrives where there was none', () => {
    const { rerender } = renderWithProviders(
      <MessageItem message={groupedMessage} allowedActions={NO_ACTIONS} isGroupChat />
    );
    expect(screen.queryByText('second')).not.toBeInTheDocument();

    rerender(
      <MessageItem
        message={groupedMessage}
        allowedActions={NO_ACTIONS}
        isGroupChat
        currentUserId="user-a"
        group={{
          id: 'group-1',
          role: 'user',
          senderId: 'user-a',
          messages: [groupedMessage, secondMessage],
        }}
      />
    );
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('re-renders when the group identity changes under an unchanged message', () => {
    const base = {
      message: groupedMessage,
      allowedActions: NO_ACTIONS,
      isGroupChat: true,
      currentUserId: 'user-a',
    };
    const { rerender } = renderWithProviders(
      <MessageItem
        {...base}
        group={{ id: 'group-1', role: 'user', senderId: 'user-a', messages: [groupedMessage] }}
      />
    );
    expect(screen.getByText('first')).toBeInTheDocument();

    rerender(
      <MessageItem
        {...base}
        group={{ id: 'group-2', role: 'user', senderId: 'user-a', messages: [secondMessage] }}
      />
    );
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('renames the sender when the same group is attributed to someone else', () => {
    const base = {
      message: groupedMessage,
      allowedActions: NO_ACTIONS,
      isGroupChat: true,
      currentUserId: 'user-a',
    };
    const { rerender } = renderWithProviders(
      <MessageItem
        {...base}
        group={{ id: 'group-1', role: 'user', senderId: 'user-a', messages: [groupedMessage] }}
      />
    );
    expect(screen.getByTestId(TEST_IDS.senderLabel)).toHaveTextContent('You');

    rerender(
      <MessageItem
        {...base}
        group={{ id: 'group-1', role: 'user', senderId: 'user-b', messages: [groupedMessage] }}
      />
    );
    expect(screen.getByTestId(TEST_IDS.senderLabel)).toHaveTextContent(
      'This user has left the conversation'
    );
  });

  it('edits the user message the row is showing', () => {
    const onEdit = vi.fn();
    renderWithProviders(
      <MessageItem
        message={groupedMessage}
        allowedActions={new Set<MessageAction>(['edit'])}
        onEdit={onEdit}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledWith('g-msg-1', 'first');
  });
});
