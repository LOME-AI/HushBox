import { useState } from 'react';
import { STACK_SPAN, findingWindow } from '../logic/finding-window';
import type { FindingJson } from '@hushbox/docket';

export interface StackWindow {
  /** The findings mounted, in queue order. */
  readonly shown: readonly FindingJson[];
  /** There is more queue below what is mounted. */
  readonly more: boolean;
  /** The reader reached the bottom of the stack: mount the next of it. */
  readonly extend: () => void;
}

/** What the reader has grown the stack to, and the arrival it grew from. */
interface Growth {
  readonly key: string;
  readonly from: number;
  readonly extra: number;
}

/**
 * The slice of the queue that is mounted. It grows downward as the reader
 * reaches the bottom of it and never drops what is above, so the whole queue is
 * reachable by scrolling and the reader's place never moves under them —
 * dropping from the top would need spacers sized to the dropped cards, and
 * without them the scroll offset jumps by whatever they measured.
 *
 * The cost of that is bounded by what the reader has actually visited rather
 * than by the length of the corpus, and it is given back the moment they move
 * outside it: a jump, a step past either end, a section or a filter is a
 * different act from a scroll, so the stack starts again from the arrival
 * window there.
 */
export function useStackWindow(
  findings: readonly FindingJson[],
  index: number,
  key: string
): StackWindow {
  const [growth, setGrowth] = useState<Growth>({ key, from: 0, extra: 0 });

  // Derived rather than reset in an effect: a stale growth is simply not used,
  // where an effect would paint one frame of the wrong stack first.
  const kept =
    growth.key === key && index >= growth.from && index < growth.from + STACK_SPAN + growth.extra;
  const from = kept ? growth.from : findingWindow(findings.length, index).start;
  const extra = kept ? growth.extra : 0;
  const end = Math.min(findings.length, from + STACK_SPAN + extra);

  return {
    shown: findings.slice(from, end),
    more: end < findings.length,
    extend: (): void => {
      setGrowth({ key, from, extra: extra + STACK_SPAN });
    },
  };
}
