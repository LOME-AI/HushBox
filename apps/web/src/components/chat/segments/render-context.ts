import { messageRowPages } from '@/components/chat/segments/web-search-sources';
import type { RowPages } from '@/components/chat/segments/web-search-sources';
import type {
  ResolvedReasoningEffort,
  Segment,
  WebSearchRow,
  WebSearchSegment,
} from '@hushbox/shared';

/** What the renderers need to know about the message beyond its segment tree. */
export interface MessageRenderFacts {
  /** Keys the reader's view state, which must outlive the live-to-stored swap. */
  readonly messageId: string;
  readonly isStreaming: boolean;
  /** The name to say while the model works; absent where none is known, as on a share. */
  readonly modelName: string | undefined;
  /** Billing metadata beside the text, never inside it. */
  readonly reasoningTokens: number | undefined;
  readonly reasoningEffort: ResolvedReasoningEffort | undefined;
}

/**
 * Everything the renderers derive from the whole message, computed once per
 * message by one pre-order walk so that no renderer re-walks the tree.
 */
export interface SegmentRenderContext extends MessageRenderFacts {
  /**
   * A node's key: its kind and its ordinal among that kind in pre-order. A tree
   * only ever grows at its end, so a node keeps its key as the message streams,
   * and a live tile and its stored message give the same node the same key.
   */
  keyOf(node: Segment): string;
  /** The pages of the search row with this key, counted once per message. */
  rowPages(key: string): RowPages;
  /** The reasoning span still receiving content: the root's last child of a streaming message. */
  readonly liveReasoningKey: string | undefined;
  /** The message's first reasoning span, the only one that names the effort. */
  readonly firstReasoningKey: string | undefined;
  /** Whether the root holds any answer text. */
  readonly hasAnswer: boolean;
  /** The text still streaming: the message's last node in pre-order, when it is text. */
  readonly streamingTextKey: string | undefined;
  /** The root row after which the still-working cue shows: a settled row ending a streaming message. */
  readonly workingAfterKey: string | undefined;
}

interface Walk {
  readonly keys: Map<Segment, string>;
  readonly rowKeys: string[];
  readonly rows: WebSearchRow[];
  readonly ordinals: Map<string, number>;
  last: Segment | undefined;
}

function visit(nodes: readonly Segment[], walk: Walk): void {
  for (const node of nodes) {
    const ordinal = walk.ordinals.get(node.kind) ?? 0;
    walk.ordinals.set(node.kind, ordinal + 1);
    const key = `${node.kind}:${String(ordinal)}`;
    walk.keys.set(node, key);
    walk.last = node;
    if (node.kind === 'webSearch') {
      walk.rowKeys.push(key);
      walk.rows.push(node.row);
    }
    if (node.kind === 'reasoning') visit(node.children, walk);
  }
}

function isSettledRow(node: Segment | undefined): node is WebSearchSegment {
  return (
    node?.kind === 'webSearch' && node.row.searches.every((entry) => entry.status !== 'searching')
  );
}

type StreamingKeys = Pick<
  SegmentRenderContext,
  'liveReasoningKey' | 'streamingTextKey' | 'workingAfterKey'
>;

/** Which nodes are still live: only the end of a streaming message ever is. */
function streamingKeys(
  tree: readonly Segment[],
  last: Segment | undefined,
  keyOf: (node: Segment) => string
): StreamingKeys {
  const rootLast = tree.at(-1);
  return {
    liveReasoningKey: rootLast?.kind === 'reasoning' ? keyOf(rootLast) : undefined,
    streamingTextKey: last?.kind === 'text' ? keyOf(last) : undefined,
    workingAfterKey: isSettledRow(rootLast) ? keyOf(rootLast) : undefined,
  };
}

const SETTLED_KEYS: StreamingKeys = {
  liveReasoningKey: undefined,
  streamingTextKey: undefined,
  workingAfterKey: undefined,
};

export function buildRenderContext(
  tree: readonly Segment[],
  facts: MessageRenderFacts
): SegmentRenderContext {
  const walk: Walk = {
    keys: new Map(),
    rowKeys: [],
    rows: [],
    ordinals: new Map(),
    last: undefined,
  };
  visit(tree, walk);
  const pagesByKey = new Map<string, RowPages>();
  for (const [index, pages] of messageRowPages(walk.rows).entries()) {
    const key = walk.rowKeys[index];
    /* v8 ignore next -- rows and their keys are collected together, one key per row */
    if (key !== undefined) pagesByKey.set(key, pages);
  }
  const keyOf = (node: Segment): string => {
    const key = walk.keys.get(node);
    if (key === undefined) throw new Error('the node is not part of this message');
    return key;
  };
  const firstReasoning = tree.find((node) => node.kind === 'reasoning');
  return {
    ...facts,
    keyOf,
    rowPages(key) {
      const pages = pagesByKey.get(key);
      if (pages === undefined) throw new Error('the key names no search row in this message');
      return pages;
    },
    firstReasoningKey: firstReasoning === undefined ? undefined : keyOf(firstReasoning),
    hasAnswer: tree.some((node) => node.kind === 'text' && node.text !== ''),
    ...(facts.isStreaming ? streamingKeys(tree, walk.last, keyOf) : SETTLED_KEYS),
  };
}
