import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/** Where a finding is brought to: the top of its pane, or the nearest edge. */
type ScrollBlock = 'start' | 'nearest';

/**
 * The pane the element lives in. `overflow: hidden` is deliberately not a pane:
 * the shell clips its frame that way and the document itself is clipped in
 * `app.css`, yet both stay scrollable to script, which is how a scroll aimed at
 * the queue used to take the header off screen with it.
 *
 * Shared with the stack's observers rather than re-derived there: an observer
 * measuring a different box from the one this scrolls is measuring the wrong
 * thing, and the two answers drifting apart is exactly how a margin becomes
 * silently worth nothing.
 */
export function scrollPane(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node !== null; node = node.parentElement) {
    const { overflowY } = globalThis.getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
  }
  return null;
}

/**
 * `Element.scrollIntoView` walks every scrollable ancestor and cannot be told
 * to stop, so the console moves one pane by hand instead. The header and the
 * filter rail are outside that pane and therefore cannot be scrolled away.
 */
function scrollWithinPane(element: HTMLElement, block: ScrollBlock): void {
  const pane = scrollPane(element);
  if (pane === null) return;

  const top = element.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  if (block === 'start') {
    pane.scrollTop += top;
    return;
  }

  const bottom = top + element.offsetHeight - pane.clientHeight;
  if (top >= 0 && bottom <= 0) return;
  pane.scrollTop += top < 0 ? top : bottom;
}

/** A browser always has one; the console's own test dom does not. */
function documentFonts(): FontFaceSet | undefined {
  return (globalThis.document as Partial<Document>).fonts;
}

/**
 * Keeps whatever the reader moved to on screen. Stepping through a queue only
 * swaps the pane's contents, so without this the next finding opens at the
 * scroll offset the last one was left at, which is past its own header.
 *
 * The anchor is what the reader is on, not the element: the same node is reused
 * for every finding, so watching the node would never see a move.
 */
export function useScrollIntoView(
  ref: RefObject<HTMLElement | null>,
  anchor: string | null,
  block: ScrollBlock
): (shown: string | null) => void {
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (shown.current === anchor) return;
    shown.current = anchor;
    const element = ref.current;
    if (element === null) return;
    scrollWithinPane(element, block);

    // The brand fonts swap in after the first paint, and everything above the
    // finding re-measures with them: a deep link into a section with a tall
    // lead landed 34px past the top of the card it named. One correction when
    // they land is the whole of it, because the metrics are final afterwards.
    const fonts = documentFonts();
    if (fonts === undefined || fonts.status === 'loaded') return;

    const landAgain = async (): Promise<void> => {
      await fonts.ready;
      // Where the reader is now is not where this scroll was aimed.
      if (shown.current !== anchor) return;
      const settled = ref.current;
      if (settled !== null) scrollWithinPane(settled, block);
    };
    void landAgain();
  });

  // Says an anchor has already been arrived at, so the move to it is not
  // chased. The reader's own scrolling moves what they are on, and a scroll
  // answering that scroll would put the console and the reader's hand on the
  // same scrollbar, each moving it because the other did. Called from the
  // observer rather than read during render, which is where a ref belongs.
  return (arrived: string | null): void => {
    shown.current = arrived;
  };
}
