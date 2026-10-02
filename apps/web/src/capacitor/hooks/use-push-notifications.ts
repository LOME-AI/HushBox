import { useEffect, useRef } from 'react';
import { PushNotifications } from '@capacitor/push-notifications';
import { FCM } from '@capacitor-community/fcm';
import { isNative, getPlatform } from '../platform.js';

interface PushCallbacks {
  /** Called when FCM registration token is received. Send to `POST /notifications/device-tokens`. */
  onTokenReceived?: (token: string) => void;
  /** Called when the user taps a notification. Navigate to the relevant conversation. */
  onNotificationTap?: (data: Record<string, string>) => void;
  /** Called when the platform refuses to register this device for delivery at all. */
  onRegistrationError?: () => void;
}

/**
 * Listens for push token and notification-tap events on native platforms.
 * No-op on web.
 *
 * It deliberately neither asks for permission nor registers for remote
 * notifications: both belong to the notification channel, which raises the
 * permission question only from an explicit user action. The listeners must be
 * attached before anything calls `PushNotifications.register()`, or the
 * `registration` event that carries the token is missed.
 *
 * On Android the `registration` event already carries the FCM token. On iOS it
 * carries the raw APNs token, which the FCM HTTP v1 API rejects; the coexisting
 * `@capacitor-community/fcm` plugin exchanges it for the FCM token via
 * `FCM.getToken()` (which requires `PushNotifications.register()` to have run
 * first, so the APNs token is available to Firebase).
 */
export function usePushNotifications(callbacks?: PushCallbacks): void {
  const callbacksRef = useRef(callbacks);
  callbacksRef.current = callbacks;

  useEffect(() => {
    if (!isNative()) return;

    const registrationListener = PushNotifications.addListener('registration', (token) => {
      if (getPlatform() === 'ios') {
        void (async () => {
          try {
            const { token: fcmToken } = await FCM.getToken();
            callbacksRef.current?.onTokenReceived?.(fcmToken);
          } catch (error) {
            // Best-effort: a missing FCM token just means no push this session.
            console.error('Failed to resolve FCM token on iOS:', error);
          }
        })();
        return;
      }
      callbacksRef.current?.onTokenReceived?.(token.value);
    });

    const actionListener = PushNotifications.addListener(
      'pushNotificationActionPerformed',
      (event) => {
        callbacksRef.current?.onNotificationTap?.(
          event.notification.data as Record<string, string>
        );
      }
    );

    // A platform-level refusal arrives on its own event and never reaches the
    // `registration` listener, so nothing else can tell a device that will never
    // receive a notification from one whose token has simply not arrived yet.
    const registrationErrorListener = PushNotifications.addListener('registrationError', () => {
      callbacksRef.current?.onRegistrationError?.();
    });

    // `addListener` resolves to the handle rather than returning it, so removal
    // is the awaited form; one loop is what keeps a listener added here from
    // outliving the shell because a second removal call was forgotten.
    const listeners = [registrationListener, actionListener, registrationErrorListener];
    return () => {
      void (async () => {
        for (const listener of listeners) {
          const handle = await listener;
          await handle.remove();
        }
      })();
    };
  }, []);
}
