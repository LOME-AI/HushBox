import * as React from 'react';
import { useState } from 'react';
import { Link as LinkIcon } from 'lucide-react';
import {
  Overlay,
  ModalActions,
  OverlayContent,
  OverlayHeader,
  InlineFormError,
  ScrollRegion,
  cn,
  useAsyncAction,
  useCopyToClipboard,
} from '@hushbox/ui';
import { KeyRound, Lock } from '@hushbox/ui/icons';
import { Notice } from '@hushbox/ui/notice';
import { parseAssistantMessage, TEST_IDS } from '@hushbox/shared';
import { useMessageShare } from '@/hooks/chat/use-message-share.js';
import { useModels } from '@/hooks/models/models.js';
import { MessageItem } from '@/components/chat/message/message-item.js';
import { nameplateFor } from '@/components/chat/message/model-nameplate.js';
import { buildChatContext, resolveMessageActions } from '@/lib/chat/message-actions.js';
import { useDocumentStore } from '@/stores/document.js';
import type { ComparePresentation } from '@/components/chat/message/ai-message-block.js';
import type { ModelsData } from '@/hooks/models/models.js';
import type { Message } from '@/lib/api/api.js';
import type { MessageAction } from '@/lib/chat/message-actions.js';

/** The share link is long and easy to mis-grab, so the acknowledgement holds longer than the app default. */
const COPY_RESET_MS = 3000;

/**
 * The bottom 4rem of the preview box fade out while more of the reply lies below
 * them. The fade lifts at the end, because the author is consenting to publish
 * every line and has to be able to read the last one at full contrast.
 */
const MORE_BELOW_FADE =
  '[mask-image:linear-gradient(to_bottom,black_calc(100%_-_4rem),transparent)]';

/**
 * The consent box sets the reply a step below the thread, so the bounded box shows more of
 * it: the answer at 0.9375rem, its code at 0.75rem, and 0.5rem between its blocks. The
 * segment list spaces those blocks with class-level utilities in the same layer; the
 * never-matching id term lifts these overrides to id specificity, so the 0.5rem holds
 * whatever order the stylesheet emits the two in.
 */
const PREVIEW_TEXT_SCALE = cn(
  'text-[0.9375rem] [&_[data-streamdown=code-block-body]_pre]:text-[0.75rem]',
  '[&>*:not(#preview-scale)]:my-2 [&>:first-child:not(#preview-scale)]:mt-0',
  '[&>:last-child:not(#preview-scale)]:mb-0'
);

/**
 * The one list of a shared reply's fields: every display field the link publishes,
 * which the preview draws so the author consents to all of it, plus the envelope
 * that decrypts its media and mints the link. {@link publishedReplyOf} copies exactly
 * these keys, for the caller off the thread's message and again for the preview's row, so
 * a field the link withholds (the billed cost, the token counts, the streaming-time
 * resolved name) never reaches the preview.
 */
const SHARED_REPLY_KEYS = [
  'id',
  'content',
  'createdAt',
  'modelName',
  'isSmartModel',
  'reasoningTokens',
  'reasoningEffort',
  'reasoningDurationMs',
  'deleted',
  'epochNumber',
  'wrappedContentKey',
  'senderId',
  'mediaItems',
] as const satisfies readonly (keyof Message)[];

type SharedReplyKey = (typeof SHARED_REPLY_KEYS)[number];

/** The fields the preview's row takes from the dialog rather than from the reply. */
type RowKey = 'conversationId' | 'role';

/**
 * The fields of a thread's message the link never publishes: the billed figures, the
 * streaming-time resolved name, the thread's place for the reply, and the state of a
 * turn still running or failed.
 */
type WithheldKey =
  | 'cost'
  | 'inputTokens'
  | 'outputTokens'
  | 'resolvedModelName'
  | 'parentMessageId'
  | 'batchId'
  | 'errorCode'
  | 'mediaInFlight'
  | 'mediaProgress'
  | 'awaitingStoredRow'
  | 'turnNotice'
  | 'unsavedQuestion';

