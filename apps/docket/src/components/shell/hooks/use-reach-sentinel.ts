import { useEffect, useRef } from 'react';
import { scrollPane } from './use-scroll-into-view';
import type { RefObject } from 'react';

/**
 * How far below the pane's own bottom edge the sentinel counts as reached. The
 * next of the queue is mounted before the reader arrives at the bottom, so the
 * stack does not visibly stop and start under them.
 *
 * It is measured against the pane and not the window, and that is the whole of
 * whether it works: the pane clips its own contents, so a margin outside the
 * pane never reaches the sentinel, and the reader has to land on the last pixel
 * of the stack to be given any more of it. Measured in Chromium at 400px, the
 * window-rooted version grew nothing until 20px from the bottom.
 */
const AHEAD = '0px 0px 400px 0px';

/**
 * Reports the reader reaching the end of what the stack has mounted.
 *
 * `shown` is a dependency rather than a value: growing the stack leaves the
 * sentinel exactly where it was, and an observer speaks only when an
 * intersection changes. A reader sitting at the bottom would therefore be told
 * about once and never again, so the observer is rebuilt on every growth and
 * re-reads a sentinel that is still on screen.
 */
export function useReachSentinel(
  sentinel: RefObject<HTMLElement | null>,
  shown: number,
  onReach: () => void
): void {
  const report = useRef(onReach);
  useEffect(() => {
    report.current = onReach;
  }, [onReach]);

  useEffect(() => {
    const element = sentinel.current;
    if (element === null) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) report.current();
      },
      { root: scrollPane(element), rootMargin: AHEAD }
    );
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, [sentinel, shown]);
}
