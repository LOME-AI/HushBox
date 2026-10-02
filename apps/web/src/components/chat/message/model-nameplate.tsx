import * as React from 'react';
import {
  parseAssistantMessage,
  REASONING_EFFORT_LABELS,
  shortenModelName,
  TEST_IDS,
} from '@hushbox/shared';
import { Swatch } from '@hushbox/ui/marks';
import { buildRenderContext } from '@/components/chat/segments/render-context';
import { modelSwatch } from '@/lib/utils/model-color';
import type { SegmentRenderContext } from '@/components/chat/segments/render-context';
import type { Message } from '@/lib/api/api';
import type { Model } from '@hushbox/shared';
import type { ModelSwatch } from '@hushbox/shared/design-tokens';

export interface ModelNameplateProps {
  readonly modelName: string;
  /** The model's maker; empty when the catalog does not know the model. */
  readonly provider: string;
  readonly swatch: ModelSwatch;
  readonly effortTag?: string | undefined;
  readonly smart?: boolean;
  /** Whom the reply answers in a group chat. */
  readonly replyingTo?: React.ReactNode;
}

/** What decides whether a reply names the level it reasoned at. */
export type EffortTagFacts = Pick<
  SegmentRenderContext,
  'firstReasoningKey' | 'liveReasoningKey' | 'hasAnswer' | 'isStreaming' | 'reasoningEffort'
>;

/**
 * "<Rung> effort", exactly when the reply's settled reasoning row names a rung:
 * a trace exists, its first span is no longer live, the turn did not stop
 * before an answer, and a level was recorded.
 */
export function effortTagOf(facts: EffortTagFacts): string | undefined {
  const { firstReasoningKey, liveReasoningKey, hasAnswer, isStreaming, reasoningEffort } = facts;
  if (firstReasoningKey === undefined || firstReasoningKey === liveReasoningKey) return undefined;
  if (!hasAnswer && !isStreaming) return undefined;
  if (reasoningEffort === undefined) return undefined;
  return `${REASONING_EFFORT_LABELS[reasoningEffort]} effort`;
}

/** The effort tag of a stored reply, read as settled. */
function storedEffortTag(message: Message): string | undefined {
  // No recorded level means no tag, so the parse is skipped.
  if (message.reasoningEffort === undefined) return undefined;
  return effortTagOf(
    buildRenderContext(parseAssistantMessage(message.content), {
      messageId: message.id,
      isStreaming: false,
      modelName: undefined,
      reasoningTokens: message.reasoningTokens,
      reasoningEffort: message.reasoningEffort,
    })
  );
}

/**
 * The name a reply goes by. A Smart-routed reply's resolved name arrives while
 * it streams, before the catalog lookup of the resolved id can run, and keeps
 * the name stable across it.
 */
function displayNameOf(message: Message, model: Model | undefined): string {
  const display = message.resolvedModelName ?? model?.name ?? message.modelName;
  return display ? shortenModelName(display) : 'AI';
}

/** What a reply's nameplate says, from the reply and the model catalog. */
export function nameplateFor(message: Message, models: readonly Model[]): ModelNameplateProps {
  const modelId = message.modelName ?? 'AI';
  const model = models.find((m) => m.id === message.modelName);
  const effortTag = storedEffortTag(message);
  return {
    modelName: displayNameOf(message, model),
    provider: model?.provider ?? '',
    swatch: modelSwatch(modelId),
    ...(effortTag !== undefined && { effortTag }),
    ...(message.isSmartModel === true && { smart: true }),
  };
}

function NameplateTag({
  testId,
  title,
  children,
}: Readonly<{ testId: string; title?: string; children: React.ReactNode }>): React.JSX.Element {
  return (
    <span
      data-testid={testId}
      title={title}
      className="border-border text-muted-foreground inline-flex h-5 shrink-0 items-center rounded-full border px-1.5 text-xs whitespace-nowrap"
    >
      {children}
    </span>
  );
}

/**
 * A reply's head: the model's swatch, its name and maker, the level it
 * reasoned at, and whom it answers in a group chat. The head wraps, so below
 * 768px the replying-to label takes its own row, indented past the swatch.
 */
export function ModelNameplate({
  modelName,
  provider,
  swatch,
  effortTag,
  smart,
  replyingTo,
}: ModelNameplateProps): React.JSX.Element {
  return (
    <div
      data-slot="model-nameplate"
      className="flex min-h-6 min-w-0 flex-wrap items-center gap-x-2 gap-y-0 font-sans text-[0.8125rem]"
    >
      <span className="inline-flex max-w-full min-w-0 items-center gap-2">
        <Swatch swatch={swatch} />
        <span
          data-testid={TEST_IDS.modelNametag}
          className="text-foreground min-w-0 truncate font-semibold"
        >
          {modelName}
        </span>
      </span>
      {provider === '' ? null : <span className="text-muted-foreground">{provider}</span>}
      {smart === true ? (
        <NameplateTag
          testId={TEST_IDS.smartModelChip}
          title="This response was routed by Smart Model"
        >
          Smart
        </NameplateTag>
      ) : null}
      {effortTag === undefined ? null : (
        <NameplateTag testId={TEST_IDS.effortTag}>{effortTag}</NameplateTag>
      )}
      {replyingTo === undefined ? null : (
        <span className="flex min-w-0 max-md:basis-full max-md:pl-4">{replyingTo}</span>
      )}
    </div>
  );
}
