import * as React from 'react';
import { markdownContinuation } from '@/lib/chat/markdown-continuation';
import { SEGMENT_RENDERERS } from '@/components/chat/segments/segment-renderers';
import type { SegmentRendererProps } from '@/components/chat/segments/segment-renderers';
import type { SegmentRenderContext } from '@/components/chat/segments/render-context';
import type { ContainerKind, Segment, SegmentKind } from '@hushbox/shared';

interface SegmentListProps {
  readonly nodes: readonly Segment[];
  readonly context: SegmentRenderContext;
  readonly parent: ContainerKind;
}

/** Spacing around a block, by the container it sits in; text carries its own. */
const BLOCK_SPACING: Record<ContainerKind, string> = {
  root: 'mt-3 mb-1.5 first:mt-0 first:mb-2.5 last:mb-0',
  reasoning: 'mt-2 mb-1 first:mt-0 last:mb-0',
};

function renderNode<K extends SegmentKind>(
  kind: K,
  props: SegmentRendererProps<K>
): React.ReactNode {
  return SEGMENT_RENDERERS[kind](props);
}

/**
 * Each node's text as rendered: a text sibling that follows a block (a row, a
 * span) reopens whatever code block, table or numbered list the text before
 * that block left open, and the text before closes it. Render only; the raw
 * text is untouched.
 */
function renderedTexts(nodes: readonly Segment[]): readonly (string | undefined)[] {
  const texts = nodes.map((node) => (node.kind === 'text' ? node.text : undefined));
  let previous: { readonly index: number; readonly text: string } | undefined;
  for (const [index, node] of nodes.entries()) {
    if (node.kind !== 'text') continue;
    let text = node.text;
    if (previous !== undefined && index > previous.index + 1) {
      const continued = markdownContinuation(previous.text, text);
      texts[previous.index] = continued.before;
      text = continued.after;
      texts[index] = text;
    }
    previous = { index, text };
  }
  return texts;
}

/**
 * The dispatcher: renders a container's children in text order, each through
 * its kind's renderer. Every block (anything but text) carries
 * `aria-live="off"`, so a block inserted into a streaming answer is not read
 * out through the answer's live region.
 */
export function SegmentList({ nodes, context, parent }: SegmentListProps): React.JSX.Element {
  const texts = renderedTexts(nodes);
  const renderChildren = (
    children: readonly Segment[],
    container: ContainerKind
  ): React.ReactNode => <SegmentList nodes={children} context={context} parent={container} />;
  return (
    <>
      {nodes.map((node, index) => {
        const nodeKey = context.keyOf(node);
        const text = texts[index];
        const shown: Segment =
          node.kind === 'text' && text !== undefined ? { kind: 'text', text } : node;
        const element = renderNode(shown.kind, {
          node: shown,
          nodeKey,
          context,
          parent,
          renderChildren,
        });
        if (node.kind === 'text') return <React.Fragment key={nodeKey}>{element}</React.Fragment>;
        return (
          <div key={nodeKey} aria-live="off" className={BLOCK_SPACING[parent]}>
            {element}
          </div>
        );
      })}
    </>
  );
}
