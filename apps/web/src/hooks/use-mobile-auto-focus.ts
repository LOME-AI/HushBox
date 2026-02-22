import { useCallback } from 'react';
import { useIsMobile } from '@/hooks/use-is-mobile';

export function useMobileAutoFocus(): (event: Event) => void {
  const isMobile = useIsMobile();

  return useCallback(
    (event: Event) => {
      if (isMobile) {
        event.preventDefault();
      }
    },
    [isMobile]
  );
}
