import * as React from 'react';
import { useState } from 'react';
import { Lock, Link as LinkIcon } from 'lucide-react';
import {
  Overlay,
  ModalActions,
  Alert,
  OverlayContent,
  OverlayHeader,
  InlineFormError,
  useAsyncAction,
  useCopyToClipboard,
} from '@hushbox/ui';
import { assistantAnswerText, TEST_IDS } from '@hushbox/shared';
import { useMessageShare } from '@/hooks/chat/use-message-share.js';
import { useMessageContentKey } from '@/hooks/crypto/use-decrypted-media.js';
import { MessageMediaList } from '@/components/chat/message/message-media-list.js';
import {
  AssistantSegments,
  useAssistantRender,
} from '@/components/chat/segments/assistant-segments.js';
import {
  buildMessageEnvelopeContext,
  messageMediaToRenderable,
  type MessageEnvelopeContext,
} from '@/components/chat/media/media-content-item.js';
import type { ResolvedReasoningEffort, Segment } from '@hushbox/shared';
import type { MessageMediaItem } from '@/lib/api/api.js';

/** The share link is long and easy to mis-grab, so the acknowledgement holds longer than the app default. */
const COPY_RESET_MS = 3000;

/**
 * Caps the reasoning surface alone, so an opened trace scrolls inside it
 * instead of pushing Create Link down the dialog. It scrolls rather than clips
 * because the author is consenting to publish the trace and has to be able to
 * read it, and it stops at the surface because over the whole preview it would
 * also shrink a media message that previewed whole before reasoning existed.
 */
const TRACE_BOUND = 'max-h-64 overflow-y-auto';

interface ShareMessageModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId: string | null;
  messageContent: string | null;
  /** Conversation the message belongs to — needed to look up the epoch key. */
  conversationId: string | null;
  /** Epoch number the message was encrypted under. */
  epochNumber: number | null;
  /** Base64-encoded wrapped content key from the message envelope. */
  wrappedContentKey: string | null;
  /**
   * The message's sender id — the final field of the content-location AAD the
   * media preview must reconstruct to decrypt member/epoch media. Absent/null
   * means the preview can't build the envelope and media stays unresolved.
   */
  senderId?: string | null;
  /** Media items on the message — shown in the preview the same way as chat. */
  mediaItems: MessageMediaItem[] | null;
  /**
   * Reasoning tokens the turn was billed for. A share link publishes the
   * figure, so the preview shows it rather than letting the author consent to
   * a disclosure they were never shown.
   */
  reasoningTokens?: number | null;
  /** The rung the turn ran at; a share link publishes it alongside the trace. */
  reasoningEffort?: ResolvedReasoningEffort | null;
}

interface ShareContentInput {
  messageId: string | null;
  messageContent: string | null;
  reasoningTokens: number | null;
  reasoningEffort: ResolvedReasoningEffort | null;
  /** Rendered media list for the preview (null when the message has no media). */
  mediaPreview: React.ReactNode;
  generatedUrl: string | null;
  isPending: boolean;
  onCancel: () => void;
  onCreate: () => Promise<void>;
  onClose: () => void;
}

function hasTrace(tree: readonly Segment[]): boolean {
  return tree.some((node) => node.kind === 'reasoning' && node.children.length > 0);
}

/**
 * The consent preview: the reasoning the link publishes, through the same parse
 * and dispatcher the public share page runs, so what the author approves here
 * and what a visitor loads cannot describe the message differently; the answer
 * as clamped text; the media; and the isolation note naming what the link opens.
 */