/**
 * `Keys`, refused at compile time, naming the field, when `Unclassed` or `Both` is not
 * empty. The preview draws a whole `Message` through the thread's row, and every display
 * field on it is optional, so without this a field `Message` gains would reach the consent
 * preview, or drop out of it, with no one deciding which.
 */
type ClassingEveryField<Keys extends keyof Message, Unclassed extends never, Both extends never> =
  | Keys
  | Unclassed
  | Both;

/** The reply being shared, holding only {@link SHARED_REPLY_KEYS}. */
export type ShareMessageReply = Pick<
  Message,
  ClassingEveryField<
    SharedReplyKey,
    Exclude<keyof Message, SharedReplyKey | RowKey | WithheldKey>,
    Extract<SharedReplyKey, RowKey | WithheldKey>
  >
>;

/**
 * The reply as the link publishes it: the present {@link SHARED_REPLY_KEYS} of any
 * message-shaped value, a whole `Message` included, and nothing else.
 */
export function publishedReplyOf(source: ShareMessageReply): ShareMessageReply {
  const reply: ShareMessageReply = {
    id: source.id,
    content: source.content,
    createdAt: source.createdAt,
  };
  for (const key of SHARED_REPLY_KEYS) copyPresent(reply, source, key);
  return reply;
}

function copyPresent<K extends SharedReplyKey>(
  target: Pick<Message, K>,
  source: ShareMessageReply,
  key: K
): void {
  if (source[key] !== undefined) target[key] = source[key];
}

interface ShareMessageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The reply being shared, or null while none is selected. */
  message: ShareMessageReply | null;
  /** Conversation the message belongs to — needed to look up the epoch key. */
  conversationId: string | null;
}

interface ShareContentInput {
  row: Message | null;
  models: ModelsData | undefined;
  generatedUrl: string | null;
  isPending: boolean;
  onCancel: () => void;
  onCreate: () => Promise<void>;
  onClose: () => void;
}

function hasTrace(content: string): boolean {
  return parseAssistantMessage(content).some(
    (node) => node.kind === 'reasoning' && node.children.length > 0
  );
}

/** Whether more of a scroll box's content lies below what it shows, measured as it scrolls or resizes. */
function useMoreBelow(region: HTMLElement | null, content: HTMLElement | null): boolean {
  const [moreBelow, setMoreBelow] = useState(false);
  React.useEffect(() => {
    if (region === null || content === null) return;
    const measure = (): void => {
      // A pixel of slack: a zoomed page scrolls in fractions and can stop just short of the end.
      setMoreBelow(region.scrollTop + region.clientHeight < region.scrollHeight - 1);
    };
    measure();
    region.addEventListener('scroll', measure, { passive: true });
    const sizes = new ResizeObserver(measure);
    sizes.observe(region);
    sizes.observe(content);
    return () => {
      region.removeEventListener('scroll', measure);
      sizes.disconnect();
    };
  }, [region, content]);
  return moreBelow;
}

/**
 * The consent preview: the reply drawn by the thread's own row with the reader's actions,
 * so what the author approves here and what a visitor loads cannot describe the message
 * differently, then the two notes naming what the link opens and who holds its key.
 */
