import { useEffect } from 'react';
import { Network } from '@capacitor/network';
import { useNetworkStore } from '../../stores/network.js';
import { isNative } from '../platform.js';

interface NetworkState {
  isOffline: boolean;
}

/**
 * Tracks network connectivity on native platforms.
 *
 * Writes to the Zustand network store so non-React code (WS client)
 * can also read offline state via `useNetworkStore.getState()`.
 *
 * Returns `{ isOffline: true }` when the device loses connectivity.
 * On web, always returns `{ isOffline: false }` (browsers handle offline natively).
 */
export function useNetworkStatus(): NetworkState {
  const isOffline = useNetworkStore((s) => s.isOffline);
  const setIsOffline = useNetworkStore((s) => s.setIsOffline);

  useEffect(() => {
    if (!isNative()) return;

    void (async () => {
      const status = await Network.getStatus();
      setIsOffline(!status.connected);
    })();

    const listener = Network.addListener('networkStatusChange', (status) => {
      setIsOffline(!status.connected);
    });

    return () => {
      void (async () => {
        const handle = await listener;
        await handle.remove();
      })();
    };
  }, []);

  return { isOffline };
}
