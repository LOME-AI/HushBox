import { useEffect, useRef } from 'react';
import { App } from '@capacitor/app';
import { isNative } from '../platform.js';

interface LifecycleCallbacks {
  /** Called when the app returns to the foreground. */
  onResume?: () => void;
  /** Called when the app goes to the background. */
  onPause?: () => void;
}

/**
 * Listens for native app state changes (foreground/background).
 *
 * Use `onResume` to reconnect WebSockets, refresh stale data, etc.
 * Use `onPause` to disconnect or persist state.
 * No-op on web.
 */
export function useAppLifecycle(callbacks?: LifecycleCallbacks): void {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!isNative()) return;

    const listener = App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        callbacksRef.current?.onResume?.();
      } else {
        callbacksRef.current?.onPause?.();
      }
    });

    return () => {
      void (async () => {
        const handle = await listener;
        await handle.remove();
      })();
    };
  }, []);
}