function SharePreview({
  row,
  models,
}: Readonly<{ row: Message; models: ModelsData | undefined }>): React.JSX.Element {
  const [region, setRegion] = useState<HTMLDivElement | null>(null);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const moreBelow = useMoreBelow(region, content);
  const publishesTrace = React.useMemo(() => hasTrace(row.content), [row.content]);
  const presentation = usePreviewPresentation(row, models);
  const readerActions = React.useMemo(() => readerActionsFor(row), [row]);
  return (
    <>
      {/* The box draws the frame and the focus outline, which the fading region would mask. */}
      <div className="border-border bg-background has-[>:focus-visible]:outline-ring overflow-hidden rounded-lg border has-[>:focus-visible]:outline-2 has-[>:focus-visible]:outline-offset-2">
        <ScrollRegion
          ref={setRegion}
          role="region"
          label="The reply as it will be shared"
          data-testid={TEST_IDS.shareMessagePreview}
          className={cn(
            // The row sets 0.375rem above its head, which makes up the box's top inset.
            'max-h-80 overflow-y-auto px-3.5 pt-1.5 pb-3.5 focus-visible:ring-0',
            moreBelow && MORE_BELOW_FADE
          )}
        >
          <div ref={setContent}>
            <MessageItem
              message={row}
              allowedActions={readerActions}
              models={models}
              compare={presentation}
            />
          </div>
        </ScrollRegion>
      </div>

      {/* A dialog's notes draw no edge, so their own padding is the space between them. */}
      <div className="flex flex-col">
        <Notice
          tone="neutral"
          icon={Lock}
          iconTone="success"
          data-testid={TEST_IDS.shareMessageIsolationInfo}
        >
          {`Cryptographically isolated. This link gives access to this single message only${
            publishesTrace ? ', reasoning included' : ''
          }.`}
        </Notice>
        {/* Static guidance: the isolation note stays the dialog's one live region. */}
        <Notice tone="neutral" icon={KeyRound} iconTone="success" live="off">
          The key is the part of the link after the #, so HushBox&apos;s servers never receive it.
          Anyone with the link can read this reply.
        </Notice>
      </div>
    </>
  );
}

function renderShareContent(input: Readonly<ShareContentInput>): React.JSX.Element {
  if (input.row === null) {
    return (
      <div className="text-muted-foreground py-4 text-center text-sm">No message selected.</div>
    );
  }

  if (input.generatedUrl === null) {
    return (
      <div className="flex flex-col gap-3">
        <SharePreview row={input.row} models={input.models} />

        <ModalActions
          cancel={{
            label: 'Cancel',
            onClick: input.onCancel,
            testId: TEST_IDS.shareMessageCancelButton,
          }}
          primary={{
            label: 'Create Link',
            onClick: () => {
              void input.onCreate();
            },
            disabled: input.isPending,
            testId: TEST_IDS.shareMessageCreateButton,
          }}
        />
      </div>
    );
  }

  return <ShareLinkResult url={input.generatedUrl} onClose={input.onClose} />;
}

/**
 * The generated-link phase. It owns the copy acknowledgement, and it is mounted
 * only while a link exists: closing the modal drops the link, which unmounts
 * this and is what returns the button to "Copy" on the next open.
 */
function ShareLinkResult({
  url,
  onClose,
}: Readonly<{ url: string; onClose: () => void }>): React.JSX.Element {
  const { copy, copied } = useCopyToClipboard({ resetAfterMs: COPY_RESET_MS });

  return (
    <>
      <div
        data-testid={TEST_IDS.shareMessageSuccess}
        role="status"
        aria-live="polite"
        className="text-success flex items-center gap-2 text-sm"
      >
        <LinkIcon className="h-4 w-4" />
        <span>Share link created!</span>
      </div>

      <div
        data-testid={TEST_IDS.shareMessageUrl}
        className="bg-muted overflow-hidden rounded-md p-3 text-xs break-all"
      >
        {url}
      </div>

      <ModalActions
        cancel={{
          label: 'Done',
          onClick: onClose,
        }}
        primary={{
          label: copied ? 'Copied' : 'Copy',
          onClick: () => {
            void copy(url);
          },
          testId: TEST_IDS.shareMessageCopyButton,
        }}
      />
    </>
  );
}

/** The message-link reader's context: what a visitor to the link may do with the reply. */
const READER_CONTEXT = buildChatContext({
  isAuthenticated: false,
  isLinkGuest: false,
  isMessageLink: true,
  privilege: undefined,
  currentUserId: undefined,
  isGroupChat: false,
});

