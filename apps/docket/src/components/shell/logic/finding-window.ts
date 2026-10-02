/**
 * One card above the reader's and two below: what the pane mounts when it
 * arrives somewhere, before the reader has scrolled anywhere. Enough that the
 * stack reads as a stack from the first paint, and few enough that arriving
 * costs a fixed amount however long the queue is — a card renders the finding's
 * whole body and a text box for every option.
 */
const BEFORE = 1;
const AFTER = 2;

/** How many cards arriving mounts, wherever in the queue the reader arrives. */
export const STACK_SPAN = BEFORE + AFTER + 1;

interface StackRange {
  readonly start: number;
  /** Exclusive, as a slice bound. */
  readonly end: number;
}

/**
 * Where the stack starts and ends when the reader arrives at `index`. The span
 * is fixed rather than trimmed at the ends, so the head and tail of a queue
 * stack as deep as its middle.
 *
 * This is only the arrival. Growth from here is the reader's own: scrolling to
 * the bottom of the stack extends `end` until the queue runs out, which is what
 * makes the whole of it reachable — see `useStackWindow`.
 */
export function findingWindow(length: number, index: number): StackRange {
  const last = Math.max(0, length - STACK_SPAN);
  const start = Math.min(Math.max(0, index - BEFORE), last);
  return { start, end: Math.min(length, start + STACK_SPAN) };
}
