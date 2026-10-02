import { z } from 'zod';
import { TOOL_CALL_CAP_MAX } from '../affordability/tool-loop.ts';
import { assertNever } from '../utils/assert-never.ts';
import { WEB_SEARCH_TOOL_NAME } from '../web-search/web-search-contract.ts';
import {
  WEB_SEARCH_ROW_MAX_CHARS,
  WebSearchSource,
  storedSearchQuery,
} from '../web-search/web-search-row.ts';
import {
  ASSISTANT_FRAMING_MAX_CHARS,
  FRAME_HEADER_MAX_CHARS,
  MESSAGE_MARKER_CHARS,
  SEGMENT_TEXT_SEPARATOR,
  afterThinkClose,
  leadingThinkOpen,
  serializeSegments,
  splitAtThinkClose,
} from './grammar.ts';
import type { HeldThinkOpen } from './grammar.ts';
import type { ReasoningSegment, Segment, WebSearchSegment } from './segments.ts';
import type { WebSearchEntry, WebSearchRow } from '../web-search/web-search-row.ts';
import type { ToolErrorReason } from '../workflow/inference.ts';
import type { WireInferenceEvent } from '../workflow/wire-inference-event.ts';

/**
 * The single definition of how an assistant message's segment tree is built from
 * its inference events. Whatever builds that tree, stored or live, builds it
 * through this reducer, so the stored and the live text cannot diverge.
 *
 * Placement is positional over the stream: reasoning opens or continues a span
 * at the end of the root, answer text closes it, a search call joins whichever
 * container is open, back-to-back searches with nothing between form one row,
 * and a step boundary closes nothing.
 */

/** Frames per message before new content joins the latest frame of its own kind. */
export const ASSISTANT_FRAME_LIMIT = 48;

/**
 * Past the limit, content with no same-kind frame to join still opens one, so
 * nothing is ever lost. The limit's worth of frames cannot be built from fewer
 * than two of root text, reasoning span and search row, so at most one kind is
 * missing, and the costliest to open is a span with its text: at most two
 * frames open past the limit.
 */
const FALLBACK_FRAME_MAX = 2;

/** The most frames a message can hold: the limit plus the fallback frames. */
export const ASSISTANT_FRAME_CEILING = ASSISTANT_FRAME_LIMIT + FALLBACK_FRAME_MAX;

/** Step separators per message; later steps' text joins without one. */
export const ASSISTANT_SEPARATOR_LIMIT = Math.floor(
  (ASSISTANT_FRAMING_MAX_CHARS -
    MESSAGE_MARKER_CHARS -
    ASSISTANT_FRAME_CEILING * FRAME_HEADER_MAX_CHARS) /
    SEGMENT_TEXT_SEPARATOR.length
);

/** A root child, or a child of the reasoning span at that root index. */
type TreePath = readonly [number] | readonly [number, number];

interface EntryLocation {
  readonly row: TreePath;
  readonly entry: number;
}

/**
 * How the message's first answer text is being read for a natively emitted
 * think block: undecided (`before`), inside the block, just past its close
 * tag, or ordinary answer text. `held` is text a later delta must decide.
 */
type NativeThink =
  | { readonly phase: 'before'; readonly held: HeldThinkOpen }
  | { readonly phase: 'inside'; readonly held: string }
  | { readonly phase: 'closing'; readonly held: string }
  | { readonly phase: 'answer' };

export interface AssistantStreamState {
  readonly tree: readonly Segment[];
  /** True while the root's last child is a reasoning span still receiving reasoning. */
  readonly reasoningOpen: boolean;
  readonly step: number;
  readonly frameCount: number;
  readonly separatorCount: number;
  /** Search entries the tree holds, capped at {@link TOOL_CALL_CAP_MAX}. */
  readonly entryCount: number;
  /** The step each text frame last received text in, keyed by its path. */
  readonly textSteps: ReadonlyMap<string, number>;
  /** Where each tool call's search entry lives, keyed by call id. */
  readonly entries: ReadonlyMap<string, EntryLocation>;
  readonly native: NativeThink;
}

