import { useEffect, useLayoutEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Keeps the reader's place in a scrolling pane across a change that empties and
 * refills it — narrowing a filter and clearing it again is the one that costs a
 * long queue its position, because the browser clamps the offset to zero while
 * the short list is on screen and has nothing to restore it from afterwards.
 *
 * The clamp arrives as a scroll event indistinguishable from a deliberate one,
 * so it is told apart by what the content can hold: an offset the pane is too
 * short for was not the reader's doing and is not recorded.
 */
export function useScrollRestore(ref: RefObject<HTMLElement | null>, key: string): void {
  const offsets = useRef(new Map<string, number>());
  const currentKey = useRef(key);
  currentKey.current = key;

  useEffect(() => {
    const pane = ref.current;
    if (pane === null) return;
    const record = (): void => {
      const held = pane.scrollHeight - pane.clientHeight;
      const saved = offsets.current.get(currentKey.current) ?? 0;
      if (pane.scrollTop === 0 && held < saved) return;
      offsets.current.set(currentKey.current, pane.scrollTop);
    };
    pane.addEventListener('scroll', record);
    return () => {
      pane.removeEventListener('scroll', record);
    };
  }, [ref]);

  const shownKey = useRef<string | null>(null);

  useLayoutEffect(() => {
    const pane = ref.current;
    if (pane === null) return;
    const saved = offsets.current.get(key) ?? 0;
    if (shownKey.current !== key) {
      // A different pane's offset is not this one's place: switching section or
      // mode takes the offset this view was left at, which is zero the first
      // time it is opened.
      shownKey.current = key;
      pane.scrollTop = saved;
      return;
    }
    // Otherwise only ever from the top, because anything else is a position the
    // reader or the selection put us at and taking it back would fight them.
    if (pane.scrollTop === 0 && saved > 0 && pane.scrollHeight - pane.clientHeight >= saved) {
      pane.scrollTop = saved;
    }
  });
}
