import type { CalculateViewLocation } from 'react-virtuoso';
import type { Message } from '@/lib/api/api';

interface Identified {
  readonly id: string;
}

/** A row of the thread as Virtuoso holds it: one message, a sender's group, or a compare turn. */
export interface ThreadRow {
  readonly message?: Identified | undefined;
  readonly group?: { readonly messages: readonly Identified[] } | undefined;
  readonly replies?: readonly { readonly message: Identified }[] | undefined;
}

/** A failed-turn notice and where it sits: its id after the id of the row drawn before it. */
interface NoticePlacement {
  readonly id: string;
  readonly placement: string;
}

/**
 * The thread's failed-turn notices whose placement is not among those already seen, in thread
 * order. A notice that moves, as one first drawn at the end does once its turn's replies are
 * drawn again above it, is placed anew.
 */
export function unseenNotices(
  messages: readonly Message[],
  seen: ReadonlySet<string>
): NoticePlacement[] {
  return messages.flatMap((m, index) => {
    if (m.turnNotice === undefined) return [];
    const placement = `${messages[index - 1]?.id ?? ''}>${m.id}`;
    return seen.has(placement) ? [] : [{ id: m.id, placement }];
  });
}

/** Where the row drawing the message with this id sits in the thread, or -1 when none draws it. */
export function rowIndexHolding(rows: readonly ThreadRow[], id: string): number {
  return rows.findIndex(
    (row) =>
      row.message?.id === id ||
      row.group?.messages.some((m) => m.id === id) === true ||
      row.replies?.some((cell) => cell.message.id === id) === true
  );
}

/**
 * Where to scroll so a notice is in view: centred, so the turn it belongs to shows above it.
 * A notice already wholly in view is left where it is.
 */
export const noticeViewLocation: CalculateViewLocation = ({
  itemTop,
  itemBottom,
  viewportTop,
  viewportBottom,
  locationParams,
}) => {
  if (itemTop >= viewportTop && itemBottom <= viewportBottom) return null;
  return { ...locationParams, align: 'center' };
};

/** How long a scroller has stood in one place: the top it stands at, and the frames since it moved. */
export interface Stillness {
  readonly top: number;
  readonly frames: number;
}

/** A count not yet begun: no scroller stands at -1, so its first frame starts the count. */
export const STILLNESS_UNCOUNTED: Stillness = { top: -1, frames: 0 };

/**
 * One frame of the count, read at the scroller's whole-pixel top. A scroller that moved starts it
 * afresh where it stands; one that has stood still for `needed` frames is at rest, and the count
 * begins again.
 */
export function countStillFrame(
  still: Stillness,
  scrollTop: number,
  needed: number
): { still: Stillness; rested: boolean } {
  const top = Math.round(scrollTop);
  if (top !== still.top) return { still: { top, frames: 0 }, rested: false };
  const frames = still.frames + 1;
  if (frames < needed) return { still: { top, frames }, rested: false };
  return { still: STILLNESS_UNCOUNTED, rested: true };
}
