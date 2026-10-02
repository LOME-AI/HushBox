import * as React from 'react';
import { asErrorCode, friendlyErrorMessage, TEST_IDS } from '@hushbox/shared';
import {
  ModelNameplate,
  effortTagOf,
  nameplateFor,
} from '@/components/chat/message/model-nameplate';
import { ReplyingTo } from '@/components/chat/message/replying-to';
import { MediaPlaceholder } from '@/components/chat/media/media-preview';
import { ThinkingIndicator } from '@/components/chat/indicators/thinking-indicator';
import { TtsStopButton } from '@/components/chat/indicators/tts-stop-button';
import { TtsStoppedNotice } from '@/components/chat/indicators/tts-stopped-notice';
import {
  AssistantSegments,
  useAssistantRender,
} from '@/components/chat/segments/assistant-segments';
import { useReplyingToName } from '@/hooks/chat/use-replying-to-name';
import type { AssistantRender } from '@/components/chat/segments/assistant-segments';
import type { ModelsData } from '@/hooks/models/models';
import type { Message } from '@/lib/api/api';
import type { Model } from '@hushbox/shared';

const MEDIA_LOADING_LABEL_BY_TYPE: Record<'image' | 'audio' | 'video', string> = {
  image: 'Generating image…',
  video: 'Generating video…',
  audio: 'Generating audio…',
};

function MediaInFlightPlaceholder({
  mediaType,
  aspectRatio,
  progressPercent,
}: Readonly<{
  mediaType: 'image' | 'audio' | 'video';
  aspectRatio: string | undefined;
  progressPercent: number | undefined;
}>): React.JSX.Element {
  const loadingLabel = MEDIA_LOADING_LABEL_BY_TYPE[mediaType];
  return (
    <MediaPlaceholder
      width={null}
      height={null}
      status="loading"
      loadingLabel={loadingLabel}
      {...(aspectRatio !== undefined && { aspectRatio })}
      {...(progressPercent !== undefined && { progressPercent })}
    />
  );
}

/**
 * The name to say while a turn is still working. Shared by the two surfaces
 * that say it — the reasoning row and the answer-body indicator — so a reader
 * never sees one turn name the model differently from the next.
 */
function resolveThinkingModelName(
  primaryMessage: Message,
  modelName: string | undefined,
  models: ModelsData | undefined
): string {
  const rawModelName = primaryMessage.modelName ?? modelName ?? '';
  return models?.models.find((m) => m.id === rawModelName)?.name ?? rawModelName;
}

/**
 * The answer region's contents. A failed turn keeps whatever settled tree it
 * streamed above the error; a media turn shows its backdrop until the media
 * lands; a turn that has streamed nothing yet shows the thinking indicator;
 * everything else is the segment tree.
 */
function AIMessageContent({
  primaryMessage,
  isStreaming,
  render,
}: Readonly<{
  primaryMessage: Message;
  isStreaming: boolean | undefined;
  render: AssistantRender;
}>): React.JSX.Element {
  if (primaryMessage.errorCode) {
    return (
      <>
        {render.tree.length > 0 ? <AssistantSegments {...render} /> : null}
        <p className="text-destructive text-sm" data-testid={TEST_IDS.modelErrorMessage}>
          {friendlyErrorMessage(asErrorCode(primaryMessage.errorCode))}
        </p>
      </>
    );
  }
  if (isStreaming === true && render.tree.length === 0) {
    // A media turn carries `mediaInFlight` from the first frame (stamped at
    // creation), so the backdrop shows immediately.
    const mediaInFlight = primaryMessage.mediaInFlight;
    if (mediaInFlight) {
      return (
        <MediaInFlightPlaceholder
          mediaType={mediaInFlight.mediaType}
          aspectRatio={mediaInFlight.aspectRatio}
          progressPercent={primaryMessage.mediaProgress?.percent}
        />
      );
    }
    return <ThinkingIndicator modelName={render.context.modelName ?? ''} />;
  }
  return <AssistantSegments {...render} />;
}

