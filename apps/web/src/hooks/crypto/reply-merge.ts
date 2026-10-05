import type { ResolvedReasoningEffort } from '@hushbox/shared';
import type { Message, MessageMediaItem } from '@/lib/api/api';

/**
 * The display facts a stored reply records per content item. The member history
 * read and the public message share serve the same facts for the same item, and
 * both fold them into one reply through these functions, so a shared reply reads
 * as its author's thread draws it.
 */
export interface ReplyMergeItem {
  modelName: string | null;
  isSmartModel: boolean;
  reasoningTokens: number | null;
  reasoningEffort: ResolvedReasoningEffort | null;
  reasoningDurationMs: number | null;
}

/** A reply's text items, decrypted and in position order, as its one answer. */
export function joinTextParts(parts: readonly string[]): string {
  return parts.join('');
}

export function pickModelName(items: readonly Pick<ReplyMergeItem, 'modelName'>[]): string | null {
  for (const item of items) {
    if (item.modelName != null) return item.modelName;
  }
  return null;
}

/**
 * True iff any content item on the message was produced via a routing stage
 * (Smart Model today). Drives the "Smart" chip on the assistant nametag.
 */
export function pickIsSmartModel(items: readonly Pick<ReplyMergeItem, 'isSmartModel'>[]): boolean {
  return items.some((item) => item.isSmartModel);
}

/**
 * Sums the persisted per-item reasoning token counts. Returns 0 when none —
 * the caller leaves the field absent so a zero-reasoning message renders no
 * thinking line (parity with the live streaming path, which only stamps a
 * positive count).
 */
export function sumReasoningTokens(
  items: readonly Pick<ReplyMergeItem, 'reasoningTokens'>[]
): number {
  let total = 0;
  for (const item of items) {
    total += item.reasoningTokens ?? 0;
  }
  return total;
}

/**
 * Sums the persisted per-item reasoning durations. Undefined when no item
 * recorded one, which keeps a reply settled before durations were measured
 * apart from one that reasoned for under a second.
 */
export function sumReasoningDuration(
  items: readonly Pick<ReplyMergeItem, 'reasoningDurationMs'>[]
): number | undefined {
  let total: number | undefined;
  for (const item of items) {
    if (item.reasoningDurationMs !== null) total = (total ?? 0) + item.reasoningDurationMs;
  }
  return total;
}

/**
 * The level the message's generation reasoned at. Taken from the first item
 * that recorded one — never folded, because a level is a decision taken once
 * per generation rather than a quantity spent. Absent when no item recorded
 * one, which is why `off` (reasoning resolved to none) survives here as a
 * value: the badge shows it, and shows nothing for the absent case.
 */
export function pickReasoningEffort(
  items: readonly Pick<ReplyMergeItem, 'reasoningEffort'>[]
): ResolvedReasoningEffort | undefined {
  for (const item of items) {
    if (item.reasoningEffort !== null) return item.reasoningEffort;
  }
  return undefined;
}

/**
 * The reply's optional display fields, each set only when its items recorded
 * something: an absent field is what keeps the Smart chip, the media grid and
 * the reasoning row off a reply that has none.
 */
export function replyDisplayFields(
  items: readonly ReplyMergeItem[],
  mediaItems: readonly MessageMediaItem[]
): Pick<
  Message,
  'isSmartModel' | 'mediaItems' | 'reasoningTokens' | 'reasoningEffort' | 'reasoningDurationMs'
> {
  const reasoningTokens = sumReasoningTokens(items);
  const reasoningEffort = pickReasoningEffort(items);
  const reasoningDurationMs = sumReasoningDuration(items);
  return {
    ...(pickIsSmartModel(items) && { isSmartModel: true }),
    ...(mediaItems.length > 0 && { mediaItems: [...mediaItems] }),
    ...(reasoningTokens > 0 && { reasoningTokens }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    ...(reasoningDurationMs === undefined ? {} : { reasoningDurationMs }),
  };
}
