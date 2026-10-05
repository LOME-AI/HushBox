import * as React from 'react';
import { flushSync } from 'react-dom';
import { cn } from '@hushbox/ui';

/**
 * The largest share of the scroller's height the band may take and still stay pinned. Up to 70%
 * a pinned band leaves room to read and focus the page under it (the /accessibility band runs to
 * about 68% at 1440x900 with the largest text); a taller one leaves only a strip, so it scrolls.
 */
const MAX_PINNED_SHARE = 0.7;

/**
 * The height of what sticks at the scroller's top (the band, or below 768 its part marked to stick
 * on its own), or null while that scrolls with the page or the page has no band: the one
 * measurement of the band that the page body's subtree reads, and decides whether the part sticks.
 */
export const PinnedBandHeightContext = React.createContext<number | null>(null);

interface PageBodyProps {
  children: React.ReactNode;
  /** Optional Tailwind classes appended to the inner content wrapper (e.g. `space-y-6`). */
  className?: string;
  /** Optional `data-testid` on the outer scroll container. Defaults to `'page-body'`. */
  testId?: string;
  /**
   * Rendered full width above the content column; pinned to the scroller's top from 768 while
   * it is at most 70% of the scroller's height, and scrolled with the page when it is taller.
   */
  pinned?: React.ReactNode;
}

/**
 * Pairs with `PageHeader` to form a page body. The OUTER div is the full-width
 * scroll container — wheel and touch scroll work anywhere in the body area,
 * including the empty side margins. The INNER div constrains visual width
 * (`container mx-auto max-w-4xl p-4`). Together they preserve the existing
 * content shape while making the entire body scrollable.
 *
 * Routes should compose `<PageHeader />` + `<PageBody>...</PageBody>` instead
 * of hand-writing the `container mx-auto max-w-4xl flex-1 overflow-y-auto`
 * pattern — that combination puts the scroll container on the content-width
 * div, so scroll only activates over the centered content.
 */
export function PageBody({
  children,
  className,
  testId = 'page-body',
  pinned,
}: Readonly<PageBodyProps>): React.JSX.Element {
  const hasPinned = pinned !== undefined;
  const scrollerRef = React.useRef<HTMLDivElement>(null);
  const bandRef = React.useRef<HTMLDivElement>(null);
  // The height of what sticks at the scroller's top, or null while that scrolls with the page.
  const [pinnedHeight, setPinnedHeight] = React.useState<number | null>(0);

  // A layout effect, so this observer is created before any passive-effect observer on the band
  // and runs first in each resize delivery; `flushSync` then lands the band's new position
  // before the observer `useSectionInView` holds a hash arrival with reads it.
  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const band = bandRef.current;
    if (!hasPinned || !scroller || !band) return;
    // Below 768 the band has no box, so it measures 0; what would stick then is the part of it
    // marked to stick on its own, which sticks only while this measurement pins it.
    const stickyPart = band.querySelector<HTMLElement>('[data-page-pinned-sticky]');
    const measure = (): number | null => {
      const pinnable = band.offsetHeight > 0 ? band : stickyPart;
      if (!pinnable) return 0;
      const height = pinnable.offsetHeight;
      return height <= scroller.clientHeight * MAX_PINNED_SHARE ? height : null;
    };
    const observer = new ResizeObserver(() => {
      const next = measure();
      flushSync(() => {
        setPinnedHeight(next);
      });
    });
    observer.observe(band);
    observer.observe(scroller);
    if (stickyPart) observer.observe(stickyPart);
    return (): void => {
      observer.disconnect();
    };
  }, [hasPinned]);

  return (
    <PinnedBandHeightContext.Provider value={hasPinned ? pinnedHeight : null}>
      <div
        ref={scrollerRef}
        data-testid={testId}
        data-page-scroller=""
        className="min-h-0 flex-1 overflow-y-auto"
        // A pinned band covers the scroller's top, so a control focused by keyboard is scrolled
        // into view below it rather than under it.
        style={pinnedHeight ? { scrollPaddingTop: pinnedHeight } : undefined}
        // Firefox does not scroll a newly focused control it counts as already shown, though the
        // padded top hides part of it, and a control taller than the room left under what sticks
        // gets its bottom edge shown, not its top; so the page body itself scrolls the control's
        // top down to the same pinned height. Only the page body: `scrollIntoView` would also
        // scroll the shell around it. Keyboard focus only: a pointer focuses what is already seen.
        onFocus={(event) => {
          const control = event.target;
          const scroller = event.currentTarget;
          if (!pinnedHeight || control === scroller) return;
          if (bandRef.current?.contains(control) || !control.matches(':focus-visible')) return;
          const coveredTo = scroller.getBoundingClientRect().top + pinnedHeight;
          const under = control.getBoundingClientRect().top - coveredTo;
          // Whole pixels, rounded away from the band: a scroll offset snaps to the pixel grid.
          if (under < 0) scroller.scrollBy({ top: Math.floor(under) });
        }}
      >
        {hasPinned && (
          // Sticky inside the scroller, so it pins under whatever header the shell draws; a band
          // too tall to leave room for the page scrolls with it instead. Below 768 the band has no
          // box: its children scroll away, or one sticks on its own.
          <div
            ref={bandRef}
            data-page-pinned=""
            className={cn(
              'border-border bg-background/95 z-sticky border-b backdrop-blur-sm max-md:contents',
              pinnedHeight !== null && 'md:sticky md:top-0'
            )}
          >
            <div className="container mx-auto max-w-4xl px-4 py-2.5 max-md:contents">{pinned}</div>
          </div>
        )}
        <div className={cn('container mx-auto max-w-4xl p-4', className)}>{children}</div>
      </div>
    </PinnedBandHeightContext.Provider>
  );
}