/**
 * The nametag is shown when the assistant message has visible content of any
 * kind: text body, an in-flight stream, or persisted media items. Pure media
 * responses (image/video/audio) carry empty `content` but still need the
 * nametag so the user can see which model produced the media.
 */
function shouldRenderAIMessageNametag(message: Message, isStreaming: boolean | undefined): boolean {
  if (message.content !== '') return true;
  if (isStreaming === true) return true;
  return (message.mediaItems?.length ?? 0) > 0;
}

const NO_MODELS: readonly Model[] = [];

/**
 * The reply's head. The effort tag follows the live render's reasoning state,
 * so it appears exactly when the reasoning row would name the level; the
 * turn's selected model names a reply that does not yet carry its own.
 */
function AIMessageNameplate({
  primaryMessage,
  modelName,
  models,
  render,
}: Readonly<{
  primaryMessage: Message;
  modelName: string | undefined;
  models: ModelsData | undefined;
  render: AssistantRender;
}>): React.JSX.Element {
  const replyingToName = useReplyingToName(primaryMessage);
  const catalog = models?.models ?? NO_MODELS;
  const plate = React.useMemo(
    () =>
      nameplateFor(
        primaryMessage.modelName || modelName === undefined
          ? primaryMessage
          : { ...primaryMessage, modelName },
        catalog
      ),
    [primaryMessage, modelName, catalog]
  );
  return (
    <div data-testid={TEST_IDS.modelNametagContainer} className="mb-2.5 flex items-center gap-2">
      <div className="min-w-0 flex-1">
        <ModelNameplate
          {...plate}
          effortTag={effortTagOf(render.context)}
          {...(replyingToName !== undefined && {
            replyingTo: <ReplyingTo name={replyingToName} />,
          })}
        />
      </div>
      <TtsStopButton messageId={primaryMessage.id} />
    </div>
  );
}

/**
 * The assistant half of a row. Owns the single parse of the message's raw text:
 * reasoning, search rows and answer all ride in the one field (store raw, parse
 * on demand), and every block derives from the one tree.
 *
 * The whole flow sits in the answer's live region; each block inside it carries
 * `aria-live="off"`, so a reasoning or search row inserted mid-stream is never
 * read out through that region, and live reasoning's hidden `role="status"`
 * is the turn's sole announcement while it reasons.
 */
export function AIMessageBlock({
  primaryMessage,
  isStreaming,
  modelName,
  models,
}: Readonly<{
  primaryMessage: Message;
  isStreaming: boolean | undefined;
  modelName: string | undefined;
  models: ModelsData | undefined;
}>): React.JSX.Element {
  const render = useAssistantRender(primaryMessage.content, {
    messageId: primaryMessage.id,
    isStreaming: isStreaming === true,
    modelName: resolveThinkingModelName(primaryMessage, modelName, models),
    reasoningTokens: primaryMessage.reasoningTokens,
    reasoningEffort: primaryMessage.reasoningEffort,
  });
  return (
    <>
      <TtsStoppedNotice messageId={primaryMessage.id} />
      {shouldRenderAIMessageNametag(primaryMessage, isStreaming) && (
        <AIMessageNameplate
          primaryMessage={primaryMessage}
          modelName={modelName}
          models={models}
          render={render}
        />
      )}
      <div
        data-testid={TEST_IDS.aiMessageLiveRegion}
        aria-live={isStreaming === true ? 'polite' : 'off'}
        aria-atomic="false"
        // Clips only sideways, so the ring of a first block's toggle keeps its
        // top edge, and the side padding (offset by the negative margin, so the
        // text does not move) is the room for its left and right edges. The
        // flow root keeps the block formatting context `overflow-hidden` gave.
        className="-mx-1 flow-root w-[calc(100%+0.5rem)] overflow-x-clip px-1 text-base leading-relaxed break-words"
      >
        <AIMessageContent
          primaryMessage={primaryMessage}
          isStreaming={isStreaming}
          render={render}
        />
      </div>
    </>
  );
}