export interface SerializedAssistantStream {
  readonly text: string;
  /** Sources dropped, last row first, so every row fits {@link WEB_SEARCH_ROW_MAX_CHARS}. */
  readonly droppedSourceCount: number;
}

export function createAssistantStream(): AssistantStreamState {
  return {
    tree: [],
    reasoningOpen: false,
    step: 0,
    frameCount: 0,
    separatorCount: 0,
    entryCount: 0,
    textSteps: new Map(),
    entries: new Map(),
    native: { phase: 'before', held: { whitespace: '', tag: '' } },
  };
}

const EMPTY_ROW: WebSearchRow = { v: 1, searches: [], notRun: { limit: 0, invalidQuery: 0 } };

const pathKey = (path: TreePath): string => path.join('.');

function nodeAt(tree: readonly Segment[], path: TreePath): Segment | undefined {
  const top = tree[path[0]];
  if (path.length === 1 || top?.kind !== 'reasoning') return top;
  return top.children[path[1]];
}

function replaceAt(tree: readonly Segment[], path: TreePath, node: Segment): readonly Segment[] {
  const next = [...tree];
  if (path.length === 1) {
    next[path[0]] = node;
    return next;
  }
  const span = tree[path[0]] as ReasoningSegment;
  const children = [...span.children];
  children[path[1]] = node;
  next[path[0]] = { kind: 'reasoning', children };
  return next;
}

/** `root`, or the root index of a reasoning span. */
type Container = 'root' | number;

function childrenOf(tree: readonly Segment[], container: Container): readonly Segment[] {
  if (container === 'root') return tree;
  return (tree[container] as ReasoningSegment).children;
}

function pathIn(container: Container, index: number): TreePath {
  return container === 'root' ? [index] : [container, index];
}

function appendChild(
  s: AssistantStreamState,
  container: Container,
  node: Segment
): { readonly state: AssistantStreamState; readonly path: TreePath } {
  const children = childrenOf(s.tree, container);
  const path = pathIn(container, children.length);
  const tree =
    container === 'root'
      ? [...s.tree, node]
      : replaceAt(s.tree, [container], { kind: 'reasoning', children: [...children, node] });
  return { state: { ...s, tree, frameCount: s.frameCount + 1 }, path };
}

function canOpen(s: AssistantStreamState, frames: number): boolean {
  return s.frameCount + frames <= ASSISTANT_FRAME_LIMIT;
}

function latestIndexOf(children: readonly Segment[], kind: Segment['kind']): number | undefined {
  for (let index = children.length - 1; index >= 0; index -= 1) {
    if (children[index]?.kind === kind) return index;
  }
  return undefined;
}

function withTextStep(s: AssistantStreamState, path: TreePath): AssistantStreamState {
  const key = pathKey(path);
  if (s.textSteps.get(key) === s.step) return s;
  return { ...s, textSteps: new Map(s.textSteps).set(key, s.step) };
}

function appendText(
  s: AssistantStreamState,
  container: Container,
  text: string
): AssistantStreamState {
  const children = childrenOf(s.tree, container);
  const last = children.length - 1;
  let target: number | undefined = children[last]?.kind === 'text' ? last : undefined;
  if (target === undefined && !canOpen(s, 1)) target = latestIndexOf(children, 'text');
  if (target === undefined) {
    const opened = appendChild(s, container, { kind: 'text', text });
    return withTextStep(opened.state, opened.path);
  }
  const path = pathIn(container, target);
  const previousStep = s.textSteps.get(pathKey(path));
  const separate =
    previousStep !== undefined &&
    previousStep !== s.step &&
    s.separatorCount < ASSISTANT_SEPARATOR_LIMIT;
  const node = nodeAt(s.tree, path) as { readonly kind: 'text'; readonly text: string };
  const appended = separate
    ? `${node.text}${SEGMENT_TEXT_SEPARATOR}${text}`
    : `${node.text}${text}`;
  const next: AssistantStreamState = {
    ...s,
    tree: replaceAt(s.tree, path, { kind: 'text', text: appended }),
    separatorCount: separate ? s.separatorCount + 1 : s.separatorCount,
  };
  return withTextStep(next, path);
}

