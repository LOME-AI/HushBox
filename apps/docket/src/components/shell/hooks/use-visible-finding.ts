import { useEffect, useRef } from 'react';
import { scrollPane } from './use-scroll-into-view';
import type { RefObject } from 'react';

/**
 * Only the top of the pane counts as being read. Without the bottom margin
 * every card between the reader's and the fold intersects, and the answer would
 * be whichever of them the queue happened to put first.
 *
 * A band inside the pane only is one if the pane is what it is measured
 * against. Against the window it is a band over whatever the window happens to
 * hold, which in this console is a different box from the one the reader
 * scrolls — the document does not scroll at all.
 */
const READING_BAND = '0px 0px -70% 0px';

/**
 * Which finding the reader is looking at, from where they have scrolled to.
 * Without this the keyboard aims at whatever `j` last landed on, so a reader who
 * scrolls to a finding and presses a digit rules a different one.
 *
 * Reported once per finding: a card crossing the band edge re-fires, and
 * repeating the answer would write the reader's place to the url on every
 * scroll tick.
 */
export function useVisibleFinding(
  stack: RefObject<HTMLElement | null>,
  ids: readonly string[],
  onSee: (id: string) => void
): void {
  const report = useRef(onSee);
  useEffect(() => {
    report.current = onSee;
  }, [onSee]);

  // The queue in one string: the effect rebuilds when the stack grows or the
  // queue changes, and an array prop would rebuild it on every render.
  const order = ids.join('\u0000');

  useEffect(() => {
    const container = stack.current;
    if (container === null) return;
    // In queue order, which is the order they are read in. A finding the stack
    // has not painted is left out rather than watched as nothing.
    const watched = order.split('\u0000').flatMap((id) => {
      const node = container.querySelector(`[data-finding="${id}"]`);
      return node === null ? [] : [{ id, node }];
    });
    if (watched.length === 0) return;

    const onScreen = new Set<Element>();
    let said: string | null = null;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onScreen.add(entry.target);
          else onScreen.delete(entry.target);
        }
        const topmost = watched.find((card) => onScreen.has(card.node));
        if (topmost === undefined || topmost.id === said) return;
        said = topmost.id;
        report.current(topmost.id);
      },
      { root: scrollPane(container), rootMargin: READING_BAND }
    );
    for (const card of watched) observer.observe(card.node);
    return () => {
      observer.disconnect();
    };
  }, [stack, order]);
}
