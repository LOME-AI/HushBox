import { useState, useCallback, useEffect } from 'react';

interface UseInteractionTrackerOptions {
  isTracking: boolean;
}

interface UseInteractionTrackerResult {
  hasInteractedSinceSubmit: boolean;
  resetOnSubmit: () => void;
}

export function useInteractionTracker({
  isTracking,
}: UseInteractionTrackerOptions): UseInteractionTrackerResult {
  const [hasInteracted, setHasInteracted] = useState(false);

  const resetOnSubmit = useCallback(() => {
    setHasInteracted(false);
  }, []);

  useEffect(() => {
    if (!isTracking) return;

    const handleInteraction = (): void => {
      setHasInteracted(true);
    };

    // Use capture phase to catch all events before they're handled
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

  return { hasInteractedSinceSubmit: hasInteracted, resetOnSubmit };
}