function appendReasoning(s: AssistantStreamState, text: string): AssistantStreamState {
  if (text === '') return s;
  if (s.reasoningOpen) return appendText(s, s.tree.length - 1, text);
  const latestSpan = canOpen(s, 2) ? undefined : latestIndexOf(s.tree, 'reasoning');
  if (latestSpan !== undefined) return appendText(s, latestSpan, text);
  const opened = appendChild(s, 'root', { kind: 'reasoning', children: [] });
  const withSpan = appendText({ ...opened.state, reasoningOpen: true }, opened.path[0], text);
  return withSpan;
}

function appendAnswer(s: AssistantStreamState, text: string): AssistantStreamState {
  if (text === '') return s;
  return appendText({ ...s, reasoningOpen: false }, 'root', text);
}

/**
 * The native open tag opens a reasoning span as soon as it is read, before any
 * reasoning character, so a search made right after it nests there. Streamed
 * reasoning still open is that span already; with no room for a span and its
 * text, the block's reasoning joins the latest span as any reasoning past the
 * limit does.
 */
function openNativeSpan(s: AssistantStreamState): AssistantStreamState {
  if (s.reasoningOpen || !canOpen(s, 2)) return s;
  const opened = appendChild(s, 'root', { kind: 'reasoning', children: [] });
  return { ...opened.state, reasoningOpen: true };
}

function readInside(s: AssistantStreamState, text: string): AssistantStreamState {
  const split = splitAtThinkClose(text);
  const withReasoning = appendReasoning(s, split.reasoning);
  if (split.state === 'open')
    return { ...withReasoning, native: { phase: 'inside', held: split.held } };
  // The close tag ends the span whether or not answer text follows it.
  return readClosing(
    { ...withReasoning, reasoningOpen: false, native: { phase: 'closing', held: '' } },
    split.rest
  );
}

function readClosing(s: AssistantStreamState, text: string): AssistantStreamState {
  const after = afterThinkClose(text);
  if (after.state === 'undecided') return { ...s, native: { phase: 'closing', held: text } };
  return appendAnswer({ ...s, native: { phase: 'answer' } }, after.answer);
}

function reduceTextDelta(s: AssistantStreamState, content: string): AssistantStreamState {
  const native = s.native;
  switch (native.phase) {
    case 'answer': {
      return appendAnswer(s, content);
    }
    case 'before': {
      const open = leadingThinkOpen(native.held, content);
      if (open.state === 'undecided') return { ...s, native: { phase: 'before', held: open.held } };
      if (open.state === 'absent') {
        return appendAnswer({ ...s, native: { phase: 'answer' } }, open.text);
      }
      return readInside(openNativeSpan({ ...s, native: { phase: 'inside', held: '' } }), open.rest);
    }
    case 'inside': {
      return readInside(s, `${native.held}${content}`);
    }
    case 'closing': {
      return readClosing(s, `${native.held}${content}`);
    }
    default: {
      return assertNever(native);
    }
  }
}

/** The row the next search joins, opening one when none can be joined. */
function rowForCall(s: AssistantStreamState): {
  readonly state: AssistantStreamState;
  readonly path: TreePath;
} {
  const container: Container = s.reasoningOpen ? s.tree.length - 1 : 'root';
  const children = childrenOf(s.tree, container);
  if (children.at(-1)?.kind === 'webSearch') {
    return { state: s, path: pathIn(container, children.length - 1) };
  }
  if (!canOpen(s, 1)) {
    const latest = latestRowPath(s.tree);
    if (latest !== undefined) return { state: s, path: latest };
  }
  return appendChild(s, container, { kind: 'webSearch', row: EMPTY_ROW });
}

