import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';

import { cn } from '../../lib/utilities';
import { observeOverflowStop } from './observe-overflow-stop';

interface ScrollRegionProps extends React.ComponentProps<'div'> {
  /** The region's accessible name: what it holds, in the screen's own words. */
  readonly label: string;
  /** Render the one child element as the region instead of a wrapping div. */
  readonly asChild?: boolean;
  /**
   * `always` keeps the tab stop at every size; `overflow` keeps it only while the
   * content overflows the region, measured again on every resize.
   */
  readonly tabStop?: 'always' | 'overflow';
}

/** Hands one element to the caller's ref, whichever kind of ref it is. */
function assignRef<T>(ref: React.Ref<T> | undefined, node: T | null): void {
  if (typeof ref === 'function') {
    ref(node);
  } else if (ref !== null && ref !== undefined) {
    ref.current = node;
  }
}

/**
 * A scrolling box a keyboard reader can reach. A region whose content holds no
 * focusable element is otherwise scrollable only by pointer (WCAG 2.1.1; axe
 * reports it as scrollable-region-focusable), so the box itself takes a tab
 * stop and a name. The caller keeps its own overflow and bound classes, and its
 * props spread after these, so a caller's `data-slot` or name stands.
 *
 * It adds no radius: a box that paints nothing at rest should add no shape, and
 * a rounded scroll box clips the corners of content that reaches its edge. A
 * caller whose box is drawn rounded passes its own.
 */
function ScrollRegion({
  label,
  asChild = false,
  tabStop = 'always',
  className,
  ref,
  ...props
}: Readonly<ScrollRegionProps>): React.JSX.Element {
  const Comp = asChild ? Slot : 'div';
  const [region, setRegion] = React.useState<HTMLDivElement | null>(null);
  const measuredRef = React.useCallback(
    (node: HTMLDivElement | null): void => {
      setRegion(node);
      assignRef(ref, node);
    },
    [ref]
  );

  React.useEffect(() => {
    if (tabStop !== 'overflow' || region === null) return;
    return observeOverflowStop(region);
  }, [tabStop, region]);

  return (
    <Comp
      // With `tabStop="overflow"` this is only the server render's stop:
      // `observeOverflowStop` owns the attribute from mount on, and React never
      // rewrites a prop whose value has not changed.
      tabIndex={0}
      role="group"
      aria-label={label}
      data-slot="scroll-region"
      className={cn(
        // Relative so absolutely positioned content, such as `sr-only` text, takes
        // this box as its containing block and is clipped by it instead of
        // widening the page.
        'focus-visible:ring-ring relative focus-visible:ring-2 focus-visible:outline-hidden',
        className
      )}
      ref={tabStop === 'overflow' ? measuredRef : ref}
      {...props}
    />
  );
}

export { ScrollRegion };
