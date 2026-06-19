import { useState, useEffect } from 'react';
import { useIsFetching, useIsMutating } from '@tanstack/react-query';
import { useAsyncActivityStore } from '@hushbox/ui';
import { useStreamingActivityStore } from '@/stores/streaming-activity';
import { useDecryptionActivityStore } from '@/stores/decryption-activity';
import { useWebsocketInboundActivityStore } from '@/stores/websocket-inbound-activity';
import { useAuthStore } from '@/lib/auth';

export const DEBOUNCE_MS = 5000;

export function useIsSettled(): boolean {
  const isFetching = useIsFetching();
  const isMutating = useIsMutating();
  const activeStreams = useStreamingActivityStore((s) => s.activeStreams);
  const pendingDecryptions = useDecryptionActivityStore((s) => s.pendingDecryptions);
  const pendingInbound = useWebsocketInboundActivityStore((s) => s.pendingInbound);
  const isAuthLoading = useAuthStore((s) => s.isLoading);
  // Includes raw-fetch flows (auth resend, recovery save, etc.) routed
  // through `useAsyncAction.run(...)`. Without this, settled-expect can
  // pre-throw "App settled but assertion not satisfied" while one of those
  // fetches is still in flight (CODE-RULES forbids raw fetch for typed
  // endpoints, but the existing OPAQUE auth pipeline still uses it).
  const pendingAsyncActions = useAsyncActivityStore((s) => s.activeCount);

  const isIdle =
    isFetching === 0 &&
    isMutating === 0 &&
    activeStreams === 0 &&
    pendingDecryptions === 0 &&
    pendingInbound === 0 &&
    pendingAsyncActions === 0 &&
    !isAuthLoading;

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