/** The last search row in document order, at any depth. */
function latestRowPath(tree: readonly Segment[]): TreePath | undefined {
  for (let index = tree.length - 1; index >= 0; index -= 1) {
    const node = tree[index];
    if (node?.kind === 'webSearch') return [index];
    if (node?.kind === 'reasoning') {
      const child = latestIndexOf(node.children, 'webSearch');
      if (child !== undefined) return [index, child];
    }
  }
  return undefined;
}

function rowAt(tree: readonly Segment[], path: TreePath): WebSearchRow {
  return (nodeAt(tree, path) as WebSearchSegment).row;
}

function withRow(s: AssistantStreamState, path: TreePath, row: WebSearchRow): AssistantStreamState {
  return { ...s, tree: replaceAt(s.tree, path, { kind: 'webSearch', row }) };
}

function queryOf(args: unknown): string {
  const parsed = z.object({ query: z.string() }).safeParse(args);
  return storedSearchQuery(parsed.success ? parsed.data.query : '');
}

/**
 * A search call joins the open container's row as a new entry, up to the
 * per-message cap the node's dispatch cap also enforces. A call past the cap is
 * counted as not run on that row, and anything later for its id is ignored.
 * Every copy here is bounded by the cap, so a call costs a constant.
 */
function reduceToolCall(s: AssistantStreamState, id: string, args: unknown): AssistantStreamState {
  const { state, path } = rowForCall(s);
  const row = rowAt(state.tree, path);
  if (state.entryCount >= TOOL_CALL_CAP_MAX) {
    const notRun = { ...row.notRun, limit: row.notRun.limit + 1 };
    const counted = withRow(state, path, { ...row, notRun });
    if (!counted.entries.has(id)) return counted;
    const entries = new Map(counted.entries);
    entries.delete(id);
    return { ...counted, entries };
  }
  const entry: WebSearchEntry = { query: queryOf(args), status: 'searching' };
  const next = withRow(state, path, { ...row, searches: [...row.searches, entry] });
  return {
    ...next,
    entryCount: next.entryCount + 1,
    entries: new Map(next.entries).set(id, { row: path, entry: row.searches.length }),
  };
}

const ResultsShape = z.object({ results: z.array(z.unknown()) });

/** The pages a search result found: each result's title and http(s) URL. */
function sourcesOf(result: unknown): WebSearchSource[] {
  const parsed = ResultsShape.safeParse(result);
  if (!parsed.success) return [];
  return parsed.data.results.flatMap((item) => {
    const source = WebSearchSource.safeParse(item);
    return source.success ? [source.data] : [];
  });
}

/** The entry a result or error attaches to: the latest call with that id, still searching. */
function searchingEntry(
  s: AssistantStreamState,
  id: string
): { readonly location: EntryLocation; readonly row: WebSearchRow } | undefined {
  const location = s.entries.get(id);
  if (location === undefined) return undefined;
  const row = rowAt(s.tree, location.row);
  return row.searches[location.entry]?.status === 'searching' ? { location, row } : undefined;
}

function reduceToolResult(
  s: AssistantStreamState,
  id: string,
  result: unknown
): AssistantStreamState {
  const found = searchingEntry(s, id);
  if (found === undefined) return s;
  const { location, row } = found;
  const searches = row.searches.map((entry, index) =>
    index === location.entry
      ? { ...entry, status: 'done' as const, sources: sourcesOf(result) }
      : entry
  );
  return withRow(s, location.row, { ...row, searches });
}

