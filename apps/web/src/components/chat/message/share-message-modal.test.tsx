import { screen, act, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { serializeSegments, TEST_IDS } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';

vi.mock('@/hooks/chat/use-message-share.js', () => ({
  useMessageShare: vi.fn(),
}));

// The catalog names the model and its maker in the reply head, as the thread's head does.
const mockUseModels = vi.fn<() => { data: ModelsData | undefined }>();

vi.mock('@/hooks/models/models.js', () => ({
  useModels: () => mockUseModels(),
}));

// Mock the shared media list so the preview test doesn't pull in the full
// fetch + decrypt chain; it renders nothing when there is no media (matching
// the real component) so non-media tests are unaffected.
vi.mock('@/components/chat/message/message-media-list.js', () => ({
  MessageMediaList: ({
    media,
    contentKeyError,
  }: {
    media: {
      contentItemId: string;
      downloadUrl?: string;
      envelope?: { messageId: string; senderId: string };
    }[];
    contentKeyError?: Error | null;
  }) =>
    media.length === 0 ? null : (
      <div
        data-testid="modal-media-list"
        data-count={media.length}
        data-key-error={contentKeyError ? contentKeyError.message : 'none'}
      >
        {media.map((m) => (
          <span
            key={m.contentItemId}
            data-testid={`modal-media-${m.contentItemId}`}
            data-download-url={m.downloadUrl ?? 'none'}
            data-envelope-message={m.envelope?.messageId ?? 'none'}
            data-envelope-sender={m.envelope?.senderId ?? 'none'}
          />
        ))}
      </div>
    ),
}));

// The opened reasoning trace lazily pulls the markdown stack. Stubbing it keeps
// that stack out of this suite the way the shared-message page's suite does, and
// keeps `markdown-renderer.tsx` recorded under one coverage offset per run: a
// module reached inlined by one suite and externalized by another silently
// remaps its coverage ranges, which the repo gates on.
// A fenced block stands for one long enough to draw as a document: the stub hands it to the
// real card, so Open runs the chat's own selection.
vi.mock('@/components/chat/message/markdown-renderer.js', async () => {
  const { DocumentCard } = await import('@/components/chat/media/document-card.js');
  return {
    MarkdownRenderer: ({ content }: { content: string }) => {
      const document: Document = {
        id: 'doc-in-reply',
        type: 'code',
        language: 'rust',
        title: 'module.rs',
        content,
        lineCount: content.split('\n').length,
        isStreaming: false,
      };
      return (
        <div data-testid={TEST_IDS.markdownRenderer}>
          {content}
          {content.includes('```') ? <DocumentCard document={document} /> : null}
        </div>
      );
    },
  };
});

const mockUseMessageContentKey = vi.fn<typeof useMessageContentKey>();

vi.mock('@/hooks/crypto/use-decrypted-media.js', () => ({
  useMessageContentKey: (...args: [string, number, string]) => mockUseMessageContentKey(...args),
}));

import { generateContentKey, generateEpochKeyPair, wrapContentKeyToEpoch } from '@hushbox/crypto';
import { useMessageShare } from '@/hooks/chat/use-message-share.js';
import { ShareMessageModal } from '@/components/chat/message/share-message-modal.js';
import { useSegmentViewState } from '@/components/chat/segments/segment-view-state.js';
import { useDocumentStore } from '@/stores/document.js';
import { renderWithProviders } from '@/test-utils/render.js';
import type { Model } from '@hushbox/shared';
import type { ModelsData } from '@/hooks/models/models.js';
import type { useMessageContentKey } from '@/hooks/crypto/use-decrypted-media.js';
import type { ShareMessageReply } from '@/components/chat/message/share-message-modal.js';
import type { Document } from '@/lib/chat/document-parser.js';
import type { Message, MessageMediaItem } from '@/lib/api/api.js';

const SONNET_ID = 'anthropic/claude-sonnet-4.5';

const SONNET: Model = {
  id: SONNET_ID,
  name: 'Claude Sonnet 4.5',
  description: 'desc',
  provider: 'Anthropic',
  modality: 'text',
  contextLength: 8000,
  supportedParameters: [],
  pricing: { inputPerToken: '10000', outputPerToken: '30000' },
};

/** Assistant text carrying a reasoning span, then the answer when one is given. */
function withReasoning(reasoning: string, answer: string): string {
  return serializeSegments([
    { kind: 'reasoning', children: [{ kind: 'text', text: reasoning }] },
    ...(answer === '' ? [] : [{ kind: 'text' as const, text: answer }]),
  ]);
}

/** The reply's content key and its wrap, as the epoch key resolves them for a member. */
const CONTENT_KEY = generateContentKey();
const WRAPPED_CONTENT_KEY = wrapContentKeyToEpoch(generateEpochKeyPair().publicKey, CONTENT_KEY);

/** A fenced block long enough for the reply to draw it as a document card. */
const DOCUMENT_REPLY = [
  'The module, whole:',
  '',
  '```rust',
  ...Array.from({ length: 16 }, (_, index) => `let line_${String(index)} = ${String(index)};`),
  '```',
].join('\n');

const mockUseMessageShare = vi.mocked(useMessageShare);
const mockMutateAsync = vi.fn();

/** The shared reply before the envelope that lets the dialog decrypt its media and mint the link. */
const REPLY_TEXT: ShareMessageReply = {
  id: 'msg-123',
  content: 'Here is the final API design for the encryption layer.',
  modelName: SONNET_ID,
  createdAt: isoAt(TEST_DAY_START),
};

const REPLY: ShareMessageReply = {
  ...REPLY_TEXT,
  epochNumber: 1,
  wrappedContentKey: 'base64-wrapped-content-key',
};

/** The shared reply with some of its fields replaced. */
function replyWith(fields: Partial<ShareMessageReply>): ShareMessageReply {
  return { ...REPLY, ...fields };
}

function imageItem(id: string, position: number): MessageMediaItem {
  return {
    id,
    contentType: 'image',
    position,
    mimeType: 'image/png',
    sizeBytes: 1024,
    width: 512,
    height: 512,
  };
}

describe('ShareMessageModal', () => {
  const defaultProps = {
    open: true,
    onOpenChange: vi.fn(),
    message: REPLY,
    conversationId: 'conv-1',
  };

  function arrangeDoubles(): void {
    mockUseModels.mockReturnValue({ data: { models: [SONNET], premiumIds: new Set() } });
    mockUseMessageContentKey.mockReturnValue({
      contentKey: CONTENT_KEY,
      wrappedContentKey: WRAPPED_CONTENT_KEY,
      error: null,
    });
    mockUseMessageShare.mockReturnValue({
      mutateAsync: mockMutateAsync,
      isPending: false,
    } as unknown as ReturnType<typeof useMessageShare>);
    mockMutateAsync.mockResolvedValue({
      shareId: 'share-xyz',
      url: 'http://localhost:3000/share/m/share-xyz#secret-key-b64',
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: vi.fn(() => Promise.resolve()) },
      writable: true,
      configurable: true,
    });
  }

  // The answer's markdown loads lazily; settling that load once here, inside act,
  // keeps it from resolving unwrapped inside whichever case first draws an answer.
  beforeAll(async () => {
    arrangeDoubles();
    const { unmount } = renderWithProviders(<ShareMessageModal {...defaultProps} />);
    await act(async () => {
      await import('@/components/chat/message/markdown-renderer.js');
    });
    unmount();
  });

  beforeEach(() => {
    useSegmentViewState.setState({ open: new Set() });
    useDocumentStore.getState().closePanel();
    vi.clearAllMocks();
    arrangeDoubles();
  });

  it('renders the modal with preview phase', () => {
    renderWithProviders(<ShareMessageModal {...defaultProps} />);

    expect(screen.getByTestId('share-message-modal')).toBeInTheDocument();
    expect(screen.getByTestId('share-message-preview')).toBeInTheDocument();
  });

  it('displays message content preview', () => {
    renderWithProviders(<ShareMessageModal {...defaultProps} />);

    const preview = screen.getByTestId('share-message-preview');
    expect(preview).toHaveTextContent('Here is the final API design');
  });

  describe('the reply preview', () => {
    it('names the model that wrote the reply, with its maker', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      const preview = screen.getByTestId(TEST_IDS.shareMessagePreview);
      expect(within(preview).getByTestId(TEST_IDS.modelNametag)).toHaveTextContent(
        'Claude Sonnet 4.5'
      );
      expect(within(preview).getByText('Anthropic')).toBeInTheDocument();
    });

    it('names a model the catalog has not loaded by its own id', () => {
      mockUseModels.mockReturnValue({ data: undefined });
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      expect(
        within(screen.getByTestId(TEST_IDS.shareMessagePreview)).getByTestId(TEST_IDS.modelNametag)
      ).toHaveTextContent('claude-sonnet-4.5');
    });

    it('marks a reply the Smart Model routed with the Smart chip the link publishes', () => {
      renderWithProviders(
        <ShareMessageModal {...defaultProps} message={replyWith({ isSmartModel: true })} />
      );

      const preview = screen.getByTestId(TEST_IDS.shareMessagePreview);
      expect(within(preview).getByTestId(TEST_IDS.smartModelChip)).toHaveTextContent('Smart');
    });

    it('draws no Smart chip on a reply the author picked the model for', () => {
      renderWithProviders(
        <ShareMessageModal {...defaultProps} message={replyWith({ isSmartModel: false })} />
      );

      const preview = screen.getByTestId(TEST_IDS.shareMessagePreview);
      expect(within(preview).queryByTestId(TEST_IDS.smartModelChip)).not.toBeInTheDocument();
    });

    it('draws no day, though the reply carries one', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      expect(
        screen.getByTestId(TEST_IDS.shareMessagePreview).querySelector('time')
      ).not.toBeInTheDocument();
    });

    it('draws none of the figures the link withholds from a reply handed over whole', () => {
      // The thread's message carries the billed cost and token counts; the link
      // publishes neither, so the consent preview shows neither.
      const threadMessage: Message = {
        ...REPLY,
        conversationId: 'conv-1',
        role: 'assistant',
        cost: '1234567890',
        inputTokens: 4321,
        outputTokens: 8765,
      };
      renderWithProviders(<ShareMessageModal {...defaultProps} message={threadMessage} />);

      const preview = screen.getByTestId(TEST_IDS.shareMessagePreview);
      expect(within(preview).queryByTestId(TEST_IDS.messageCost)).not.toBeInTheDocument();
      expect(preview).not.toHaveTextContent('$');
      // Both spellings a count takes in the app: grouped digits and the K form.
      for (const figure of ['4,321', '4.3K', '8,765', '8.8K']) {
        expect(preview).not.toHaveTextContent(figure);
      }
    });

    it('previews the whole answer with no line clamp', () => {
      const answer = Array.from(
        { length: 12 },
        (_, index) => `Paragraph ${String(index + 1)} of the reply.`
      ).join('\n\n');
      renderWithProviders(
        <ShareMessageModal {...defaultProps} message={replyWith({ content: answer })} />
      );

      const preview = screen.getByTestId(TEST_IDS.shareMessagePreview);
      expect(preview).toHaveTextContent('Paragraph 1 of the reply.');
      expect(preview).toHaveTextContent('Paragraph 12 of the reply.');
      expect(preview.querySelector('[class*="line-clamp"]')).toBeNull();
    });

    it('is a keyboard-reachable region named for what it holds', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      const region = screen.getByRole('region', { name: 'The reply as it will be shared' });
      expect(region).toBe(screen.getByTestId(TEST_IDS.shareMessagePreview));
      expect(region).toHaveAttribute('tabindex', '0');
    });

    it('bounds the reply at 20rem and scrolls inside that box', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      const preview = screen.getByTestId(TEST_IDS.shareMessagePreview);
      expect(preview).toHaveClass('max-h-80', 'overflow-y-auto');
    });

    /** Gives the preview box a scroll geometry the DOM here does not lay out. */
    function scrollPreviewTo(scrollTop: number): HTMLElement {
      const preview = screen.getByTestId(TEST_IDS.shareMessagePreview);
      Object.defineProperties(preview, {
        scrollHeight: { configurable: true, value: 900 },
        clientHeight: { configurable: true, value: 320 },
        scrollTop: { configurable: true, value: scrollTop },
      });
      fireEvent.scroll(preview);
      return preview;
    }

    it('fades the bottom of the box while more of the reply lies below', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      expect(scrollPreviewTo(0).className).toContain('mask-image');
    });

    it('drops the fade once the author has scrolled to the end of the reply', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      expect(scrollPreviewTo(580).className).not.toContain('mask-image');
    });

    it('draws no fade over a reply that fits the box', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      expect(screen.getByTestId(TEST_IDS.shareMessagePreview).className).not.toContain(
        'mask-image'
      );
    });
  });

  describe('the reply drawn as the thread draws it', () => {
    it("draws the reply in the thread's own message row", () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      const row = within(screen.getByTestId(TEST_IDS.shareMessagePreview)).getByTestId(
        TEST_IDS.messageItem
      );
      expect(row).toHaveAttribute('data-role', 'assistant');
      expect(row).toHaveAttribute('data-message-id', 'msg-123');
    });

    it('offers the reader\u2019s one action, Copy, and nothing else', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      const actions = within(screen.getByTestId(TEST_IDS.shareMessagePreview)).getByTestId(
        TEST_IDS.messageActions
      );
      expect(
        within(actions)
          .getAllByRole('button')
          .map((button) => button.getAttribute('aria-label'))
      ).toEqual(['Copy']);
    });

    it('names the model that wrote the reply, never a streaming-time resolved name', () => {
      const threadMessage: Message = {
        ...REPLY,
        conversationId: 'conv-1',
        role: 'assistant',
        resolvedModelName: 'Routed Elsewhere 9',
      };
      renderWithProviders(<ShareMessageModal {...defaultProps} message={threadMessage} />);

      const preview = screen.getByTestId(TEST_IDS.shareMessagePreview);
      expect(within(preview).getByTestId(TEST_IDS.modelNametag)).toHaveTextContent(
        'Claude Sonnet 4.5'
      );
      expect(preview).not.toHaveTextContent('Routed Elsewhere');
    });
  });

  // The class names stand for sizes because this DOM loads no stylesheet;
  // `share-message-modal.browser.test.tsx` measures them in real engines.
  describe('the preview scale', () => {
    function answerRegion(): HTMLElement {
      return within(screen.getByTestId(TEST_IDS.shareMessagePreview)).getByTestId(
        TEST_IDS.aiMessageLiveRegion
      );
    }

    it('sets the answer at 0.9375rem', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      expect(answerRegion()).toHaveClass('text-[0.9375rem]');
      expect(answerRegion()).not.toHaveClass('text-base');
    });

    it('sets the code at 0.75rem', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      expect(answerRegion()).toHaveClass(
        '[&_[data-streamdown=code-block-body]_pre]:text-[0.75rem]'
      );
    });

    it("spaces the answer's blocks 0.5rem apart", () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      expect(answerRegion()).toHaveClass('[&>*:not(#preview-scale)]:my-2');
    });

    it('spaces the head from the answer by 0.5rem, with no rule under it', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      const head = within(screen.getByTestId(TEST_IDS.shareMessagePreview)).getByTestId(
        TEST_IDS.modelNametagContainer
      );
      expect(head).toHaveClass('mb-2');
      expect(head).not.toHaveClass('mb-2.5');
      expect(head).not.toHaveClass('border-b');
    });
  });

  describe("a document card's Open", () => {
    it('closes the dialog', async () => {
      const onOpenChange = vi.fn();
      renderWithProviders(
        <ShareMessageModal
          {...defaultProps}
          onOpenChange={onOpenChange}
          message={replyWith({ content: DOCUMENT_REPLY })}
        />
      );

      await userEvent.click(
        within(screen.getByTestId(TEST_IDS.shareMessagePreview)).getByTestId(TEST_IDS.documentCard)
      );

      expect(onOpenChange).toHaveBeenCalledWith(false);
    });

    it('opens the document in the panel', async () => {
      renderWithProviders(
        <ShareMessageModal {...defaultProps} message={replyWith({ content: DOCUMENT_REPLY })} />
      );

      await userEvent.click(
        within(screen.getByTestId(TEST_IDS.shareMessagePreview)).getByTestId(TEST_IDS.documentCard)
      );

      expect(useDocumentStore.getState().isPanelOpen).toBe(true);
      expect(useDocumentStore.getState().activeDocument?.content).toContain('let line_15 = 15;');
    });

    it('keeps the dialog open while the link is being created', async () => {
      mockMutateAsync.mockReturnValue(new Promise<never>(() => {}));
      const onOpenChange = vi.fn();
      renderWithProviders(
        <ShareMessageModal
          {...defaultProps}
          onOpenChange={onOpenChange}
          message={replyWith({ content: DOCUMENT_REPLY })}
        />
      );

      await userEvent.click(screen.getByTestId(TEST_IDS.shareMessageCreateButton));
      await userEvent.click(
        within(screen.getByTestId(TEST_IDS.shareMessagePreview)).getByTestId(TEST_IDS.documentCard)
      );

      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('stays open when the panel behind it changes without a new document', () => {
      const onOpenChange = vi.fn();
      renderWithProviders(<ShareMessageModal {...defaultProps} onOpenChange={onOpenChange} />);

      act(() => {
        useDocumentStore.getState().togglePanel();
      });

      expect(onOpenChange).not.toHaveBeenCalled();
    });

    it('leaves a closed dialog alone when a document opens elsewhere', () => {
      const onOpenChange = vi.fn();
      renderWithProviders(
        <ShareMessageModal {...defaultProps} open={false} onOpenChange={onOpenChange} />
      );

      const elsewhere: Document = {
        id: 'doc-1',
        type: 'code',
        language: 'rust',
        title: 'elsewhere.rs',
        content: 'let elsewhere = 1;',
        lineCount: 1,
        isStreaming: false,
      };
      act(() => {
        useDocumentStore.getState().setActiveDocument(elsewhere);
      });

      expect(onOpenChange).not.toHaveBeenCalled();
    });
  });

  describe('the notes under the preview', () => {
    it('explains that the key never reaches HushBox and who can read the reply', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      expect(
        screen.getByText(
          "The key is the part of the link after the #, so HushBox's servers never receive it. Anyone with the link can read this reply."
        )
      ).toBeInTheDocument();
    });

    it('inks both notes’ icons in the success tone', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      const notes = screen
        .getByTestId(TEST_IDS.shareMessageModal)
        .querySelectorAll('[data-slot="notice"]');
      expect(notes).toHaveLength(2);
      for (const note of notes) {
        expect(note.querySelector('svg')).toHaveClass('text-success');
      }
    });
  });

  it('announces the isolation note as a status', () => {
    renderWithProviders(<ShareMessageModal {...defaultProps} />);

    const isolationInfo = screen.getByTestId('share-message-isolation-info');
    expect(isolationInfo).toHaveTextContent('single message only');
    expect(isolationInfo).toHaveAttribute('role', 'status');
  });

  it('calls useMessageShare with envelope metadata on Create Link click', async () => {
    renderWithProviders(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      messageId: 'msg-123',
      conversationId: 'conv-1',
      epochNumber: 1,
      wrappedContentKey: 'base64-wrapped-content-key',
    });
  });

  it('switches to generated phase after creation', async () => {
    renderWithProviders(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(screen.getByTestId('share-message-url')).toBeInTheDocument();
    expect(screen.getByTestId('share-message-copy-button')).toBeInTheDocument();
  });

  it('announces share-link success via role="status" / aria-live="polite"', async () => {
    renderWithProviders(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    const success = screen.getByTestId('share-message-success');
    expect(success).toHaveAttribute('role', 'status');
    expect(success).toHaveAttribute('aria-live', 'polite');
    expect(success).toHaveTextContent('Share link created!');
  });

  it('displays the generated URL', async () => {
    renderWithProviders(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(screen.getByTestId('share-message-url')).toHaveTextContent(
      'http://localhost:3000/share/m/share-xyz#secret-key-b64'
    );
  });

  it('closes modal when Cancel is clicked', async () => {
    renderWithProviders(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-cancel-button'));

    expect(defaultProps.onOpenChange).toHaveBeenCalledWith(false);
  });

  it('does not render a preview while no reply is selected', () => {
    renderWithProviders(<ShareMessageModal {...defaultProps} message={null} />);

    expect(screen.queryByTestId('share-message-preview')).not.toBeInTheDocument();
  });

  it('says no message is selected while none is', () => {
    renderWithProviders(<ShareMessageModal {...defaultProps} message={null} />);

    expect(screen.getByTestId(TEST_IDS.shareMessageModal)).toHaveTextContent(
      'No message selected.'
    );
  });

  it('offers no Create Link while no reply is selected', () => {
    renderWithProviders(<ShareMessageModal {...defaultProps} message={null} />);

    expect(screen.queryByTestId(TEST_IDS.shareMessageCreateButton)).not.toBeInTheDocument();
  });

  it('resets to preview phase when reopened', () => {
    const { rerender } = renderWithProviders(<ShareMessageModal {...defaultProps} open={false} />);
    rerender(<ShareMessageModal {...defaultProps} open={true} />);

    expect(screen.getByTestId('share-message-create-button')).toBeInTheDocument();
    expect(screen.queryByTestId('share-message-url')).not.toBeInTheDocument();
  });

  it('shows fresh Copy state when reopened after a prior copy', async () => {
    const { rerender } = renderWithProviders(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));
    await userEvent.click(screen.getByTestId('share-message-copy-button'));
    expect(screen.getByTestId('share-message-copy-button')).toHaveTextContent('Copied');

    rerender(<ShareMessageModal {...defaultProps} open={false} />);
    rerender(<ShareMessageModal {...defaultProps} open={true} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(screen.getByTestId('share-message-copy-button')).toHaveTextContent('Copy');
    expect(screen.getByTestId('share-message-copy-button')).not.toHaveTextContent('Copied');
  });

  it('reverts to Copy after the reset timeout elapses', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithProviders(<ShareMessageModal {...defaultProps} />);

    await user.click(screen.getByTestId('share-message-create-button'));
    await user.click(screen.getByTestId('share-message-copy-button'));
    expect(screen.getByTestId('share-message-copy-button')).toHaveTextContent('Copied');

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(screen.getByTestId('share-message-copy-button')).toHaveTextContent('Copy');
    expect(screen.getByTestId('share-message-copy-button')).not.toHaveTextContent('Copied');

    vi.useRealTimers();
  });

  it('clears the copy-reset timer on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');

    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { unmount } = renderWithProviders(<ShareMessageModal {...defaultProps} />);

    await user.click(screen.getByTestId('share-message-create-button'));
    setSpy.mockClear();
    await user.click(screen.getByTestId('share-message-copy-button'));

    const copyTimerResult = setSpy.mock.results[
      setSpy.mock.calls.findIndex((args) => args[1] === 3000)
    ] as { value: ReturnType<typeof setTimeout> } | undefined;
    expect(copyTimerResult).toBeDefined();

    unmount();

    expect(clearSpy).toHaveBeenCalledWith(copyTimerResult!.value);

    vi.useRealTimers();
  });

  it('creates a share link for media-only messages whose textual content is empty', async () => {
    // Image / video / audio assistant messages have an empty `content` —
    // the bytes live in encrypted contentItems, addressed by `messageId` server-side.
    // The share API only needs envelope metadata, so the modal must not gate
    // on text content being present.
    renderWithProviders(
      <ShareMessageModal {...defaultProps} message={replyWith({ content: '' })} />
    );

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(mockMutateAsync).toHaveBeenCalledWith({
      messageId: 'msg-123',
      conversationId: 'conv-1',
      epochNumber: 1,
      wrappedContentKey: 'base64-wrapped-content-key',
    });
    expect(screen.getByTestId('share-message-url')).toBeInTheDocument();
  });

  it('does not attempt to create a share when the wrapped content key is missing', async () => {
    renderWithProviders(
      <ShareMessageModal {...defaultProps} message={{ ...REPLY_TEXT, epochNumber: 1 }} />
    );

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('does not attempt to create a share when the conversation id is missing', async () => {
    renderWithProviders(<ShareMessageModal {...defaultProps} conversationId={null} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('does not attempt to create a share when the epoch number is missing', async () => {
    renderWithProviders(
      <ShareMessageModal
        {...defaultProps}
        message={{ ...REPLY_TEXT, wrappedContentKey: 'base64-wrapped-content-key' }}
      />
    );

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it('stays in the preview phase when share creation fails', async () => {
    mockMutateAsync.mockRejectedValue(new Error('share failed'));
    renderWithProviders(<ShareMessageModal {...defaultProps} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));

    expect(screen.getByTestId('share-message-create-button')).toBeInTheDocument();
    expect(screen.queryByTestId('share-message-success')).not.toBeInTheDocument();
  });

  it('closes the modal from the generated-phase Done button', async () => {
    const onOpenChange = vi.fn();
    renderWithProviders(<ShareMessageModal {...defaultProps} onOpenChange={onOpenChange} />);

    await userEvent.click(screen.getByTestId('share-message-create-button'));
    await screen.findByRole('button', { name: 'Done' });
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('sorts multiple media items by position before rendering', () => {
    renderWithProviders(
      <ShareMessageModal
        {...defaultProps}
        message={replyWith({
          content: '',
          mediaItems: [imageItem('ci-2', 1), imageItem('ci-1', 0)],
        })}
      />
    );

    expect(screen.getByTestId('modal-media-list')).toHaveAttribute('data-count', '2');
  });

  it('hands the preview media its envelope and the presigned URL the message holds', () => {
    renderWithProviders(
      <ShareMessageModal
        {...defaultProps}
        message={replyWith({
          content: '',
          senderId: 'sender-1',
          mediaItems: [
            { ...imageItem('ci-1', 0), downloadUrl: 'https://media.example/presigned-ci-1' },
          ],
        })}
      />
    );

    const item = screen.getByTestId('modal-media-ci-1');
    expect(item).toHaveAttribute('data-download-url', 'https://media.example/presigned-ci-1');
    expect(item).toHaveAttribute('data-envelope-message', 'msg-123');
  });

  it('builds the media envelope with an empty sender for a reply whose sender was scrubbed', () => {
    renderWithProviders(
      <ShareMessageModal
        {...defaultProps}
        message={replyWith({ content: '', mediaItems: [imageItem('ci-1', 0)] })}
      />
    );

    expect(screen.getByTestId('modal-media-ci-1')).toHaveAttribute('data-envelope-sender', '');
  });

  it('tolerates a null conversationId and epochNumber via safe fallbacks', () => {
    renderWithProviders(
      <ShareMessageModal {...defaultProps} conversationId={null} message={REPLY_TEXT} />
    );

    expect(screen.getByTestId('share-message-preview')).toBeInTheDocument();
  });

  it('renders media in the preview for a media-only message (no blank container)', () => {
    renderWithProviders(
      <ShareMessageModal
        {...defaultProps}
        message={replyWith({ content: '', mediaItems: [imageItem('ci-1', 0)] })}
      />
    );

    const list = screen.getByTestId('modal-media-list');
    expect(list).toHaveAttribute('data-count', '1');
    expect(screen.getByTestId('modal-media-ci-1')).toBeInTheDocument();
    expect(screen.getByTestId('share-message-preview')).toContainElement(list);
  });

  it('forwards a content-key error to the media list so undecryptable media shows an error', () => {
    mockUseMessageContentKey.mockReturnValue({
      contentKey: null,
      wrappedContentKey: null,
      error: new Error('Epoch key not available'),
    });

    renderWithProviders(
      <ShareMessageModal
        {...defaultProps}
        message={replyWith({ content: '', mediaItems: [imageItem('ci-1', 0)] })}
      />
    );

    expect(screen.getByTestId('modal-media-list')).toHaveAttribute(
      'data-key-error',
      'Epoch key not available'
    );
  });
  describe('reasoning preview', () => {
    // A share link publishes the reasoning trace, the effort rung and the
    // reasoning token count (founder ruling). The modal is the consent screen
    // for that disclosure, so everything the link publishes has to be visible
    // here before the author creates it: the trace and its count on the
    // reasoning row, and the rung in the reply head the preview draws.
    const REASONED = {
      ...defaultProps,
      message: replyWith({
        content: withReasoning('weighing two encryption layouts', 'the answer'),
        reasoningTokens: 1204,
        reasoningEffort: 'high',
      }),
    };

    it('tags the reply head with the rung the link publishes', () => {
      renderWithProviders(<ShareMessageModal {...REASONED} />);

      const preview = screen.getByTestId(TEST_IDS.shareMessagePreview);
      expect(within(preview).getByTestId(TEST_IDS.effortTag)).toHaveTextContent('High effort');
    });

    it('draws no effort tag for a reply that recorded no rung', () => {
      renderWithProviders(
        <ShareMessageModal
          {...defaultProps}
          message={replyWith({
            content: withReasoning('weighing two encryption layouts', 'the answer'),
          })}
        />
      );

      const preview = screen.getByTestId(TEST_IDS.shareMessagePreview);
      expect(within(preview).queryByTestId(TEST_IDS.effortTag)).not.toBeInTheDocument();
    });

    it('renders the settled reasoning row, closed, with the count the link publishes', () => {
      renderWithProviders(<ShareMessageModal {...REASONED} />);

      const toggle = screen.getByTestId(TEST_IDS.thinkingDisclosureToggle);
      expect(toggle).toHaveTextContent(/^Reasoned · 1,204 tokens$/);
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });

    it('labels the reasoning row with how long the model reasoned', () => {
      renderWithProviders(
        <ShareMessageModal
          {...REASONED}
          message={{ ...REASONED.message, reasoningDurationMs: 9000 }}
        />
      );

      expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent(
        /^Reasoned for 9s · 1,204 tokens$/
      );
    });

    it('shows the trace once the author opens the row, with no count under it', async () => {
      renderWithProviders(<ShareMessageModal {...REASONED} />);

      await userEvent.click(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle));

      const trace = await screen.findByTestId(TEST_IDS.thinkingDisclosureContent);
      expect(trace).toHaveTextContent('weighing two encryption layouts');
      expect(screen.getByTestId(TEST_IDS.shareMessagePreview)).not.toHaveTextContent(
        'reasoning tokens'
      );
    });

    it('splits the preview into a reasoning row and the answer, never raw text', () => {
      renderWithProviders(<ShareMessageModal {...REASONED} />);

      // Closed, the reasoning row hides the trace, so only the answer reads,
      // never the whole delimited field.
      const preview = screen.getByTestId(TEST_IDS.shareMessagePreview);
      expect(preview).toHaveTextContent('the answer');
      expect(preview).not.toHaveTextContent('weighing two encryption layouts');
    });

    it('previews the withheld line for a turn billed for reasoning it emitted no trace of', () => {
      renderWithProviders(
        <ShareMessageModal
          {...defaultProps}
          message={replyWith({ reasoningTokens: 900, reasoningEffort: 'high' })}
        />
      );

      // Anchored: the rung rides only on a row that has a trace to label, and
      // the public share page pins the same boundary on the same line.
      expect(screen.getByTestId(TEST_IDS.reasoningNotShared)).toHaveTextContent(
        /^Reasoning not shared · 900 tokens$/
      );
    });

    it('labels a turn whose reasoning never reached an answer', () => {
      renderWithProviders(
        <ShareMessageModal
          {...defaultProps}
          message={replyWith({
            content: withReasoning('half a thought', ''),
            reasoningEffort: 'high',
          })}
        />
      );

      expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent(
        /^Reasoned · stopped before an answer$/
      );
    });

    it('rolls a search made while reasoning into the previewed one-liner', () => {
      renderWithProviders(
        <ShareMessageModal
          {...defaultProps}
          message={replyWith({
            content: serializeSegments([
              {
                kind: 'reasoning',
                children: [
                  { kind: 'text', text: 'checking' },
                  {
                    kind: 'webSearch',
                    row: {
                      v: 1,
                      searches: [
                        {
                          query: 'q',
                          status: 'done',
                          sources: [{ title: 'Example', url: 'https://example.com/' }],
                        },
                      ],
                      notRun: { limit: 0, invalidQuery: 0 },
                    },
                  },
                ],
              },
              { kind: 'text', text: 'the answer' },
            ]),
          })}
        />
      );

      expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent(
        /^Reasoned · Searched 1 source$/
      );
      expect(screen.getByTestId(TEST_IDS.shareMessagePreview)).toHaveTextContent('the answer');
    });

    it('renders no reasoning surface for a message that never reasoned', () => {
      renderWithProviders(<ShareMessageModal {...defaultProps} />);

      expect(screen.queryByTestId(TEST_IDS.thinkingDisclosure)).not.toBeInTheDocument();
      expect(screen.getByTestId(TEST_IDS.shareMessagePreview)).toHaveTextContent(
        'Here is the final API design'
      );
    });

    it('labels the row without a rung when the message recorded no level', () => {
      renderWithProviders(
        <ShareMessageModal
          {...defaultProps}
          message={replyWith({
            content: withReasoning('weighing two encryption layouts', 'the answer'),
          })}
        />
      );

      expect(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle)).toHaveTextContent(/^Reasoned$/);
    });

    it('leaves the isolation alert as the preview\u2019s only live region', () => {
      // The reasoning surface announces only while a model works, and a message
      // being shared is settled. Two live regions in one dialog is the
      // accessibility regression this surface exists to avoid.
      renderWithProviders(
        <ShareMessageModal
          {...defaultProps}
          message={replyWith({ content: withReasoning('half a thought', '') })}
        />
      );

      expect(screen.getAllByRole('status')).toHaveLength(1);
      expect(screen.getByRole('status')).toHaveAttribute(
        'data-testid',
        TEST_IDS.shareMessageIsolationInfo
      );
    });

    it('bounds the opened trace by the preview box alone, with no second cap inside it', async () => {
      renderWithProviders(<ShareMessageModal {...REASONED} />);

      await userEvent.click(screen.getByTestId(TEST_IDS.thinkingDisclosureToggle));

      // One scroll box: the reply scrolls as a whole, so the trace the author
      // consents to reads in the same place as the answer under it.
      const trace = await screen.findByTestId(TEST_IDS.thinkingDisclosureContent);
      expect(trace.closest('.overflow-y-auto')).toBe(
        screen.getByTestId(TEST_IDS.shareMessagePreview)
      );
    });

    it('names the reasoning in the isolation copy when the link publishes a trace', () => {
      renderWithProviders(<ShareMessageModal {...REASONED} />);

      expect(screen.getByTestId(TEST_IDS.shareMessageIsolationInfo)).toHaveTextContent(
        /^Cryptographically isolated\. This link gives access to this single message only, reasoning included\.$/
      );
    });

    it('leaves the isolation copy alone when there is no trace to publish', () => {
      renderWithProviders(
        <ShareMessageModal {...defaultProps} message={replyWith({ reasoningTokens: 900 })} />
      );

      expect(screen.getByTestId(TEST_IDS.shareMessageIsolationInfo)).toHaveTextContent(
        /^Cryptographically isolated\. This link gives access to this single message only\.$/
      );
    });
  });
});
