import { SEGMENT_SPECS } from './segments.ts';
import { SEGMENT_TEXT_SEPARATOR, parseAssistantMessage, withoutLeadingMarker } from './grammar.ts';
import type { Segment, SegmentByKind, SegmentKind } from './segments.ts';
import type { WebSearchRow } from '../web-search/web-search-row.ts';

function joinNonEmpty(parts: readonly string[]): string {
  return parts.filter((part) => part !== '').join(SEGMENT_TEXT_SEPARATOR);
}

function historyOf<K extends SegmentKind>(kind: K, node: SegmentByKind[K]): string {
  return SEGMENT_SPECS[kind].toHistory(node, childrenToHistory);
}

function childrenToHistory(children: readonly Segment[]): string {
  return joinNonEmpty(children.map((child) => historyOf(child.kind, child)));
}

/**
 * What an assistant turn contributes to history resent to a model: each root
 * segment's own history projection, joined by the step separator so steps
 * never run together. Reasoning, with everything nested in it, and search rows
 * contribute nothing. The result never begins with the frame marker, so cleaning
 * a turn the client already cleaned changes nothing.
 */
export function assistantHistoryText(content: string): string {
  return withoutLeadingMarker(childrenToHistory(parseAssistantMessage(content)));
}

/** The answer a reader copies or hears: the root's answer text, joined by the step separator. */
export function assistantAnswerText(content: string): string {
  return joinNonEmpty(
    parseAssistantMessage(content).flatMap((node) => (node.kind === 'text' ? [node.text] : []))
  );
}

/** Every search row in document order (pre-order across every depth). */
export function webSearchRowsInOrder(segments: readonly Segment[]): readonly WebSearchRow[] {
  return segments.flatMap((node) => {
    if (node.kind === 'webSearch') return [node.row];
    if (node.kind === 'reasoning') return webSearchRowsInOrder(node.children);
    return [];
  });
}
