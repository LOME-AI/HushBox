import { useEffect, useState, type RefObject } from 'react';

type HeaderRows = 1 | 2 | 3;

/**
 * Measures intrinsic widths of three header content groups and determines
 * how many rows are needed to avoid overflow. Uses ResizeObserver for
 * dynamic recalculation when the container or content sizes change.
 *
 * Decision logic (no hardcoded breakpoints):
 *   all fit in one row  → 1
 *   title alone + (model + icons) fit  → 2
 *   each group on its own row  → 3
 */
export function useHeaderLayout(
  containerRef: RefObject<HTMLDivElement | null>,
  leftRef: RefObject<HTMLDivElement | null>,
  centerRef: RefObject<HTMLDivElement | null>,
  rightRef: RefObject<HTMLDivElement | null>
): HeaderRows {
  const [rows, setRows] = useState<HeaderRows>(1);

  useEffect(() => {
    const container = containerRef.current;
    const left = leftRef.current;
    const center = centerRef.current;
    const right = rightRef.current;
    if (!container || !left || !center || !right) return;

    const calculate = (): void => {
      const available = container.clientWidth;
      const lw = left.offsetWidth;
      const cw = center.offsetWidth;
      const rw = right.offsetWidth;

      if (lw + cw + rw <= available) {
        setRows(1);
      } else if (Math.max(lw, cw + rw) <= available) {
        setRows(2);
      } else {
        setRows(3);
      }
    };

    const observer = new ResizeObserver(calculate);
    observer.observe(container);
    observer.observe(left);
    observer.observe(center);
    observer.observe(right);
    calculate();

    return (): void => {
      observer.disconnect();
    };
  }, [containerRef, leftRef, centerRef, rightRef]);

  return rows;
}
