import * as React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { asContentKey } from '@hushbox/crypto';
import { PRODUCT_TAGLINE_SENTENCES, ROUTES, TEST_IDS, toBase64 } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { MessageContentKeySourceContext } from '@/hooks/crypto/use-decrypted-media';
import { sharedMessageReply } from '@/hooks/chat/shared-message-reply';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import { SharedMessageChatPage } from './shared-message-chat-page';
import type { WrappedSecret } from '@hushbox/crypto';
import type { ChatLayoutProps } from '@/components/chat/layout/chat-layout';
import type { SharedMessageData } from '@/hooks/chat/use-shared-message';
import type { Message } from '@/lib/api/api';

vi.mock('@/hooks/auth/use-stable-session', () => ({
  useStableSession: vi.fn(),
}));

// The real mapping, wrapped so a test can make it set fields the link never publishes.
vi.mock('@/hooks/chat/shared-message-reply', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/hooks/chat/shared-message-reply')>();
  return { sharedMessageReply: vi.fn(actual.sharedMessageReply) };
});

// Link needs a router this render does not mount; the stand-in keeps the attributes a
// wrapping Button merges onto it.
vi.mock('@tanstack/react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tanstack/react-router')>();
  return {
    ...actual,
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

let capturedProps: ChatLayoutProps | undefined;

/** Called once per render of the memoised list stand-in. */
const mockListRender = vi.fn();

interface ListProbeProps {
  readonly messages: Message[];
  readonly streamingMessageIds: Set<string>;
  readonly threadHeader: React.ReactNode;
  readonly threadFooter: React.ReactNode;
}

/** Stands in for the memoised message list, which receives the thread's rows, head and foot. */
const ListProbe = React.memo(function ListProbe({
  threadHeader,
  threadFooter,
}: ListProbeProps): React.JSX.Element {
  mockListRender();
  return (
    <div data-testid="list-probe">
      {threadHeader}
      <div data-testid="rows" />
      {threadFooter}
    </div>
  );
});

/** Reads the content-key source the media path would read inside the layout. */
let capturedKeySource: React.ContextType<typeof MessageContentKeySourceContext> | undefined;

function KeySourceProbe(): null {
  capturedKeySource = React.use(MessageContentKeySourceContext);
  return null;
}

vi.mock('@/components/chat/layout/chat-layout', () => ({
  ChatLayout: (props: ChatLayoutProps): React.JSX.Element => {
    capturedProps = props;
    return (
      <div data-testid="chat-layout">
        <KeySourceProbe />
        <ListProbe
          messages={props.messages}
          streamingMessageIds={props.streamingMessageIds}
          threadHeader={props.threadHeader}
          threadFooter={props.threadFooter}
        />
        {/* As the real layout does, a page's composer replacement takes the composer's place. */}
        <div data-testid="composer-area">
          {props.composerSlot ?? <textarea data-testid="composer" />}
        </div>
      </div>
    );
  },
}));

const mockUseStableSession = vi.mocked(useStableSession);

const SIGNED_OUT: ReturnType<typeof useStableSession> = {
  session: null,
  isAuthenticated: false,
  isStable: true,
  isPending: false,
};

const SIGNED_IN: ReturnType<typeof useStableSession> = {
  session: { user: { id: 'user-1', email: 'reader@hushbox.ai' }, session: { id: 'user-1' } },
  isAuthenticated: true,
  isStable: true,
  isPending: false,
};

const SETTLING: ReturnType<typeof useStableSession> = {
  session: null,
  isAuthenticated: false,
  isStable: false,
  isPending: true,
};

const MESSAGE_CREATED_AT = isoAt(TEST_DAY_START + 9 * HOUR_MS);
const SHARE_CREATED_AT = isoAt(TEST_DAY_START + 14 * HOUR_MS);
const CONTENT_KEY = asContentKey(new Uint8Array(32).fill(7));
// The brand has no constructor; the hook brands the wire bytes the same way.
const EPOCH_WRAP = new Uint8Array([4, 5, 6]) as WrappedSecret;

const LIVE_SHARE: SharedMessageData = {
  deleted: false,
  createdAt: SHARE_CREATED_AT,
  messageCreatedAt: MESSAGE_CREATED_AT,
  contentKey: CONTENT_KEY,
  wrappedContentKey: EPOCH_WRAP,
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

const NOTE =
  'One reply, shared on its own. The question and the rest of the conversation stay private.';

function layoutProps(): ChatLayoutProps {
  if (capturedProps === undefined) throw new Error('the layout never rendered');
  return capturedProps;
}

function footer(): HTMLElement {
  return screen.getByTestId(TEST_IDS.sharedReplyNote).parentElement!;
}

describe('SharedMessageChatPage', () => {
  beforeEach(() => {
    capturedProps = undefined;
    capturedKeySource = undefined;
    mockListRender.mockClear();
    mockUseStableSession.mockReturnValue(SIGNED_OUT);
  });

  afterEach(() => {
    cleanup();
  });

  describe('the thread', () => {
    it('holds the shared reply as its one message, mapped as the chat maps it', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(layoutProps().messages).toEqual([sharedMessageReply(LIVE_SHARE)]);
    });

    it('hands the layout none of the fields the link withholds, whatever the mapping sets', () => {
      const overMapped: Message = {
        ...sharedMessageReply(LIVE_SHARE),
        cost: '1200000',
        inputTokens: 40,
        outputTokens: 900,
        resolvedModelName: 'Resolved name',
        parentMessageId: 'question-1',
        batchId: 'batch-1',
      };
      vi.mocked(sharedMessageReply).mockReturnValueOnce(overMapped);

      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      const [row] = layoutProps().messages;
      const withheld = [
        row?.cost,
        row?.inputTokens,
        row?.outputTokens,
        row?.resolvedModelName,
        row?.parentMessageId,
        row?.batchId,
      ];
      expect(withheld).toEqual([undefined, undefined, undefined, undefined, undefined, undefined]);
    });

    it('streams nothing', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(layoutProps().streamingMessageIds.size).toBe(0);
    });

    it('reads as a message link, whose reader may only copy', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(layoutProps().isMessageLink).toBe(true);
    });

    it('seats the reader in no conversation', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      const { conversationId, groupChat, isLinkGuest } = layoutProps();
      expect([conversationId, groupChat, isLinkGuest]).toEqual([undefined, undefined, undefined]);
    });

    it('hands the layout no regenerate, edit or fork handler', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      const { onRegenerate, onEdit, onFork } = layoutProps();
      expect([onRegenerate, onEdit, onFork]).toEqual([undefined, undefined, undefined]);
    });

    it('gives the app header no title, since the thread heads itself', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(layoutProps().title).toBeUndefined();
    });

    it('marks its messages ready', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(layoutProps().messagesReady).toBe(true);
    });
  });

  describe('the session', () => {
    it('speaks to a signed-in reader as signed in', () => {
      mockUseStableSession.mockReturnValue(SIGNED_IN);

      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(layoutProps().isAuthenticated).toBe(true);
    });

    it('speaks to a signed-out reader as signed out', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(layoutProps().isAuthenticated).toBe(false);
    });

    it('speaks as signed out while the session is still settling', () => {
      mockUseStableSession.mockReturnValue({ ...SIGNED_IN, isStable: false });

      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(layoutProps().isAuthenticated).toBe(false);
    });
  });

  describe('the content key', () => {
    it("gives the media path the key the link opened, for the reply's own wrap", () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      const result = capturedKeySource!('conv-1', 2, toBase64(EPOCH_WRAP));

      expect(result.contentKey).toBe(CONTENT_KEY);
    });

    it('gives the media path no key for any other wrap', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      const result = capturedKeySource!('conv-1', 2, toBase64(new Uint8Array([9, 9, 9])));

      expect(result.contentKey).toBeNull();
    });
  });

  describe('the head', () => {
    it('heads the thread Shared reply, in the one heading of the first level', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      const head = screen.getByTestId(TEST_IDS.shareHead);
      expect(screen.getAllByRole('heading', { level: 1 })).toEqual([
        within(head).getByRole('heading', { level: 1, name: 'Shared reply' }),
      ]);
    });

    it('puts the head above the rows', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      const head = screen.getByTestId(TEST_IDS.shareHead);
      expect(head.compareDocumentPosition(screen.getByTestId('rows'))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it('promises the reply was decrypted in this browser', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(screen.getByTestId(TEST_IDS.shareHead)).toHaveTextContent(
        'Decrypted in this browser with the key in your link.'
      );
    });

    it('makes no decryption promise for a deleted reply, since nothing was decrypted', () => {
      render(<SharedMessageChatPage data={DELETED_SHARE} />);

      expect(screen.getByTestId(TEST_IDS.shareHead)).not.toHaveTextContent('Decrypted');
    });

    it('still heads a deleted reply Shared reply', () => {
      render(<SharedMessageChatPage data={DELETED_SHARE} />);

      expect(screen.getByRole('heading', { level: 1, name: 'Shared reply' })).toBeInTheDocument();
    });
  });

  describe('the foot', () => {
    it('states under the rows that the reply is shared on its own', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      const note = screen.getByTestId(TEST_IDS.sharedReplyNote);
      expect(note).toHaveTextContent(NOTE);
      expect(screen.getByTestId('rows').compareDocumentPosition(note)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it('closes with the product tagline for a signed-out reader', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(
        within(footer()).getByRole('heading', {
          level: 2,
          name: PRODUCT_TAGLINE_SENTENCES.join(' '),
        })
      ).toBeInTheDocument();
    });

    it("lists today's sign-up points for a signed-out reader", () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      const points = within(footer()).getAllByRole('listitem');
      expect(points.map((point) => point.textContent.replace('✓', ''))).toEqual([
        'Privacy by design',
        'Access GPT, Claude, Gemini & more',
        'Your data is never sold or trained on',
      ]);
    });

    it('ends with a full-width Sign Up to the sign-up page for a signed-out reader', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      const signUp = within(footer()).getByRole('link', { name: 'Sign Up' });
      expect(signUp).toHaveAttribute('href', ROUTES.SIGNUP);
      expect(signUp).toHaveAttribute('data-block');
    });

    it('puts the pitch after the note', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      const note = screen.getByTestId(TEST_IDS.sharedReplyNote);
      expect(note.compareDocumentPosition(screen.getByRole('link', { name: 'Sign Up' }))).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING
      );
    });

    it('gives a signed-in reader the note alone', () => {
      mockUseStableSession.mockReturnValue(SIGNED_IN);

      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(screen.getByTestId(TEST_IDS.sharedReplyNote)).toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
      expect(screen.queryByRole('list')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Sign Up' })).not.toBeInTheDocument();
    });

    it('holds the pitch back while the session is still settling', () => {
      mockUseStableSession.mockReturnValue(SETTLING);

      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(screen.getByTestId(TEST_IDS.sharedReplyNote)).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Sign Up' })).not.toBeInTheDocument();
    });

    it('keeps the note under a deleted reply', () => {
      render(<SharedMessageChatPage data={DELETED_SHARE} />);

      expect(screen.getByTestId(TEST_IDS.sharedReplyNote)).toHaveTextContent(NOTE);
    });
  });

  describe('the composer', () => {
    it('draws no composer', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
    });

    it("fills the composer's place with nothing", () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(screen.getByTestId('composer-area')).toBeEmptyDOMElement();
    });

    it('takes nothing typed or sent into the thread', () => {
      render(<SharedMessageChatPage data={LIVE_SHARE} />);
      const rendersBefore = mockListRender.mock.calls.length;

      act(() => {
        layoutProps().onInputChange('a question');
        layoutProps().onSubmit('personal_balance');
      });

      expect(layoutProps().inputValue).toBe('');
      expect(mockListRender).toHaveBeenCalledTimes(rendersBefore);
    });
  });

  describe('memoisation', () => {
    it('re-renders no memoised list when the page re-renders unchanged', () => {
      const { rerender } = render(<SharedMessageChatPage data={LIVE_SHARE} />);
      const rendersBefore = mockListRender.mock.calls.length;

      rerender(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(mockListRender).toHaveBeenCalledTimes(rendersBefore);
    });

    it('re-renders no memoised list when the session re-reads unchanged', () => {
      const { rerender } = render(<SharedMessageChatPage data={LIVE_SHARE} />);
      const rendersBefore = mockListRender.mock.calls.length;
      mockUseStableSession.mockReturnValue({ ...SIGNED_OUT });

      rerender(<SharedMessageChatPage data={LIVE_SHARE} />);

      expect(mockListRender).toHaveBeenCalledTimes(rendersBefore);
    });
  });
});
