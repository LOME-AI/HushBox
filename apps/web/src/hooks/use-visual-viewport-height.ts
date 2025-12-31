import { useState, useEffect, useCallback, useRef } from 'react';

export function useVisualViewportHeight(): number {
  const [height, setHeight] = useState<number>(() => {
    if (typeof window === 'undefined') return 0;
    return window.visualViewport?.height ?? window.innerHeight;
  });
  const rafRef = useRef<number | undefined>(undefined);

  const updateHeight = useCallback(() => {
    if (rafRef.current !== undefined) return;
    rafRef.current = requestAnimationFrame(() => {
      const newHeight = window.visualViewport?.height ?? window.innerHeight;
      setHeight((prev) => (prev === newHeight ? prev : newHeight));
      rafRef.current = undefined;
    });
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) {
      return;
    }

    const viewport = window.visualViewport;

    const handleResize = (): void => {
      updateHeight();
      setTimeout(updateHeight, 300); // iOS Safari reports late
    };

    viewport.addEventListener('resize', handleResize);

    return () => {
      viewport.removeEventListener('resize', handleResize);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [updateHeight]);

  return height;
}
