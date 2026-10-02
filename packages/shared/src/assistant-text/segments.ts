import { WEB_SEARCH_ROW_MAX_CHARS, WebSearchRow } from '../web-search/web-search-row.ts';

/**
 * The segment tree an assistant message's raw text encodes. Every piece of an
 * assistant message's UI derives from this tree, and the tree derives from the
 * text through the one grammar.
 *
 * Kinds compose through {@link SEGMENT_SPECS}: a container handles its children
 * only through the table, so a new kind nests anywhere its `parents` allow with
 * no change to any container. Adding a kind to {@link SEGMENT_KINDS} without a
 * {@link SegmentByKind} entry and a spec fails to compile.
 */

export const SEGMENT_KINDS = ['text', 'reasoning', 'webSearch'] as const;
export type SegmentKind = (typeof SEGMENT_KINDS)[number];

/** Where a segment can sit: the message's root (the answer) or a reasoning span. */
export type ContainerKind = 'root' | 'reasoning';

export interface TextSegment {
  readonly kind: 'text';
  readonly text: string;
}

export interface ReasoningSegment {
  readonly kind: 'reasoning';
  readonly children: readonly Segment[];
}

export interface WebSearchSegment {
  readonly kind: 'webSearch';
  readonly row: WebSearchRow;
}

export interface SegmentByKind {
  readonly text: TextSegment;
  readonly reasoning: ReasoningSegment;
  readonly webSearch: WebSearchSegment;
}

export type Segment = SegmentByKind[SegmentKind];

type ChildrenEncoder = (children: readonly Segment[], parent: ContainerKind) => string;
type ChildrenDecoder = (body: string, parent: ContainerKind) => readonly Segment[] | undefined;
type ChildrenProjector = (children: readonly Segment[]) => string;

export interface SegmentSpec<K extends SegmentKind> {
  /** The one-character wire code the frame header carries. */
  readonly code: string;
  readonly parents: readonly ContainerKind[];
  readonly encodeBody: (node: SegmentByKind[K], encodeChildren: ChildrenEncoder) => string;
  /** `undefined` refuses the body, which makes the whole message malformed. */
  readonly decodeBody: (
    body: string,
    decodeChildren: ChildrenDecoder
  ) => SegmentByKind[K] | undefined;
  /** What this segment contributes to history resent to a model. */
  readonly toHistory: (node: SegmentByKind[K], childrenToHistory: ChildrenProjector) => string;
  /**
   * HushBox-authored characters this kind's bodies may add to one message,
   * beyond the framing every kind shares. Model text is covered by the output
   * ceiling, so it is zero for text.
   */
  readonly storageAllowanceChars: number;
}

export type SegmentSpecTable = { readonly [K in SegmentKind]: SegmentSpec<K> };

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

export const SEGMENT_SPECS: SegmentSpecTable = {
  text: {
    code: 't',
    parents: ['root', 'reasoning'],
    encodeBody: (node) => node.text,
    decodeBody: (body) => ({ kind: 'text', text: body }),
    toHistory: (node) => node.text,
    storageAllowanceChars: 0,
  },
  reasoning: {
    code: 'r',
    parents: ['root'],
    encodeBody: (node, encodeChildren) => encodeChildren(node.children, 'reasoning'),
    decodeBody: (body, decodeChildren) => {
      const children = decodeChildren(body, 'reasoning');
      return children === undefined ? undefined : { kind: 'reasoning', children };
    },
    // Reasoning never reaches a model: feeding thoughts back changes model
    // behaviour and cost. Dropping the span drops everything nested in it.
    toHistory: () => '',
    storageAllowanceChars: 0,
  },
  webSearch: {
    code: 's',
    parents: ['root', 'reasoning'],
    encodeBody: (node) => JSON.stringify(node.row),
    decodeBody: (body) => {
      const parsed = WebSearchRow.safeParse(parseJson(body));
      return parsed.success ? { kind: 'webSearch', row: parsed.data } : undefined;
    },
    // Presentation data: resending it would add input no reservation covers.
    toHistory: () => '',
    storageAllowanceChars: WEB_SEARCH_ROW_MAX_CHARS,
  },
};
