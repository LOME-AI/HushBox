import * as React from 'react';
import { flushSync } from 'react-dom';
import { cn } from '@hushbox/ui';

/**
 * The largest share of the scroller's height the band may take and still stay pinned. Up to 70%
 * a pinned band leaves room to read and focus the page under it (the /accessibility band runs to
 * about 68% at 1440x900 with the largest text); a taller one leaves only a strip, so it scrolls.
 */
const MAX_PINNED_SHARE = 0.7;

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
  // The band's height while it is pinned, or null while it scrolls with the page.
  const [pinnedHeight, setPinnedHeight] = React.useState<number | null>(0);

  // A layout effect, so this observer is created before any passive-effect observer on the band
  // and runs first in each resize delivery; `flushSync` then lands the band's new position
  // before `useSectionInView`'s observer reads it to measure the band.
  React.useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const band = bandRef.current;
    if (!hasPinned || !scroller || !band) return;
    const observer = new ResizeObserver(() => {
      const height = band.offsetHeight;
      const next = height <= scroller.clientHeight * MAX_PINNED_SHARE ? height : null;
      flushSync(() => {
        setPinnedHeight(next);
      });
    });
    observer.observe(band);
    observer.observe(scroller);
    return (): void => {
      observer.disconnect();
    };
  }, [hasPinned]);

  return (
    <div
      ref={scrollerRef}
      data-testid={testId}
      data-page-scroller=""
      className="min-h-0 flex-1 overflow-y-auto"
      // A pinned band covers the scroller's top, so a control focused by keyboard is scrolled
      // into view below it rather than under it.
      style={pinnedHeight ? { scrollPaddingTop: pinnedHeight } : undefined}
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
  );
}
