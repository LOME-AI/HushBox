import * as React from 'react';
import { createPortal } from 'react-dom';
import { WifiOff } from 'lucide-react';
import { TEST_IDS } from '@hushbox/shared';
import { useNetworkStore } from '@/stores/network';

export function OfflineOverlay(): React.JSX.Element | null {
  const isOffline = useNetworkStore((s) => s.isOffline);

  // While offline, mark the entire app root inert so keyboard focus can't escape
  // behind the overlay and reach the (now-unusable) UI. The overlay itself is
  // portaled to <body>, outside #root, so it stays interactive and `z-overlay`
  // keeps it above body-portaled Radix dialogs.
  React.useEffect(() => {
    if (!isOffline) return;
    const root = document.querySelector('#root');
    if (!root) return;
    root.setAttribute('inert', '');
    return () => {
      root.removeAttribute('inert');
    };
  }, [isOffline]);

  if (!isOffline) return null;

  return createPortal(
    <div
      data-testid={TEST_IDS.offlineOverlay}
      role="status"
      aria-live="polite"
      className="bg-background/95 z-overlay fixed inset-0 flex flex-col items-center justify-center backdrop-blur-sm"
    >
      <WifiOff className="text-muted-foreground mb-4 h-10 w-10" />
      <h2 data-testid={TEST_IDS.offlineOverlayTitle} className="mb-2 text-lg font-semibold">
        You&apos;re Offline
      </h2>
      <p data-testid={TEST_IDS.offlineOverlayDescription} className="text-muted-foreground text-sm">
        Waiting for network. We&apos;ll reconnect automatically.
      </p>
    </div>,
    document.body
  );
}
