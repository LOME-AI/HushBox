/**
 * Moves focus to the first level-one heading inside `root`, so a screen reader announces
 * a view that replaced the control holding focus. The heading becomes focusable by script
 * only, which keeps it out of the Tab order.
 */
export function focusHeading(root: HTMLElement | null): void {
  const heading = root?.querySelector('h1');
  if (heading === null || heading === undefined) return;
  if (!heading.hasAttribute('tabindex')) heading.setAttribute('tabindex', '-1');
  heading.focus();
}
