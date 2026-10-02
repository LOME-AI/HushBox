import { z } from 'zod';
import { client, fetchJson } from '@/lib/api-client';
import { registerPushServiceWorker } from '@/lib/platform/register-sw';
import { applicationServerKey, matchesApplicationServerKey } from './application-server-key.js';
import { sendRegistration } from './registration.js';
import type { NotificationChannel, PushPermissionState, RegistrationOutcome } from './types.js';

/**
 * The browser's own subscription shape, re-validated before it is sent. The
 * DOM types declare `endpoint` and `keys` as optional, and a subscription
 * missing either is unusable — rejecting it here fails at the seam instead of
 * posting a half-formed row.
 */
const subscriptionSchema = z.object({
  endpoint: z.string().min(1),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

function isSupported(): boolean {
  return (
    'Notification' in globalThis &&
    'PushManager' in globalThis &&
    'serviceWorker' in globalThis.navigator
  );
}

/**
 * The activated registration, or `null` where there is no service worker to
 * use. `register()` resolves before the worker activates and `subscribe()`
 * needs an active worker, hence the wait on `ready`.
 */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  const registration = await registerPushServiceWorker();
  if (registration === null) return null;
  return navigator.serviceWorker.ready;
}

let lastRegistrationOutcome: RegistrationOutcome = 'not-attempted';

async function postSubscription(subscription: PushSubscription): Promise<void> {
  const body = subscriptionSchema.parse(subscription.toJSON());
  lastRegistrationOutcome = await sendRegistration(() =>
    fetchJson(client.notifications['web-subscriptions'].$post({ json: body }))
  );
}

async function subscribeAndRegister(): Promise<void> {
  try {
    await subscribeAndPost();
  } catch (error) {
    // Everything before the POST fails this way, and the device is as unable to
    // receive a notification as it would be with a refused POST. Recording is
    // not swallowing: the failure still reaches the caller.
    lastRegistrationOutcome = 'failed-retryable';
    throw error;
  }
}

async function subscribeAndPost(): Promise<void> {
  const registration = await activeRegistration();
  if (registration === null) {
    lastRegistrationOutcome = 'failed-retryable';
    return;
  }
  const key = applicationServerKey();
  const existing = await registration.pushManager.getSubscription();
  if (
    existing !== null &&
    matchesApplicationServerKey(existing.options.applicationServerKey, key)
  ) {
    await postSubscription(existing);
    return;
  }
  // Released first: subscribing under a different key while one stands is an
  // InvalidStateError, not a replacement.
  if (existing !== null) await existing.unsubscribe();
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  await postSubscription(subscription);
}

async function currentSubscription(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration();
  if (registration === undefined) return null;
  return registration.pushManager.getSubscription();
}

export const webNotificationChannel: NotificationChannel = {
  getLastRegistrationOutcome: (): RegistrationOutcome => lastRegistrationOutcome,

  getPermissionState: (): Promise<PushPermissionState> =>
    Promise.resolve(isSupported() ? Notification.permission : 'unsupported'),

  requestPermissionAndRegister: async (): Promise<PushPermissionState> => {
    if (!isSupported()) return 'unsupported';
    const permission = await Notification.requestPermission();
    if (permission === 'granted') await subscribeAndRegister();
    return permission;
  },

  ensureRegistered: async (): Promise<void> => {
    if (!isSupported() || Notification.permission !== 'granted') return;
    await subscribeAndRegister();
  },

  unregister: async (): Promise<void> => {
    if (!isSupported()) return;
    const subscription = await currentSubscription();
    if (subscription === null) return;
    try {
      await fetchJson(
        client.notifications['device-tokens'][':token'].$delete({
          // The subscription endpoint is this device's token, and it is a URL:
          // it has to be encoded to survive as a single path segment.
          param: { token: encodeURIComponent(subscription.endpoint) },
        })
      );
    } catch {
      // Best-effort: the local unsubscribe below must still run, and delivery
      // to a gone subscription is pruned reactively server-side.
    }
    await subscription.unsubscribe();
  },

  clearDelivered: async (conversationIds: readonly string[]): Promise<void> => {
    if (!isSupported() || conversationIds.length === 0) return;
    const registration = await navigator.serviceWorker.getRegistration();
    if (registration === undefined) return;
    const targets = new Set(conversationIds);
    // One list read covers every id — the whole point of clearing in batches
    // when the app comes back to the foreground.
    for (const notification of await registration.getNotifications()) {
      if (targets.has(notification.tag)) notification.close();
    }
  },
};