function reduceToolError(
  s: AssistantStreamState,
  id: string,
  reason: ToolErrorReason
): AssistantStreamState {
  const found = searchingEntry(s, id);
  if (found === undefined) return s;
  const { location, row } = found;
  if (reason === 'failed') {
    const searches = row.searches.map((entry, index) =>
      index === location.entry ? { ...entry, status: 'failed' as const } : entry
    );
    return withRow(s, location.row, { ...row, searches });
  }
  // A call that never ran leaves the row's entries and is counted instead.
  const notRun =
    reason === 'limit'
      ? { ...row.notRun, limit: row.notRun.limit + 1 }
      : { ...row.notRun, invalidQuery: row.notRun.invalidQuery + 1 };
  const searches = row.searches.filter((_entry, index) => index !== location.entry);
  const rowKey = pathKey(location.row);
  const entries = new Map<string, EntryLocation>();
  for (const [callId, other] of s.entries) {
    if (callId === id) continue;
    const shifted = pathKey(other.row) === rowKey && other.entry > location.entry;
    entries.set(callId, shifted ? { row: other.row, entry: other.entry - 1 } : other);
  }
  return {
    ...withRow(s, location.row, { ...row, searches, notRun }),
    entries,
    entryCount: s.entryCount - 1,
  };
}

/** Events that change no content: the tree never reads them. */
const CONTENTLESS_KINDS = [
  'stream-start',
  'step-finish',
  'media-start',
  'media-done',
  'media-progress',
  'finish',
] as const satisfies readonly WireInferenceEvent['kind'][];

type ContentEvent = Exclude<WireInferenceEvent, { kind: (typeof CONTENTLESS_KINDS)[number] }>;

function carriesContent(e: WireInferenceEvent): e is ContentEvent {
  return !(CONTENTLESS_KINDS as readonly string[]).includes(e.kind);
}

/**
 * Text held back for a later text delta to decide (leading whitespace, a prefix
 * of the open tag, or a newline after the close tag) is answer text once any
 * other event arrives, so whatever that event adds lands after it.
 */
function resolveHeldText(s: AssistantStreamState): AssistantStreamState {
  const native = s.native;
  const answered: AssistantStreamState = { ...s, native: { phase: 'answer' } };
  if (native.phase === 'closing') return appendAnswer(answered, native.held);
  if (native.phase !== 'before') return s;
  const held = `${native.held.whitespace}${native.held.tag}`;
  return held === '' ? s : appendAnswer(answered, held);
}

function reduceContentEvent(
  s: AssistantStreamState,
  e: Exclude<ContentEvent, { kind: 'text-delta' }>
): AssistantStreamState {
  switch (e.kind) {
    case 'reasoning-delta': {
      return appendReasoning(s, e.content);
    }
    case 'step-start': {
      return { ...s, step: e.step };
    }
    case 'tool-call': {
      return e.name === WEB_SEARCH_TOOL_NAME ? reduceToolCall(s, e.id, e.args) : s;
    }
    case 'tool-result': {
      return reduceToolResult(s, e.id, e.result);
    }
    case 'tool-error': {
      return reduceToolError(s, e.id, e.reason);
    }
    default: {
      return assertNever(e);
    }
  }
}

export function reduceAssistantStream(
  s: AssistantStreamState,
  e: WireInferenceEvent
): AssistantStreamState {
  if (e.kind === 'text-delta') return reduceTextDelta(s, e.content);
  const resolved = resolveHeldText(s);
  return carriesContent(e) ? reduceContentEvent(resolved, e) : resolved;
}

function interruptRow(row: WebSearchRow): WebSearchRow {
  if (!row.searches.some((entry) => entry.status === 'searching')) return row;
  return {
    ...row,
    searches: row.searches.map((entry) =>
      entry.status === 'searching' ? { ...entry, status: 'interrupted' as const } : entry
    ),
  };
}

function interruptSegment(node: Segment): Segment {
  if (node.kind === 'webSearch') {
    const row = interruptRow(node.row);
    return row === node.row ? node : { kind: 'webSearch', row };
  }
  if (node.kind === 'reasoning') {
    const children = node.children.map((child) => interruptSegment(child));
    return children.every((child, index) => child === node.children[index])
      ? node
      : { kind: 'reasoning', children };
  }
  return node;
}

