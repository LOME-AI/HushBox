import { useCallback } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { conversationIdSchema } from '@hushbox/shared';
import {
  recordNativeRegistrationFailure,
  registerNativeDeviceToken,
} from '../lib/notification-channel/native-adapter.js';
import { useBackButton } from './hooks/use-back-button.js';
import { useDeepLinks } from './hooks/use-deep-links.js';
import { useAppLifecycle } from './hooks/use-app-lifecycle.js';
import { useNetworkStatus } from './hooks/use-network-status.js';
import { useSplashScreen } from './hooks/use-splash-screen.js';
import { usePushNotifications } from './hooks/use-push-notifications.js';
import { useLiveUpdate } from './hooks/use-live-update.js';
import { usePredictionSessionDisposal } from '../lib/prediction/use-prediction-session-disposal.js';
import type * as React from 'react';

interface CapacitorProviderProps {
  isAppStable: boolean;
}

/**
 * Thin shell that activates all Capacitor hooks.
 *
 * Each hook guards itself with `isNative()`, so this provider is safe to
 * render on web — all hooks become no-ops.
 */
export function CapacitorProvider({
  isAppStable,
  children,
}: Readonly<React.PropsWithChildren<CapacitorProviderProps>>): React.JSX.Element {
  const navigate = useNavigate();
  const handleDeepLink = useCallback(
    (path: string) => {
      void navigate({ to: path });
    },
    [navigate]
  );

  // The shell only routes the token; the notification channel owns the POST,
  // its retry, and the outcome the settings surface reads back.
  const handleTokenReceived = useCallback((token: string) => {
    registerNativeDeviceToken(token);
  }, []);

  const handleRegistrationError = useCallback(() => {
    recordNativeRegistrationFailure();
  }, []);

  const handleNotificationTap = useCallback(
    (data: Record<string, string>) => {
      const conversationId = data['conversationId'];
      if (conversationId && conversationIdSchema.safeParse(conversationId).success) {
        void navigate({ to: `/chat/${conversationId}` });
      }
    },
    [navigate]
  );

  useBackButton();
  useDeepLinks(handleDeepLink);
  useAppLifecycle();
  useNetworkStatus();
  useSplashScreen(isAppStable);
  useLiveUpdate();
  usePredictionSessionDisposal();
  usePushNotifications({
    onTokenReceived: handleTokenReceived,
    onNotificationTap: handleNotificationTap,
    onRegistrationError: handleRegistrationError,
  });

  return <>{children}</>;
}
