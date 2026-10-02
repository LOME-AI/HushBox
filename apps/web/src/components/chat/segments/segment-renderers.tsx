import * as React from 'react';
import { cn } from '@hushbox/ui';
import { ThinkingDisclosure } from '@/components/chat/message/thinking-disclosure';
import { WebSearchRow } from '@/components/chat/segments/web-search-row';
import type { SegmentRenderContext } from '@/components/chat/segments/render-context';
import type { ContainerKind, Segment, SegmentByKind, SegmentKind } from '@hushbox/shared';

// Lazy-loaded so the markdown stack (streamdown, shiki, mermaid, katex) stays
// out of the boot graph. The Suspense fallback shows the text plain, so a
// streaming message paints at once while the chunk loads.
const MarkdownRenderer = React.lazy(async () => {
  const m = await import('@/components/chat/message/markdown-renderer');
  return { default: m.MarkdownRenderer };
});

export interface SegmentRendererProps<K extends SegmentKind> {
  readonly node: SegmentByKind[K];
  readonly nodeKey: string;
  readonly context: SegmentRenderContext;
  /** The container the node sits in. */
  readonly parent: ContainerKind;
  /** Renders a container's children through the same dispatcher. */
  readonly renderChildren: (children: readonly Segment[], parent: ContainerKind) => React.ReactNode;
}

type SegmentRenderer<K extends SegmentKind> = (props: SegmentRendererProps<K>) => React.ReactNode;

export type SegmentRendererTable = { readonly [K in SegmentKind]: SegmentRenderer<K> };

function TextSegmentView({
  text,
  streaming,
  inReasoning,
}: Readonly<{ text: string; streaming: boolean; inReasoning: boolean }>): React.JSX.Element {
  return (
    <React.Suspense
      fallback={
        <p
          className={cn(
            'break-words whitespace-pre-wrap',
            !inReasoning && 'text-base leading-relaxed'
          )}
        >
          {text}
        </p>
      }
    >
      <MarkdownRenderer
        content={text}
        isStreaming={streaming}
        // A long fence inside reasoning is the model thinking aloud; minting a
        // runnable document from it would put a card inside the trace.
        {...(inReasoning && { extractDocuments: false })}
      />
    </React.Suspense>
  );
}

/**
 * The one table rendering dispatches through. A kind added to the segment tree
 * without a renderer here fails to compile, and a container renders its
 * children only through `renderChildren`, so a new kind nests anywhere its
 * spec allows with no change to any container.
 */
export const SEGMENT_RENDERERS: SegmentRendererTable = {
  text: ({ node, nodeKey, context, parent }) => (
    <TextSegmentView
      text={node.text}
      streaming={context.streamingTextKey === nodeKey}
      inReasoning={parent === 'reasoning'}
    />
  ),
  reasoning: ({ node, nodeKey, context, renderChildren }) => (
    <ThinkingDisclosure node={node} nodeKey={nodeKey} context={context}>
      {renderChildren(node.children, 'reasoning')}
    </ThinkingDisclosure>
  ),
  webSearch: ({ node, nodeKey, context, parent }) => (
    <WebSearchRow node={node} nodeKey={nodeKey} context={context} nested={parent !== 'root'} />
  ),
};