function SharePreview({
  messageId,
  content,
  reasoningTokens,
  reasoningEffort,
  mediaPreview,
}: Readonly<{
  messageId: string;
  content: string;
  reasoningTokens: number | null;
  reasoningEffort: ResolvedReasoningEffort | null;
  mediaPreview: React.ReactNode;
}>): React.JSX.Element {
  const { tree, context } = useAssistantRender(content, {
    // Its own view state: opening the preview's reasoning opens nothing in the chat behind it.
    messageId: `share-preview ${messageId}`,
    isStreaming: false,
    modelName: undefined,
    reasoningTokens: reasoningTokens ?? undefined,
    reasoningEffort: reasoningEffort ?? undefined,
  });
  const answer = assistantAnswerText(content);
  return (
    <>
      <div
        data-testid={TEST_IDS.shareMessagePreview}
        className="border-border rounded-md border p-3"
      >
        <div className={TRACE_BOUND}>
          <AssistantSegments
            tree={tree.filter((node) => node.kind === 'reasoning')}
            context={context}
          />
        </div>
        {answer !== '' && <p className="line-clamp-4 text-sm">{answer}</p>}
        {mediaPreview}
      </div>

      <Alert variant="default" data-testid={TEST_IDS.shareMessageIsolationInfo}>
        <Lock />
        <span>
          {`Cryptographically isolated. This link gives access to this single message only${
            hasTrace(tree) ? ', reasoning included' : ''
          }.`}
        </span>
      </Alert>
    </>
  );
}

function renderShareContent(input: Readonly<ShareContentInput>): React.JSX.Element {
  if (!input.messageId) {
    return (
      <div className="text-muted-foreground py-4 text-center text-sm">No message selected.</div>
    );
  }

  if (input.generatedUrl === null) {
    return (
      <>
        <SharePreview
          messageId={input.messageId}
          content={input.messageContent ?? ''}
          reasoningTokens={input.reasoningTokens}
          reasoningEffort={input.reasoningEffort}
          mediaPreview={input.mediaPreview}
        />

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
      </>
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

export function ShareMessageModal({
  open,
  onOpenChange,
  messageId,
  messageContent,
  conversationId,
  epochNumber,
  wrappedContentKey,
  senderId,
  mediaItems,
  reasoningTokens,
  reasoningEffort,
}: Readonly<ShareMessageModalProps>): React.JSX.Element {
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);

  const share = useMessageShare();
  const mutateAsync = share.mutateAsync;
  const asyncAction = useAsyncAction();
  const isPending = asyncAction.isPending;

  // Resolve the content key the same way the chat does so the preview renders
  // media identically. The sender is an authenticated member, so the epoch key
  // is already cached; MessageMediaList renders nothing when there's no media.
  const {
    contentKey,
    wrappedContentKey: contentKeyWrap,
    error: contentKeyError,
  } = useMessageContentKey(conversationId ?? '', epochNumber ?? 0, wrappedContentKey ?? '');
  const envelopeContext: MessageEnvelopeContext | undefined = buildMessageEnvelopeContext({
    contentKey,
    wrappedContentKey: contentKeyWrap,
    conversationId,
    messageId,
    epochNumber,
    senderId,
  });
  const media = (mediaItems ?? [])
    .toSorted((a, b) => a.position - b.position)
    .map((item) => messageMediaToRenderable(item, envelopeContext));

  const [previousOpen, setPreviousOpen] = useState(open);
  if (open !== previousOpen) {
    setPreviousOpen(open);
    setGeneratedUrl(null);
    asyncAction.clearError();
  }

  async function handleCreate(): Promise<void> {
    // Media-only assistant messages (image/video/audio) carry empty
    // `messageContent` — the bytes live in encrypted contentItems addressed
    // by `messageId` server-side. The share API only needs envelope metadata,
    // so don't gate on textual content being present.
    if (!messageId || !conversationId || epochNumber == null || !wrappedContentKey) {
      return;
    }

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
          messageId,
          messageContent,
          reasoningTokens: reasoningTokens ?? null,
          reasoningEffort: reasoningEffort ?? null,
          mediaPreview: (
            <MessageMediaList
              media={media}
              contentKeyError={contentKeyError}
              ariaPrefix="Generated"
            />
          ),
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
