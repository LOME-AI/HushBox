/**
 * Keeps a scroll region's tab stop only while its content overflows it, and
 * re-measures whenever the region or its content changes size: a narrower
 * window shrinks the region, a larger text size widens the content inside a
 * region of the same width. Returns the function that stops watching.
 *
 * Framework-neutral on purpose: `ScrollRegion` calls it from an effect, and a
 * static page that renders the region as HTML calls it from its own script.
 * The server-rendered stop stays until this runs, so without script an
 * overflowing region is still reachable.
 */
export function observeOverflowStop(region: HTMLElement): () => void {
  const measure = (): void => {
    const overflows =
      region.scrollWidth > region.clientWidth || region.scrollHeight > region.clientHeight;
    if (overflows) {
      region.setAttribute('tabindex', '0');
    } else {
      region.removeAttribute('tabindex');
    }
  };
  measure();
  const observer = new ResizeObserver(measure);
  observer.observe(region);
  for (const child of region.children) observer.observe(child);
  return (): void => {
    observer.disconnect();
  };
}
