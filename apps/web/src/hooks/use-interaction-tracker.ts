import { useCallback, useEffect, useRef } from 'react';

interface UseInteractionTrackerOptions {
  isTracking: boolean;
}

interface UseInteractionTrackerResult {
  hasInteractedRef: React.RefObject<boolean>;
  resetOnSubmit: () => void;
}

export function useInteractionTracker({
  isTracking,
}: UseInteractionTrackerOptions): UseInteractionTrackerResult {
  const hasInteractedRef = useRef(false);

  const resetOnSubmit = useCallback(() => {
    hasInteractedRef.current = false;
  }, []);

  useEffect(() => {
    if (!isTracking) return;

    const handleInteraction = (): void => {
      hasInteractedRef.current = true;
    };

    // Capture phase catches interactions before they're handled by other handlers
    const options = { capture: true };

    document.addEventListener('click', handleInteraction, options);
    document.addEventListener('touchstart', handleInteraction, options);
    document.addEventListener('keydown', handleInteraction, options);

    return () => {
      document.removeEventListener('click', handleInteraction, options);
      document.removeEventListener('touchstart', handleInteraction, options);
      document.removeEventListener('keydown', handleInteraction, options);
    };
  }, [isTracking]);

  return { hasInteractedRef, resetOnSubmit };
}
