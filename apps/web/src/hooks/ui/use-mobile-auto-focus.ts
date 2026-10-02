import { useCallback } from 'react';
import { useIsMobile } from '@hushbox/ui';

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
