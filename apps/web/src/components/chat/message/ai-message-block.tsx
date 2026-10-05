import * as React from 'react';
import { TEST_IDS } from '@hushbox/shared';
import { cn } from '@hushbox/ui';
import {
  ModelNameplate,
  effortTagOf,
  nameplateFor,
} from '@/components/chat/message/model-nameplate';
import {
  REPLY_ANSWER_REGION_CLASS,
  REPLY_HEAD_GAP_CLASS,
} from '@/components/chat/message/reply-classes';
import { ReplyingTo } from '@/components/chat/message/replying-to';
import { MediaPlaceholder } from '@/components/chat/media/media-preview';
import { TurnNoticeView } from '@/components/chat/notice/turn-notice-view';
import { ThinkingIndicator } from '@/components/chat/indicators/thinking-indicator';
import { TtsStopButton } from '@/components/chat/indicators/tts-stop-button';
import { TtsStoppedNotice } from '@/components/chat/indicators/tts-stopped-notice';
import {
  AssistantSegments,
  useAssistantRender,
} from '@/components/chat/segments/assistant-segments';
import { useReplyingToName } from '@/hooks/chat/use-replying-to-name';
import { turnNoticeForCode } from '@/lib/chat/turn-notice';
import type { AssistantRender } from '@/components/chat/segments/assistant-segments';
import type { ModelsData } from '@/hooks/models/models';
import type { Message } from '@/lib/api/api';
import type { Model, NoticeReason } from '@hushbox/shared';
import type { ModelSwatch } from '@hushbox/shared/design-tokens';

/**
 * How a reply draws when the surface holding it, not the thread's column, sets its frame.
 * A reply drawn under one gets a cost-only footer, with no date and no "Saved encrypted";
 * the share dialog's preview relies on that to show a reply that carries no cost as its
 * controls alone.
 */
export interface ComparePresentation {
  /** The swatch the holding surface assigns the reply's model. */
  readonly swatch: ModelSwatch;
  /** The row's side padding, in place of the column's, for a surface that sets its own gutters. */
  readonly sidePadding: string;
  /** The answer's text size and block spacing on the holding surface. */
  readonly textScale: string;
  /** Classes spacing the head from the answer, in place of the rule a compare group draws. */
  readonly headSpacing?: string | undefined;
  /** A control the holding surface starts the reply's control row with. */
  readonly leadingControl?: React.ReactNode;
}

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

/** Re-running a failed model's reply from its slot, when the viewer may. */
export interface SlotRegenerate {
  readonly onRegenerate?: (() => void) | undefined;
  readonly regenerateRefusal?: NoticeReason | undefined;
}

/**
 * The answer region's contents. A failed turn keeps whatever settled tree it
 * streamed above the failed model's slot; a media turn shows its backdrop until
 * the media lands; a turn that has streamed nothing yet shows the thinking
 * indicator; everything else is the segment tree.
 */
function AIMessageContent({
  primaryMessage,
  isStreaming,
  render,
  regenerate,
}: Readonly<{
  primaryMessage: Message;
  isStreaming: boolean | undefined;
  render: AssistantRender;
  regenerate: SlotRegenerate;
}>): React.JSX.Element {
  if (primaryMessage.errorCode) {
    return (
      <>
        {render.tree.length > 0 ? <AssistantSegments {...render} /> : null}
        <TurnNoticeView
          placement="slot"
          notice={turnNoticeForCode(primaryMessage.errorCode)}
          {...(regenerate.onRegenerate !== undefined && { onRegenerate: regenerate.onRegenerate })}
          {...(regenerate.regenerateRefusal !== undefined && {
            regenerateRefusal: regenerate.regenerateRefusal,
          })}
        />
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
 * kind: text body, an in-flight stream, persisted media items, or the failed
 * model's slot. Pure media responses (image/video/audio) carry empty `content`
 * but still need the nametag so the user can see which model produced the media.
 */
function shouldRenderAIMessageNametag(message: Message, isStreaming: boolean | undefined): boolean {
  if (message.content !== '') return true;
  if (message.errorCode !== undefined) return true;
  if (isStreaming === true) return true;
  return (message.mediaItems?.length ?? 0) > 0;
}

const NO_MODELS: readonly Model[] = [];

/**
 * The reply's head. The effort tag follows the live render's reasoning state,
 * so it appears once the first reasoning span has settled into a row; the
 * turn's selected model names a streaming reply that does not yet carry its
 * own. A stored reply only ever names its own model: the selected model is the
 * reader's current choice, not the one that wrote it.
 */
function AIMessageNameplate({
  primaryMessage,
  isStreaming,
  modelName,
  models,
  render,
  compare,
}: Readonly<{
  primaryMessage: Message;
  isStreaming: boolean | undefined;
  modelName: string | undefined;
  models: ModelsData | undefined;
  render: AssistantRender;
  compare: ComparePresentation | undefined;
}>): React.JSX.Element {
  const replyingToName = useReplyingToName(primaryMessage);
  const catalog = models?.models ?? NO_MODELS;
  const plate = React.useMemo(
    () =>
      nameplateFor(
        primaryMessage.modelName || isStreaming !== true || modelName === undefined
          ? primaryMessage
          : { ...primaryMessage, modelName },
        catalog
      ),
    [primaryMessage, isStreaming, modelName, catalog]
  );
  return (
    <div
      data-testid={TEST_IDS.modelNametagContainer}
      className={cn(
        REPLY_HEAD_GAP_CLASS,
        'flex items-center gap-2',
        compare !== undefined && (compare.headSpacing ?? 'border-border border-b pb-2')
      )}
    >
      <div className="min-w-0 flex-1">
        <ModelNameplate
          {...plate}
          {...(compare !== undefined && { swatch: compare.swatch })}
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
  compare,
  onRegenerate,
  regenerateRefusal,
}: Readonly<
  {
    primaryMessage: Message;
    isStreaming: boolean | undefined;
    modelName: string | undefined;
    models: ModelsData | undefined;
    /** Set when a surface holding the reply, not the thread's column, sets its frame. */
    compare?: ComparePresentation | undefined;
  } & SlotRegenerate
>): React.JSX.Element {
  const render = useAssistantRender(primaryMessage.content, {
    messageId: primaryMessage.id,
    isStreaming: isStreaming === true,
    modelName: resolveThinkingModelName(primaryMessage, modelName, models),
    reasoningTokens: primaryMessage.reasoningTokens,
    reasoningEffort: primaryMessage.reasoningEffort,
    reasoningDurationMs: primaryMessage.reasoningDurationMs,
  });
  return (
    <>
      <TtsStoppedNotice messageId={primaryMessage.id} />
      {shouldRenderAIMessageNametag(primaryMessage, isStreaming) && (
        <AIMessageNameplate
          primaryMessage={primaryMessage}
          isStreaming={isStreaming}
          modelName={modelName}
          models={models}
          render={render}
          compare={compare}
        />
      )}
      <div
        data-testid={TEST_IDS.aiMessageLiveRegion}
        aria-live={isStreaming === true ? 'polite' : 'off'}
        aria-atomic="false"
        className={cn(REPLY_ANSWER_REGION_CLASS, compare?.textScale)}
      >
        <AIMessageContent
          primaryMessage={primaryMessage}
          isStreaming={isStreaming}
          render={render}
          regenerate={{ onRegenerate, regenerateRefusal }}
        />
      </div>
    </>
  );
}
