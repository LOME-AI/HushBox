import * as React from 'react';
import { parseAssistantMessage } from '@hushbox/shared';
import { ThinkingIndicator } from '@/components/chat/indicators/thinking-indicator';
import { ReasoningNotShared } from '@/components/chat/message/thinking-disclosure';
import { buildRenderContext } from '@/components/chat/segments/render-context';
import { SegmentList } from '@/components/chat/segments/segment-list';
import type {
  MessageRenderFacts,
  SegmentRenderContext,
} from '@/components/chat/segments/render-context';
import type { Segment } from '@hushbox/shared';

export interface AssistantRender {
  readonly tree: readonly Segment[];
  readonly context: SegmentRenderContext;
}

/**
 * Parses an assistant message's raw text once and derives the whole-message
 * render context from it. Every surface that shows assistant text starts here,
 * so the owner, a watcher, a reload and a share read the same tree.
 */
export function useAssistantRender(content: string, facts: MessageRenderFacts): AssistantRender {
  const { messageId, isStreaming, modelName, reasoningTokens, reasoningEffort } = facts;
  const tree = React.useMemo(() => parseAssistantMessage(content), [content]);
  const context = React.useMemo(
    () =>
      buildRenderContext(tree, {
        messageId,
        isStreaming,
        modelName,
        reasoningTokens,
        reasoningEffort,
      }),
    [tree, messageId, isStreaming, modelName, reasoningTokens, reasoningEffort]
  );
  return { tree, context };
}

function hasReasoning(tree: readonly Segment[]): boolean {
  return tree.some((node) => node.kind === 'reasoning');
}

/**
 * The assistant message body: the not-shared line for a turn billed for
 * reasoning it never showed, the root flow through the segment dispatcher, and
 * the still-working cue after a settled row that ends a streaming turn.
 */
export function AssistantSegments({ tree, context }: AssistantRender): React.JSX.Element {
  const tokenCount = context.reasoningTokens ?? 0;
  return (
    <>
      {!hasReasoning(tree) && tokenCount > 0 ? (
        <div className="mb-2.5">
          <ReasoningNotShared tokenCount={tokenCount} />
        </div>
      ) : null}
      <SegmentList nodes={tree} context={context} parent="root" />
      {context.workingAfterKey === undefined ? null : (
        <div className="mt-2">
          <ThinkingIndicator modelName={context.modelName ?? ''} />
        </div>
      )}
    </>
  );
}
