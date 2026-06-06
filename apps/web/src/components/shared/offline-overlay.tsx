import * as React from 'react';
import { WifiOff } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { useNetworkStore } from '@/stores/network';

export function OfflineOverlay(): React.JSX.Element | null {
  const isOffline = useNetworkStore((s) => s.isOffline);

  if (!isOffline) return null;

  // z-50 matches Radix Dialog/Sheet z-index — overlay sits at same layer
  return (
    <div
      data-testid={TEST_IDS.offlineOverlay}
      className="bg-background/95 fixed inset-0 z-50 flex flex-col items-center justify-center backdrop-blur-sm"
    >
      <WifiOff className="text-muted-foreground mb-4 h-10 w-10" />
      <h2 data-testid={TEST_IDS.offlineOverlayTitle} className="mb-2 text-lg font-semibold">
        You&apos;re Offline
      </h2>
      <p data-testid={TEST_IDS.offlineOverlayDescription} className="text-muted-foreground text-sm">
        Waiting for network. We&apos;ll reconnect automatically.
      </p>
    </div>
  );
}
