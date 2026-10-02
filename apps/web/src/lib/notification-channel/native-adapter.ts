import { PushNotifications } from '@capacitor/push-notifications';
import { getPlatform } from '@/capacitor/platform';
import { client, fetchJson } from '@/lib/api-client';
import { sendRegistration } from './registration.js';
import type { NotificationChannel, PushPermissionState, RegistrationOutcome } from './types.js';
import type { PermissionState } from '@capacitor/core';
import type { PushNotificationSchema } from '@capacitor/push-notifications';

/**
 * Capacitor reports two flavours of "not decided yet" (`prompt` and
 * `prompt-with-rationale`); both are the state in which asking is legitimate.
 */
function toPermissionState(receive: PermissionState): PushPermissionState {
  if (receive === 'granted') return 'granted';
  if (receive === 'denied') return 'denied';
  return 'default';
}

/**
 * Which conversation a shade entry belongs to.
 *
 * Both platforms are needed, and neither covers the other. Android reports the
 * notification's tag — the raw conversation id the sender stamps there — while
 * its `data` is the Android notification extras, which never carry the id. iOS
 * reports no tag at all, but its `data` is the APNs userInfo, which does carry
 * the id. `data` is untyped platform JSON, hence the narrowing.
 */
function deliveredConversationId(notification: PushNotificationSchema): string | undefined {
  if (typeof notification.tag === 'string' && notification.tag.length > 0) return notification.tag;
  const data: unknown = notification.data;
  if (typeof data !== 'object' || data === null) return undefined;
  const conversationId = (data as Record<string, unknown>)['conversationId'];
  return typeof conversationId === 'string' ? conversationId : undefined;
}

let lastRegistrationOutcome: RegistrationOutcome = 'not-attempted';

/**
 * Sends this device's FCM token to the server.
 *
 * Fire-and-forget by shape, not by neglect: the Capacitor `registration`
 * listener that carries the token is a synchronous event sink with nothing to
 * await, so the result is recorded for
 * {@link nativeNotificationChannel.getLastRegistrationOutcome} instead of
 * returned. Nothing here rejects, so the listener cannot leave one unhandled.
 */
export function registerNativeDeviceToken(token: string): void {
  // The route takes `ios` | `android`; `android-direct` is the same platform
  // reached without the Play Store, and registers as `android`.
  const platform: 'ios' | 'android' = getPlatform() === 'ios' ? 'ios' : 'android';
  void (async (): Promise<void> => {
    lastRegistrationOutcome = await sendRegistration(() =>
      fetchJson(client.notifications['device-tokens'].$post({ json: { token, platform } }))
    );
  })();
}

/**
 * Records the platform refusing to register this device at all.
 *
 * The refusal arrives on its own platform event and never reaches the token
 * listener, so no POST is attempted and nothing else would move the outcome off
 * `not-attempted` — a device that can never receive a notification would read
 * as one that simply has not registered yet.
 *
 * Recorded as retryable because the outcome union offers no third reading: a
 * refusal rooted in the device's push entitlement will not clear on a later
 * launch, which the retry copy overstates and the alternative understates.
 */
export function recordNativeRegistrationFailure(): void {
  lastRegistrationOutcome = 'failed-retryable';
}

/**
 * `PushNotifications.register()` is what makes the platform mint a token; the
 * token itself arrives on the `registration` listener the Capacitor shell keeps
 * mounted, which is where {@link registerNativeDeviceToken} sends it on.
 */
export const nativeNotificationChannel: NotificationChannel = {
  getLastRegistrationOutcome: (): RegistrationOutcome => lastRegistrationOutcome,

  getPermissionState: async (): Promise<PushPermissionState> => {
    const { receive } = await PushNotifications.checkPermissions();
    return toPermissionState(receive);
  },

  requestPermissionAndRegister: async (): Promise<PushPermissionState> => {
    const { receive } = await PushNotifications.requestPermissions();
    const state = toPermissionState(receive);
    if (state === 'granted') await PushNotifications.register();
    return state;
  },

  ensureRegistered: async (): Promise<void> => {
    const { receive } = await PushNotifications.checkPermissions();
    if (toPermissionState(receive) !== 'granted') return;
    await PushNotifications.register();
  },

  unregister: async (): Promise<void> => {
    // Drops the platform registration, so the next send gets an UNREGISTERED
    // response and the server prunes the row through its one dead-token path.
    await PushNotifications.unregister();
  },

  clearDelivered: async (conversationIds: readonly string[]): Promise<void> => {
    if (conversationIds.length === 0) return;
    const targets = new Set(conversationIds);
    const { notifications } = await PushNotifications.getDeliveredNotifications();
    const matching = notifications.filter((notification) => {
      const conversationId = deliveredConversationId(notification);
      return conversationId !== undefined && targets.has(conversationId);
    });
    if (matching.length === 0) return;
    await PushNotifications.removeDeliveredNotifications({ notifications: matching });
  },
};
