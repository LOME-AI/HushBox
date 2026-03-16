import { useState, useEffect } from 'react';
import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import { useStreamingActivityStore } from '@/stores/streaming-activity';
import { useAuthStore } from '@/lib/auth';

const DEBOUNCE_MS = 300;

export function useIsSettled(): boolean {
  const isFetching = useIsFetching();
  const isMutating = useIsMutating();
  const activeStreams = useStreamingActivityStore((s) => s.activeStreams);
  const isAuthLoading = useAuthStore((s) => s.isLoading);

  const isIdle =
    isFetching === 0 && isMutating === 0 && activeStreams === 0 && !isAuthLoading;

  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (!isIdle) {
      setSettled(false);
      return;
    }
    const timer = setTimeout(() => {
      setSettled(true);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [isIdle]);

  return settled;
}