/** The actions the link's reader gets on the reply, from the same table the reader's page reads. */
function readerActionsFor(row: Message): Set<MessageAction> {
  return resolveMessageActions(READER_CONTEXT, {
    message: row,
    isStreaming: false,
    isError: false,
    isMultiModel: false,
    canRegenerate: false,
  });
}

/**
 * The row's presentation: flush in the box, at the preview's scale, with the head spaced
 * 0.5rem from the answer and the model's own swatch. Held while the reply and the catalog
 * stay the same, since the row's memo compares it by identity.
 */
function usePreviewPresentation(row: Message, models: ModelsData | undefined): ComparePresentation {
  const catalog = models?.models;
  return React.useMemo(
    () => ({
      swatch: nameplateFor(row, catalog ?? []).swatch,
      sidePadding: 'px-0',
      textScale: PREVIEW_TEXT_SCALE,
      headSpacing: 'mb-2',
    }),
    [row, catalog]
  );
}

/**
 * The thread's row for a shared reply, built from the published fields alone, whatever the
 * caller handed over, and the conversation it belongs to. The consent preview and the
 * published page both draw their row through it, so the page shows only what the author
 * saw before publishing.
 */
export function publishedRowOf(reply: ShareMessageReply, conversationId: string | null): Message {
  return { ...publishedReplyOf(reply), conversationId: conversationId ?? '', role: 'assistant' };
}

/**
 * Opening a document closes the dialog, so the panel it opens stands beside the thread.
 * While the link is being created the dialog holds, as it does against every dismissal.
 */
function useCloseOnDocumentOpen(watching: boolean, close: () => void): void {
  React.useEffect(() => {
    if (!watching) return;
    return useDocumentStore.subscribe((state, previous) => {
      if (state.activeSelectionId !== previous.activeSelectionId) close();
    });
  }, [watching, close]);
}

export function ShareMessageModal({
  open,
  onOpenChange,
  message,
  conversationId,
}: Readonly<ShareMessageModalProps>): React.JSX.Element {
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const { data: modelsData } = useModels();

  const share = useMessageShare();
  const mutateAsync = share.mutateAsync;
  const asyncAction = useAsyncAction();
  const isPending = asyncAction.isPending;

  const row = React.useMemo(
    () => (message === null ? null : publishedRowOf(message, conversationId)),
    [message, conversationId]
  );
  const close = React.useCallback(() => {
    onOpenChange(false);
  }, [onOpenChange]);
  useCloseOnDocumentOpen(open && !isPending, close);

  const [previousOpen, setPreviousOpen] = useState(open);
  if (open !== previousOpen) {
    setPreviousOpen(open);
    setGeneratedUrl(null);
    asyncAction.clearError();
  }

  async function handleCreate(): Promise<void> {
    // Media-only assistant messages (image/video/audio) carry empty
    // `content` — the bytes live in encrypted contentItems addressed
    // by `messageId` server-side. The share API only needs envelope metadata,
    // so don't gate on textual content being present.
    if (!message || !conversationId || message.epochNumber == null || !message.wrappedContentKey) {
      return;
    }
    const { id: messageId, epochNumber, wrappedContentKey } = message;

    const result = await asyncAction.run(async () =>
      mutateAsync({
        messageId,
        conversationId,
        epochNumber,
        wrappedContentKey,
      })
    );

    if (result.ok) setGeneratedUrl(result.value.url);
  }

  function handleCancel(): void {
    onOpenChange(false);
  }

  return (
    <Overlay
      open={open}
      onOpenChange={onOpenChange}
      ariaLabel="Share Message"
      dismissible={!isPending}
    >
      <OverlayContent data-testid={TEST_IDS.shareMessageModal}>
        <OverlayHeader title="Share Message" />

        {renderShareContent({
          row,
          models: modelsData,
          generatedUrl,
          isPending,
          onCancel: handleCancel,
          onCreate: handleCreate,
          onClose: () => {
            onOpenChange(false);
          },
        })}

        <InlineFormError error={asyncAction.error} errorKey={asyncAction.errorKey} />
      </OverlayContent>
    </Overlay>
  );
}
