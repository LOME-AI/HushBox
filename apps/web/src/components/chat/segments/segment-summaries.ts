import { searchFragment, searchLiveActivity } from '@/components/chat/segments/web-search-labels';
import type { SegmentRenderContext } from '@/components/chat/segments/render-context';
import type { Segment, SegmentByKind, SegmentKind } from '@hushbox/shared';

/**
 * What each kind contributes to the one-liner of the container it sits in. A
 * container composes over its children only through this table, so a new kind
 * rolls up into a reasoning one-liner by adding its entry here, and a kind
 * without an entry fails to compile.
 */
interface SegmentSummary<K extends SegmentKind> {
  /** The compact fragments a settled one-liner appends for every child of this kind. */
  readonly fragments: (
    nodes: readonly SegmentByKind[K][],
    context: SegmentRenderContext
  ) => readonly string[];
  /** What a live container says the model is doing while this child is active, if it is. */
  readonly liveActivity: (node: SegmentByKind[K]) => string | undefined;
}

export type SegmentSummaryTable = { readonly [K in SegmentKind]: SegmentSummary<K> };

const NONE: readonly string[] = [];

export const SEGMENT_SUMMARIES: SegmentSummaryTable = {
  text: { fragments: () => NONE, liveActivity: () => undefined },
  reasoning: { fragments: () => NONE, liveActivity: () => undefined },
  webSearch: {
    fragments: (nodes, context) =>
      searchFragment(
        nodes.map((node) => ({ row: node.row, pages: context.rowPages(context.keyOf(node)) }))
      ),
    liveActivity: (node) => searchLiveActivity(node.row),
  },
};

function childrenOfKind<K extends SegmentKind>(
  children: readonly Segment[],
  kind: K
): SegmentByKind[K][] {
  return children.filter((child): child is SegmentByKind[K] => child.kind === kind);
}

function fragmentsOf<K extends SegmentKind>(
  kind: K,
  nodes: readonly SegmentByKind[K][],
  context: SegmentRenderContext
): readonly string[] {
  return SEGMENT_SUMMARIES[kind].fragments(nodes, context);
}

function liveActivityOf<K extends SegmentKind>(
  kind: K,
  node: SegmentByKind[K]
): string | undefined {
  return SEGMENT_SUMMARIES[kind].liveActivity(node);
}

export interface ChildrenSummary {
  /** Each kind's fragments, kinds in the order they first appear among the children. */
  readonly fragments: readonly string[];
  /** The latest child's live activity, if any child is active. */
  readonly liveActivity: string | undefined;
}

export function summarizeChildren(
  children: readonly Segment[],
  context: SegmentRenderContext
): ChildrenSummary {
  const kinds = [...new Set(children.map((child) => child.kind))];
  const fragments = kinds.flatMap((kind) =>
    fragmentsOf(kind, childrenOfKind(children, kind), context)
  );
  let liveActivity: string | undefined;
  for (const child of children.toReversed()) {
    liveActivity = liveActivityOf(child.kind, child);
    if (liveActivity !== undefined) break;
  }
  return { fragments, liveActivity };
}
