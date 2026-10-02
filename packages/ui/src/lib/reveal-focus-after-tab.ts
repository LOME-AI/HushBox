import type * as React from 'react';

/**
 * Radix's focus trap wraps Tab and Shift+Tab by focusing with `preventScroll`, so in a scrolling
 * container the control it lands on can stay out of view. A Tab whose default a handler cancelled
 * is a Tab the browser did not scroll for, so the control focused once the keydown's dispatch has
 * finished is revealed here, as the browser reveals it after a Tab of its own. The wait is what
 * lets this run on a consumer's `onKeyDown`, which React calls before the trap's handler.
 */
export function revealFocusAfterCancelledTab(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.key !== 'Tab') return;
  const container = event.currentTarget;
  const { nativeEvent } = event;
  queueMicrotask(() => {
    if (!nativeEvent.defaultPrevented) return;
    const focused = document.activeElement;
    if (focused === null || focused === container || !container.contains(focused)) return;
    focused.scrollIntoView({ block: 'nearest' });
  });
}
