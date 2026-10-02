import * as React from 'react';
import { useMemo } from 'react';
import { createFileRoute, useParams } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { MessageBody } from '@/components/chat/message/message-body.js';
import {
  AssistantSegments,
  useAssistantRender,
} from '@/components/chat/segments/assistant-segments.js';
import {
  useSharedMessage,
  type SharedContentItem,
  type SharedMessageData,
} from '@/hooks/chat/use-shared-message.js';
import { AppShell } from '../components/shared/app-shell.js';
import type {
  MessageEnvelopeContext,
  RenderableMedia,
} from '@/components/chat/media/media-content-item.js';

export const Route = createFileRoute('/share/m/$shareId')({
  component: SharedMessagePage,
});

/**
 * One shared text item, through the same parse and segment dispatcher the chat
 * uses, so a share shows exactly the reasoning, search rows and answer its
 * author sees, the withheld-tokens line included. The share API carries no role
 * field, so the parse is unconditional; text that was never framed parses as
 * one answer. Every streaming state is unreachable here by construction: a
 * shared message is settled, and no model name is known.
 */
function SharedTextItem({
  shareId,
  item,
}: Readonly<{
  shareId: string;
  item: Extract<SharedContentItem, { type: 'text' }>;
}>): React.JSX.Element {
  const render = useAssistantRender(item.content, {
    messageId: `${shareId} ${String(item.position)}`,
    isStreaming: false,
    modelName: undefined,
    reasoningTokens: item.reasoningTokens ?? undefined,
    reasoningEffort: item.reasoningEffort ?? undefined,
  });
  return <AssistantSegments {...render} />;
}

function SharedMessagePage(): React.JSX.Element {
  const { shareId } = useParams({ from: '/share/m/$shareId' });
  const keyBase64 = useMemo(() => globalThis.location.hash.slice(1) || null, []);

  const { data, isLoading, isError } = useSharedMessage(shareId, keyBase64);

  // Every branch renders inside AppShell so its `main#main` stays one mounted
  // element as the page settles, keeping the focus the route announcer gave it.
  if (isLoading) {
    return (
      <AppShell>
        <div
          data-testid={TEST_IDS.sharedMessageLoading}
          role="status"
          aria-live="polite"
          className="flex h-full items-center justify-center"
        >
          <span className="text-muted-foreground text-sm">Decrypting shared message...</span>
        </div>
      </AppShell>
    );
  }

  if (isError || !data) {
    return (
      <AppShell>
        <div
          data-testid={TEST_IDS.sharedMessageError}
          role="alert"
          className="flex flex-1 items-center justify-center"
        >
          <div className="flex flex-col items-center gap-3">
            <AlertTriangle className="text-muted-foreground h-8 w-8" />
            <h2 className="text-lg font-semibold">Unable to access message</h2>
            <p className="text-muted-foreground text-sm">
              This share link may be invalid or expired.
            </p>
          </div>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="flex flex-1 flex-col overflow-y-auto px-4 py-8">
        <div className="mx-auto w-full max-w-3xl">
          <h1 className="text-muted-foreground mb-2 text-sm font-medium">Shared message</h1>
          <div data-testid={TEST_IDS.sharedMessageContent}>
            {data.deleted ? (
              <MessageBody variant="assistant" media={[]} ariaPrefix="Shared" deleted />
            ) : (
              <LiveSharedMessageBody shareId={shareId} data={data} />
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

/**
 * Renders the shared message through the same MessageBody the chat uses, so
 * media looks identical to a regular conversation. Text-then-media mirrors how
 * an assistant message renders in chat (a single content block, then media).
 */
function LiveSharedMessageBody({
  shareId,
  data,
}: Readonly<{
  shareId: string;
  data: Extract<SharedMessageData, { deleted: false }>;
}>): React.JSX.Element {
  const textItems = data.contentItems.filter(
    (item): item is Extract<SharedContentItem, { type: 'text' }> => item.type === 'text'
  );
  // Shared media decrypts under the same location-bound envelope the member
  // side uses; the share carries the message-level AAD inputs and each item
  // completes the tuple with its own position.
  const envelopeContext: MessageEnvelopeContext = {
    contentKey: data.contentKey,
    wrappedContentKey: data.wrappedContentKey,
    conversationId: data.conversationId,
    messageId: data.messageId,
    epochNumber: data.epochNumber,
    senderId: data.senderId,
  };
  const media: RenderableMedia[] = data.contentItems
    .filter((item): item is Extract<SharedContentItem, { type: 'media' }> => item.type === 'media')
    .map((item) => ({
      contentItemId: item.contentItemId,
      contentType: item.contentType,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      width: item.width,
      height: item.height,
      downloadUrl: item.downloadUrl,
      envelope: { ...envelopeContext, position: item.position },
    }));

  return (
    <MessageBody variant="assistant" media={media} ariaPrefix="Shared">
      {textItems.length > 0 && (
        <div className="w-full overflow-hidden text-base leading-relaxed break-words">
          {textItems.map((item) => (
            <SharedTextItem key={`text-${String(item.position)}`} shareId={shareId} item={item} />
          ))}
        </div>
      )}
    </MessageBody>
  );
}
