import type * as React from 'react';

/**
 * Radix's focus trap wraps Shift+Tab only from the first tabbable. From the overlay's own
 * content element the browser moves focus out and the trap returns it to that element, so wrap
 * to the last control here. Each candidate is tried in turn: a disabled or unrendered one
 * refuses focus. Anything else is left to the browser and the trap.
 */
export function wrapShiftTabFromContainer(event: React.KeyboardEvent<HTMLElement>): void {
  const container = event.currentTarget;
  if (event.key !== 'Tab' || !event.shiftKey || event.target !== container) return;
  const candidates = [...container.querySelectorAll<HTMLElement>('*')].filter(
    (element) => element.tabIndex >= 0
  );
  for (const candidate of candidates.toReversed()) {
    candidate.focus();
    if (document.activeElement === candidate) {
      event.preventDefault();
      return;
    }
  }
}