function flushNative(s: AssistantStreamState): AssistantStreamState {
  if (s.native.phase !== 'inside') return resolveHeldText(s);
  // An unclosed block: everything after the open tag is reasoning.
  return appendReasoning({ ...s, native: { phase: 'answer' } }, s.native.held);
}

/**
 * The stream's final state: text a later delta would have decided is decided
 * as if the stream ended, and every search still running is interrupted.
 */
export function settleAssistantStream(s: AssistantStreamState): AssistantStreamState {
  const flushed = flushNative(s);
  const tree = flushed.tree.map((node) => interruptSegment(node));
  return tree.every((node, index) => node === flushed.tree[index]) ? flushed : { ...flushed, tree };
}

interface RowSlot {
  readonly path: TreePath;
  readonly row: WebSearchRow;
  readonly chars: number;
}

function rowSlots(tree: readonly Segment[]): RowSlot[] {
  const slots: RowSlot[] = [];
  const add = (node: Segment | undefined, path: TreePath): void => {
    if (node?.kind === 'webSearch') {
      slots.push({ path, row: node.row, chars: JSON.stringify(node.row).length });
    }
  };
  for (const [index, node] of tree.entries()) {
    add(node, [index]);
    if (node.kind !== 'reasoning') continue;
    for (const [childIndex, child] of node.children.entries()) add(child, [index, childIndex]);
  }
  return slots;
}

interface TrimmedRow {
  readonly row: WebSearchRow;
  /** Characters the row's JSON lost. */
  readonly removed: number;
  readonly dropped: number;
}

/**
 * The row with its last sources removed, last search first, until `excess`
 * characters are gone or none remain. Each removal subtracts that source's own
 * JSON and the comma before it, so the cost is linear in what is dropped rather
 * than a re-serialization of the row per source.
 */
function trimRow(row: WebSearchRow, excess: number): TrimmedRow {
  const kept = row.searches.map((entry) => entry.sources?.length ?? 0);
  let removed = 0;
  let dropped = 0;
  for (let index = row.searches.length - 1; index >= 0 && removed < excess; index -= 1) {
    const sources = row.searches[index]?.sources ?? [];
    let count = kept[index] ?? 0;
    while (count > 0 && removed < excess) {
      // Every element after an array's first carries the comma before it.
      removed += JSON.stringify(sources[count - 1]).length + (count > 1 ? 1 : 0);
      count -= 1;
      dropped += 1;
    }
    kept[index] = count;
  }
  if (dropped === 0) return { row, removed, dropped };
  const searches = row.searches.map((entry, index) => {
    const count = kept[index] ?? 0;
    if (entry.sources === undefined || count === entry.sources.length) return entry;
    return { ...entry, sources: entry.sources.slice(0, count) };
  });
  return { row: { ...row, searches }, removed, dropped };
}

/**
 * The state's text in the one grammar. Held-back text a later delta would
 * decide is not part of it yet. When the rows together exceed their storage
 * allowance, sources are dropped from the last row backwards until they fit,
 * and the count is reported so the caller can capture it.
 */
export function serializeAssistantStream(s: AssistantStreamState): SerializedAssistantStream {
  const slots = rowSlots(s.tree);
  let total = 0;
  for (const slot of slots) total += slot.chars;
  let droppedSourceCount = 0;
  let tree = s.tree;
  for (const slot of slots.toReversed()) {
    const trimmed = trimRow(slot.row, total - WEB_SEARCH_ROW_MAX_CHARS);
    if (trimmed.dropped === 0) continue;
    total -= trimmed.removed;
    droppedSourceCount += trimmed.dropped;
    tree = replaceAt(tree, slot.path, { kind: 'webSearch', row: trimmed.row });
  }
  return { text: serializeSegments(tree), droppedSourceCount };
}
