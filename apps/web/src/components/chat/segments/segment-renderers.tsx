import * as React from 'react';
import { cn } from '@hushbox/ui';
import { ThinkingDisclosure } from '@/components/chat/message/thinking-disclosure';
import { WebSearchRow } from '@/components/chat/segments/web-search-row';
import type { SegmentRenderContext } from '@/components/chat/segments/render-context';
import type { ContainerKind, Segment, SegmentByKind, SegmentKind } from '@hushbox/shared';

type MarkdownRendererComponent =
  typeof import('@/components/chat/message/markdown-renderer').MarkdownRenderer;

let markdownRendererLoad: Promise<MarkdownRendererComponent> | undefined;
let loadedMarkdownRenderer: MarkdownRendererComponent | undefined;
let markdownRendererSettled = false;
const settledListeners = new Set<() => void>();

async function importMarkdownRenderer(): Promise<MarkdownRendererComponent> {
  try {
    const m = await import('@/components/chat/message/markdown-renderer');
    loadedMarkdownRenderer = m.MarkdownRenderer;
    return m.MarkdownRenderer;
  } finally {
    // A failed load counts as settled: the lazy renderer rethrows it to the row's error
    // boundary, and a reader waiting on readiness must not wait forever.
    markdownRendererSettled = true;
    for (const listener of settledListeners) listener();
  }
}

/**
 * Loads the markdown stack (streamdown, shiki, mermaid, katex), kept out of the boot graph, once
 * per page: the lazy renderer and every readiness reader share this one import.
 */
export function loadMarkdownRenderer(): Promise<MarkdownRendererComponent> {
  markdownRendererLoad ??= importMarkdownRenderer();
  return markdownRendererLoad;
}

// Started as this module loads, so the renderer is usually ready by the time a thread has been
// decrypted. It is never imported statically or at route entry: either would compete with the
// page's own first bytes.
void loadMarkdownRenderer();

function subscribeToMarkdownRenderer(listener: () => void): () => void {
  settledListeners.add(listener);
  void loadMarkdownRenderer();
  return () => {
    settledListeners.delete(listener);
  };
}

function markdownRendererReady(): boolean {
  return markdownRendererSettled;
}

/** Whether the markdown renderer's module has settled; asking starts its load. */
export function useMarkdownRendererReady(): boolean {
  return React.useSyncExternalStore(subscribeToMarkdownRenderer, markdownRendererReady);
}

// The Suspense fallback shows the text plain, so a reply that streams before the
// chunk lands paints at once.
const MarkdownRenderer = React.lazy(async () => ({ default: await loadMarkdownRenderer() }));

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
  // A lazy component suspends on its first render even when its module has loaded, and React
  // can hold the swap from fallback to content back by a few hundred milliseconds, so a segment
  // mounted after the load renders the loaded component directly. Read once at mount: a segment
  // keeps its path, so its renderer never remounts mid-stream.
  const [Loaded] = React.useState(() => loadedMarkdownRenderer);
  const Renderer = Loaded ?? MarkdownRenderer;
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
      <Renderer
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
