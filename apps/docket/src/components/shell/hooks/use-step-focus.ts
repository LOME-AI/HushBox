import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

/**
 * Puts the keyboard where a queue step moved the reader. Stepping swaps what
 * the pane holds without moving focus, so the next Tab restarts at the top of
 * the document rather than carrying on beside the finding just stepped to.
 *
 * Counted rather than keyed on the finding: stepping back onto one the reader
 * has already been on has to move the keyboard again. It counts the keyboard's
 * own steps only, because a step taken from the pane's buttons has to leave
 * focus on the button it came from.
 */
export function useStepFocus(pane: RefObject<HTMLElement | null>, steps: number): void {
  const moved = useRef(steps);

  useEffect(() => {
    if (moved.current === steps) return;
    moved.current = steps;
    const element = pane.current;
    if (element === null) return;

    // Focusing scrolls every scrollable ancestor and cannot be told to stop,
    // which is what takes the header off screen; the pane does its own
    // scrolling for exactly that reason.
    const current = element.querySelector<HTMLElement>('[aria-current="true"]');
    (current ?? element).focus({ preventScroll: true });
  });
}
