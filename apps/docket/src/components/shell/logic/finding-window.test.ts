import { describe, it, expect } from 'vitest';
import { STACK_SPAN, findingWindow } from './finding-window';

const ids = (length: number, index: number): readonly number[] => {
  const { start, end } = findingWindow(length, index);
  return Array.from({ length: end - start }, (_unused, offset) => start + offset);
};

describe('findingWindow', () => {
  it('mounts the finding the reader arrives at with the ones either side of it', () => {
    expect(ids(12, 5)).toContain(5);
    expect(ids(12, 5)).toContain(4);
    expect(ids(12, 5)).toContain(6);
  });

  it('mounts the findings in the order the queue reads', () => {
    expect(ids(12, 5)).toEqual([4, 5, 6, 7]);
  });

  /**
   * Arriving costs a fixed amount: a card carries the finding's whole rendered
   * body and a text box per option, and the corpus is several hundred findings.
   * What the reader scrolls to is mounted on top of this, by their own scroll.
   */
  it('mounts a bounded number of them however long the queue is', () => {
    const { start, end } = findingWindow(457, 200);

    expect(end - start).toBe(STACK_SPAN);
  });

  it('still fills the stack at the head of the queue, where nothing sits above', () => {
    expect(ids(12, 0)).toEqual([0, 1, 2, 3]);
  });

  it('still fills the stack at the tail, where nothing sits below', () => {
    expect(ids(12, 11)).toEqual([8, 9, 10, 11]);
  });

  it('mounts a queue shorter than the stack whole', () => {
    expect(ids(2, 1)).toEqual([0, 1]);
  });

  /**
   * Every length the console can hand it, at every position in it. The card the
   * reader is on is the only one that answers a keystroke, so a range that ever
   * left it out would take the console's whole keyboard away rather than merely
   * scroll past it; a range that ran off either end would mount nothing.
   */
  it('holds the reader’s finding inside the queue, at every length and position', () => {
    const lengths = [...Array.from({ length: 60 }, (_unused, n) => n + 1), 342, 457, 550];
    const broken = lengths.flatMap((length) =>
      Array.from({ length }, (_unused, index) => ({
        length,
        index,
        ...findingWindow(length, index),
      })).filter(
        ({ start, end, index }) =>
          start < 0 ||
          end > length ||
          start > index ||
          end <= index ||
          end - start !== Math.min(length, STACK_SPAN)
      )
    );

    expect(broken).toEqual([]);
  });
});
