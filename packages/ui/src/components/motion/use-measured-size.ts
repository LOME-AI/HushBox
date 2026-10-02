import * as React from 'react';

type Dimension = 'offsetWidth' | 'offsetHeight';

interface MeasuredSize<T extends HTMLElement> {
  ref: (element: T | null) => void;
  size: number | 'auto';
}

/**
 * Tracks one offset dimension of an element through `ResizeObserver`, as a
 * pixel count or `'auto'` before the first measurement. The ref is a callback
 * so an element mounted after the hook's first render (content that opens
 * later) is still observed. Disabled, it observes nothing and stays `'auto'`.
 */
export function useMeasuredSize<T extends HTMLElement>(
  dimension: Dimension,
  enabled: boolean
): MeasuredSize<T> {
  const [element, setElement] = React.useState<T | null>(null);
  const [size, setSize] = React.useState<number | 'auto'>('auto');

  React.useLayoutEffect(() => {
    if (!enabled || element === null) return;
    setSize(element[dimension]);
    const observer = new ResizeObserver(() => {
      setSize(element[dimension]);
    });
    observer.observe(element);
    return (): void => {
      observer.disconnect();
    };
  }, [enabled, element, dimension]);

  return { ref: setElement, size };
}
