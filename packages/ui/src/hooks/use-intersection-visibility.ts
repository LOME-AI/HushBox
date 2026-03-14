import * as React from 'react';

interface UseIntersectionVisibilityResult {
  containerRef: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
}

/**
 * Hook that uses IntersectionObserver to detect when an element enters the viewport.
 * When `animated` is true, starts invisible and becomes visible on intersection.
 * When `animated` is false, returns visible=true immediately.
 */
export function useIntersectionVisibility(animated: boolean): UseIntersectionVisibilityResult {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState(!animated);

  React.useEffect(() => {
    if (!animated) return;
    const element = containerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(element);
    return (): void => {
      observer.disconnect();
    };
  }, [animated]);

  return { containerRef, visible };
}
