import * as React from 'react';

type Axis = 'width' | 'height';

interface UseMeasuredSizeResult<T extends HTMLElement> {
  ref: React.RefObject<T | null>;
  size: number | 'auto';
}

/**
 * Tracks a single dimension (`width` or `height`) of a measured element via
 * `ResizeObserver`. Returns a ref to attach and the current size in pixels, or
 * `'auto'` before the first measurement. When `enabled` is false, no observer
 * is created and `size` stays `'auto'` — used by the morph primitives to
 * short-circuit under `prefers-reduced-motion`.
 */
export function useMeasuredSize<T extends HTMLElement>(
  axis: Axis,
  enabled: boolean
): UseMeasuredSizeResult<T> {
  const ref = React.useRef<T | null>(null);
  const [size, setSize] = React.useState<number | 'auto'>('auto');

  React.useLayoutEffect(() => {
    if (!enabled) return;
    const element = ref.current;
    if (!element) return;
    setSize(axis === 'width' ? element.offsetWidth : element.offsetHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setSize(axis === 'width' ? entry.contentRect.width : entry.contentRect.height);
    });
    observer.observe(element);
    return (): void => {
      observer.disconnect();
    };
  }, [enabled, axis]);

  return { ref, size };
}
