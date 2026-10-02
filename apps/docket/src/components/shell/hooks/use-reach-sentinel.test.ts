import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { stubIntersectionObserver } from '@/test-utils/intersection-observer';
import { useReachSentinel } from './use-reach-sentinel';
import type { IntersectionStub } from '@/test-utils/intersection-observer';

let stub: IntersectionStub | null = null;

afterEach(() => {
  stub?.restore();
  stub = null;
});

function setup(shown = 4): {
  sentinel: HTMLDivElement;
  pane: HTMLDivElement;
  onReach: ReturnType<typeof vi.fn>;
  grow: (to: number) => void;
} {
  stub = stubIntersectionObserver();
  // The console's own shape: the document does not scroll, a pane inside it
  // does. An observer that measured the window would be measuring a box the
  // reader never moves.
  const pane = document.createElement('div');
  pane.style.overflowY = 'auto';
  document.body.append(pane);
  const sentinel = document.createElement('div');
  pane.append(sentinel);
  const onReach = vi.fn<() => void>();
  const { rerender } = renderHook(
    (props: { shown: number }) => {
      useReachSentinel({ current: sentinel }, props.shown, onReach);
    },
    { initialProps: { shown } }
  );
  return {
    sentinel,
    pane,
    onReach,
    grow: (to) => {
      rerender({ shown: to });
    },
  };
}

describe('useReachSentinel', () => {
  it('watches the sentinel the stack ends with', () => {
    const { sentinel } = setup();

    expect(stub?.watching()).toEqual([sentinel]);
  });

  /**
   * The lookahead is the whole point of the sentinel: the next of the queue is
   * mounted before the reader arrives at the bottom. Measured against the
   * window it is silently worth nothing — the pane clips its own contents, so
   * a margin outside the pane never reaches the element, and the reader has to
   * land on the last pixel of the stack to be given any more of it.
   */
  it('measures against the pane the reader scrolls, not the window', () => {
    const { pane } = setup();

    expect(stub?.built()).toEqual([{ root: pane, rootMargin: '0px 0px 400px 0px' }]);
  });

  it('says nothing while the sentinel is below what the reader can see', () => {
    const { onReach } = setup();

    stub?.show([]);

    expect(onReach).not.toHaveBeenCalled();
  });

  it('reports the reader reaching the end of what is mounted', () => {
    const { sentinel, onReach } = setup();

    stub?.show([sentinel]);

    expect(onReach).toHaveBeenCalledTimes(1);
  });

  /**
   * Growing the stack leaves the sentinel where it was — still on screen if the
   * reader is at the bottom — and an observer only speaks when something
   * changes. Without re-watching, the stack grows once and stops, which is the
   * same dead end as never growing at all.
   */
  it('watches the sentinel again each time the stack grows, so growth carries on', () => {
    const { sentinel, onReach, grow } = setup(4);
    stub?.show([sentinel]);

    grow(8);
    stub?.show([sentinel]);

    expect(onReach).toHaveBeenCalledTimes(2);
  });

  it('stops watching once nothing is holding the sentinel', () => {
    stub = stubIntersectionObserver();
    const onReach = vi.fn<() => void>();
    const { unmount } = renderHook(() => {
      useReachSentinel({ current: null }, 4, onReach);
    });

    unmount();

    expect(stub.watching()).toEqual([]);
  });
});
