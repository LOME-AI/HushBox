import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fromBase64 } from '@hushbox/shared';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { registerPushServiceWorker } from '@/lib/platform/register-sw';
import { client, fetchJson } from '@/lib/api-client';
import { webNotificationChannel } from './web-adapter.js';

vi.mock('@/lib/platform/register-sw', () => ({ registerPushServiceWorker: vi.fn() }));
vi.mock('@/lib/api-client', () => ({
  fetchJson: vi.fn(() => Promise.resolve({ registered: true })),
  client: {
    notifications: {
      'web-subscriptions': { $post: vi.fn() },
      'device-tokens': { ':token': { $delete: vi.fn() } },
    },
  },
}));

const registerSw = vi.mocked(registerPushServiceWorker);
const post = vi.mocked(client.notifications['web-subscriptions'].$post);
const del = vi.mocked(client.notifications['device-tokens'][':token'].$delete);

const SUBSCRIPTION_JSON = {
  endpoint: 'https://push.example.com/abc',
  keys: { p256dh: 'BPublicKey', auth: 'AuthSecret' },
};

/** The configured VAPID public key (base64url) and the key of a retired pair. */
const VAPID_PUBLIC_KEY = 'BOeIadxzr8jCEiJstuK2';
const RETIRED_VAPID_PUBLIC_KEY = 'BRetiredKeyBytesXXXX';

function keyBytes(base64url: string): ArrayBuffer {
  return new Uint8Array(fromBase64(base64url)).buffer;
}

interface FakeSubscription {
  endpoint: string;
  options: { applicationServerKey: ArrayBuffer | null };
  toJSON: () => typeof SUBSCRIPTION_JSON;
  unsubscribe: () => Promise<boolean>;
}

function fakeSubscription(
  overrides: {
    unsubscribe?: () => Promise<boolean>;
    applicationServerKey?: ArrayBuffer | null;
    json?: typeof SUBSCRIPTION_JSON;
  } = {}
): FakeSubscription {
  const json = overrides.json ?? SUBSCRIPTION_JSON;
  return {
    endpoint: json.endpoint,
    options: {
      applicationServerKey:
        overrides.applicationServerKey === undefined
          ? keyBytes(VAPID_PUBLIC_KEY)
          : overrides.applicationServerKey,
    },
    toJSON: () => json,
    unsubscribe: overrides.unsubscribe ?? vi.fn(() => Promise.resolve(true)),
  };
}

interface PushManagerStub {
  getSubscription: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

interface NotificationStub {
  tag: string;
  close: ReturnType<typeof vi.fn>;
}

function fakeNotification(tag: string): NotificationStub {
  return { tag, close: vi.fn() };
}

function stubSupportedBrowser(
  options: {
    permission?: NotificationPermission;
    pushManager?: PushManagerStub;
    delivered?: NotificationStub[];
  } = {}
): {
  pushManager: PushManagerStub;
  requestPermission: ReturnType<typeof vi.fn>;
  getNotifications: ReturnType<typeof vi.fn>;
} {
  const pushManager: PushManagerStub = options.pushManager ?? {
    getSubscription: vi.fn(() => Promise.resolve(null)),
    subscribe: vi.fn(() => Promise.resolve(fakeSubscription())),
  };
  const getNotifications = vi.fn(() => Promise.resolve(options.delivered ?? []));
  const registration = { pushManager, getNotifications };
  const requestPermission = vi.fn(() => Promise.resolve('granted'));
  vi.stubGlobal('PushManager', {});
  vi.stubGlobal('Notification', {
    permission: options.permission ?? 'default',
    requestPermission,
  });
  vi.stubGlobal('navigator', {
    serviceWorker: {
      ready: Promise.resolve(registration),
      getRegistration: vi.fn(() => Promise.resolve(registration)),
      register: vi.fn(),
    },
  });
  registerSw.mockResolvedValue(registration as unknown as ServiceWorkerRegistration);
  return { pushManager, requestPermission, getNotifications };
}

describe('webNotificationChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', VAPID_PUBLIC_KEY);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  describe('getLastRegistrationOutcome', () => {
    /**
     * The outcome is module state, so each case drives it from a fresh module
     * graph rather than from whatever the previous case left. The failure class
     * comes from that same graph: a reset mints a second `ApiError` class, and
     * the adapter's `instanceof` only recognizes its own.
     */
    async function loadAdapter(): Promise<{
      channel: typeof webNotificationChannel;
      fetchJson: ReturnType<typeof vi.fn>;
      registerPushSw: typeof registerSw;
      failure: typeof import('@/lib/api/api').ApiError;
    }> {
      vi.resetModules();
      const apiClient = await import('@/lib/api-client');
      const api = await import('@/lib/api/api');
      const platform = await import('@/lib/platform/register-sw');
      const adapter = await import('./web-adapter.js');
      vi.mocked(apiClient.client.notifications['web-subscriptions'].$post).mockReturnValue(
        undefined as never
      );
      return {
        channel: adapter.webNotificationChannel,
        fetchJson: vi.mocked(apiClient.fetchJson),
        registerPushSw: vi.mocked(platform.registerPushServiceWorker),
        failure: api.ApiError,
      };
    }

    it('reports no attempt before this device has registered', async () => {
      const { channel } = await loadAdapter();

      expect(channel.getLastRegistrationOutcome()).toBe('not-attempted');
    });

    it('records a posted subscription as a success', async () => {
      const { channel } = await loadAdapter();
      stubSupportedBrowser({ permission: 'granted' });

      await channel.ensureRegistered();

      expect(channel.getLastRegistrationOutcome()).toBe('succeeded');
    });

    it('records a failed POST without failing the caller', async () => {
      const { channel, fetchJson } = await loadAdapter();
      stubSupportedBrowser({ permission: 'granted' });
      fetchJson.mockRejectedValueOnce(new Error('offline'));

      await expect(channel.ensureRegistered()).resolves.toBeUndefined();
      expect(channel.getLastRegistrationOutcome()).toBe('failed-retryable');
    });

    it('records a subscription held by another account as terminal', async () => {
      const { channel, fetchJson, failure } = await loadAdapter();
      stubSupportedBrowser({ permission: 'granted' });
      fetchJson.mockRejectedValueOnce(new failure('CONFLICT', 409, undefined));

      await channel.ensureRegistered();

      expect(channel.getLastRegistrationOutcome()).toBe('failed-terminal');
    });

    it('records a registration with no service worker to subscribe through', async () => {
      const { channel, fetchJson, registerPushSw } = await loadAdapter();
      stubSupportedBrowser({ permission: 'granted' });
      registerPushSw.mockResolvedValue(null);

      await channel.ensureRegistered();

      expect(fetchJson).not.toHaveBeenCalled();
      expect(channel.getLastRegistrationOutcome()).toBe('failed-retryable');
    });

    it('records a subscribe the browser refuses', async () => {
      const { channel, fetchJson } = await loadAdapter();
      stubSupportedBrowser({
        permission: 'granted',
        pushManager: {
          getSubscription: vi.fn(() => Promise.resolve(null)),
          subscribe: vi.fn(() => Promise.reject(new Error('NotAllowedError'))),
        },
      });

      await expect(channel.ensureRegistered()).rejects.toThrow();

      expect(fetchJson).not.toHaveBeenCalled();
      expect(channel.getLastRegistrationOutcome()).toBe('failed-retryable');
    });

    it('records a subscription that fails validation before it is posted', async () => {
      const { channel, fetchJson } = await loadAdapter();
      stubSupportedBrowser({
        permission: 'granted',
        pushManager: {
          getSubscription: vi.fn(() => Promise.resolve(null)),
          subscribe: vi.fn(() =>
            Promise.resolve(fakeSubscription({ json: { ...SUBSCRIPTION_JSON, endpoint: '' } }))
          ),
        },
      });

      await expect(channel.ensureRegistered()).rejects.toThrow();

      expect(fetchJson).not.toHaveBeenCalled();
      expect(channel.getLastRegistrationOutcome()).toBe('failed-retryable');
    });

    it('records a missing VAPID key while still raising it to the caller', async () => {
      const { channel } = await loadAdapter();
      vi.stubEnv('VITE_VAPID_PUBLIC_KEY', '');
      stubSupportedBrowser({ permission: 'granted' });

      await expect(channel.ensureRegistered()).rejects.toThrow();

      expect(channel.getLastRegistrationOutcome()).toBe('failed-retryable');
    });

    it('reports no attempt on a load where registration never runs', async () => {
      const { channel, fetchJson } = await loadAdapter();
      stubSupportedBrowser({ permission: 'default' });

      await channel.ensureRegistered();

      expect(fetchJson).not.toHaveBeenCalled();
      expect(channel.getLastRegistrationOutcome()).toBe('not-attempted');
    });
  });

  describe('getPermissionState', () => {
    it('reports unsupported when the browser has no PushManager', async () => {
      vi.stubGlobal('Notification', { permission: 'default' });
      vi.stubGlobal('navigator', { serviceWorker: {} });

      expect(await webNotificationChannel.getPermissionState()).toBe('unsupported');
    });

    it('reports unsupported when the browser has no service worker', async () => {
      vi.stubGlobal('PushManager', {});
      vi.stubGlobal('Notification', { permission: 'default' });
      vi.stubGlobal('navigator', {});

      expect(await webNotificationChannel.getPermissionState()).toBe('unsupported');
    });

    it('reports unsupported when the browser has no Notification API', async () => {
      vi.stubGlobal('PushManager', {});
      vi.stubGlobal('navigator', { serviceWorker: {} });

      expect(await webNotificationChannel.getPermissionState()).toBe('unsupported');
    });

    it('mirrors the browser permission when push is supported', async () => {
      stubSupportedBrowser({ permission: 'granted' });

      expect(await webNotificationChannel.getPermissionState()).toBe('granted');
    });
  });

  describe('requestPermissionAndRegister', () => {
    it('does not ask an unsupported browser for permission', async () => {
      vi.stubGlobal('navigator', {});

      expect(await webNotificationChannel.requestPermissionAndRegister()).toBe('unsupported');
      expect(registerSw).not.toHaveBeenCalled();
    });

    it('subscribes with the VAPID key and posts the subscription on grant', async () => {
      const { pushManager, requestPermission } = stubSupportedBrowser();

      const state = await webNotificationChannel.requestPermissionAndRegister();

      expect(state).toBe('granted');
      expect(requestPermission).toHaveBeenCalled();
      expect(pushManager.subscribe).toHaveBeenCalledWith({
        userVisibleOnly: true,
        applicationServerKey: expect.any(Uint8Array),
      });
      expect(post).toHaveBeenCalledWith({ json: SUBSCRIPTION_JSON });
      expect(fetchJson).toHaveBeenCalled();
    });

    it('does not subscribe when the user denies permission', async () => {
      const { pushManager, requestPermission } = stubSupportedBrowser();
      requestPermission.mockResolvedValue('denied');

      expect(await webNotificationChannel.requestPermissionAndRegister()).toBe('denied');
      expect(pushManager.subscribe).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });

    it('reuses an existing subscription made under the configured VAPID key', async () => {
      const existing = fakeSubscription({ applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
      const pushManager: PushManagerStub = {
        getSubscription: vi.fn(() => Promise.resolve(existing)),
        subscribe: vi.fn(),
      };
      stubSupportedBrowser({ pushManager });

      await webNotificationChannel.requestPermissionAndRegister();

      expect(pushManager.subscribe).not.toHaveBeenCalled();
      expect(existing.unsubscribe).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith({ json: SUBSCRIPTION_JSON });
    });

    it('replaces an existing subscription made under a different VAPID key', async () => {
      const fresh = fakeSubscription({
        json: { ...SUBSCRIPTION_JSON, endpoint: 'https://push.example.com/fresh' },
      });
      const stale = fakeSubscription({
        applicationServerKey: keyBytes(RETIRED_VAPID_PUBLIC_KEY),
      });
      const pushManager: PushManagerStub = {
        getSubscription: vi.fn(() => Promise.resolve(stale)),
        subscribe: vi.fn(() => Promise.resolve(fresh)),
      };
      stubSupportedBrowser({ pushManager });

      await webNotificationChannel.requestPermissionAndRegister();

      expect(stale.unsubscribe).toHaveBeenCalledTimes(1);
      expect(pushManager.subscribe).toHaveBeenCalledWith({
        userVisibleOnly: true,
        applicationServerKey: new Uint8Array(fromBase64(VAPID_PUBLIC_KEY)),
      });
      expect(post).toHaveBeenCalledWith({ json: fresh.toJSON() });
      expect(post).not.toHaveBeenCalledWith({ json: SUBSCRIPTION_JSON });
    });

    it('replaces an existing subscription whose VAPID key is unknown', async () => {
      const fresh = fakeSubscription({
        json: { ...SUBSCRIPTION_JSON, endpoint: 'https://push.example.com/fresh' },
      });
      const unknown = fakeSubscription({ applicationServerKey: null });
      const pushManager: PushManagerStub = {
        getSubscription: vi.fn(() => Promise.resolve(unknown)),
        subscribe: vi.fn(() => Promise.resolve(fresh)),
      };
      stubSupportedBrowser({ pushManager });

      await webNotificationChannel.requestPermissionAndRegister();

      expect(unknown.unsubscribe).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith({ json: fresh.toJSON() });
    });

    it('fails fast when the VAPID public key is missing from the environment', async () => {
      vi.stubEnv('VITE_VAPID_PUBLIC_KEY', '');
      stubSupportedBrowser();

      await expect(webNotificationChannel.requestPermissionAndRegister()).rejects.toThrow();
    });

    it('skips registration when the service worker is unavailable', async () => {
      stubSupportedBrowser();
      registerSw.mockResolvedValue(null);

      expect(await webNotificationChannel.requestPermissionAndRegister()).toBe('granted');
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('ensureRegistered', () => {
    it('re-posts the existing subscription when permission is already granted', async () => {
      const pushManager: PushManagerStub = {
        getSubscription: vi.fn(() => Promise.resolve(fakeSubscription())),
        subscribe: vi.fn(),
      };
      const { requestPermission } = stubSupportedBrowser({ permission: 'granted', pushManager });

      await webNotificationChannel.ensureRegistered();

      expect(requestPermission).not.toHaveBeenCalled();
      expect(post).toHaveBeenCalledWith({ json: SUBSCRIPTION_JSON });
    });

    it('does nothing when permission has not been granted', async () => {
      stubSupportedBrowser({ permission: 'default' });

      await webNotificationChannel.ensureRegistered();

      expect(registerSw).not.toHaveBeenCalled();
      expect(post).not.toHaveBeenCalled();
    });
  });

  describe('unregister', () => {
    it('deletes the server row and unsubscribes locally', async () => {
      const unsubscribe = vi.fn(() => Promise.resolve(true));
      const pushManager: PushManagerStub = {
        getSubscription: vi.fn(() => Promise.resolve(fakeSubscription({ unsubscribe }))),
        subscribe: vi.fn(),
      };
      stubSupportedBrowser({ permission: 'granted', pushManager });

      await webNotificationChannel.unregister();

      expect(del).toHaveBeenCalledWith({
        param: { token: encodeURIComponent(SUBSCRIPTION_JSON.endpoint) },
      });
      expect(unsubscribe).toHaveBeenCalled();
    });

    it('still unsubscribes locally when the server delete fails', async () => {
      const unsubscribe = vi.fn(() => Promise.resolve(true));
      const pushManager: PushManagerStub = {
        getSubscription: vi.fn(() => Promise.resolve(fakeSubscription({ unsubscribe }))),
        subscribe: vi.fn(),
      };
      stubSupportedBrowser({ permission: 'granted', pushManager });
      vi.mocked(fetchJson).mockRejectedValueOnce(new Error('offline'));

      await webNotificationChannel.unregister();

      expect(unsubscribe).toHaveBeenCalled();
    });

    it('is a no-op when nothing is subscribed', async () => {
      stubSupportedBrowser({ permission: 'granted' });

      await webNotificationChannel.unregister();

      expect(del).not.toHaveBeenCalled();
    });

    it('is a no-op when no service worker is registered', async () => {
      stubSupportedBrowser({ permission: 'granted' });
      vi.stubGlobal('navigator', {
        serviceWorker: { getRegistration: vi.fn(() => Promise.resolve()) },
      });

      await webNotificationChannel.unregister();

      expect(del).not.toHaveBeenCalled();
    });

    it('is a no-op on an unsupported browser', async () => {
      vi.stubGlobal('navigator', {});

      await webNotificationChannel.unregister();

      expect(del).not.toHaveBeenCalled();
    });
  });

  describe('clearDelivered', () => {
    // The notification tag is the raw conversationId the worker set at show
    // time — a device-local value. Nothing here derives or consumes a
    // server-side collapse alias.
    const CONVERSATION_ID = testUuidV7(1);
    const OTHER_ID = testUuidV7(2);

    it('closes notifications tagged with the given conversation id', async () => {
      const mine = fakeNotification(CONVERSATION_ID);
      stubSupportedBrowser({ delivered: [mine] });

      await webNotificationChannel.clearDelivered([CONVERSATION_ID]);

      expect(mine.close).toHaveBeenCalledTimes(1);
    });

    it('leaves notifications for other conversations showing', async () => {
      const mine = fakeNotification(CONVERSATION_ID);
      const other = fakeNotification(OTHER_ID);
      stubSupportedBrowser({ delivered: [mine, other] });

      await webNotificationChannel.clearDelivered([CONVERSATION_ID]);

      expect(mine.close).toHaveBeenCalledTimes(1);
      expect(other.close).not.toHaveBeenCalled();
    });

    it('clears every conversation it is given in one pass', async () => {
      const mine = fakeNotification(CONVERSATION_ID);
      const other = fakeNotification(OTHER_ID);
      const { getNotifications } = stubSupportedBrowser({ delivered: [mine, other] });

      await webNotificationChannel.clearDelivered([CONVERSATION_ID, OTHER_ID]);

      expect(getNotifications).toHaveBeenCalledTimes(1);
      expect(mine.close).toHaveBeenCalledTimes(1);
      expect(other.close).toHaveBeenCalledTimes(1);
    });

    it('does not touch the notification list when asked to clear nothing', async () => {
      const { getNotifications } = stubSupportedBrowser();

      await webNotificationChannel.clearDelivered([]);

      expect(getNotifications).not.toHaveBeenCalled();
    });

    it('is a no-op when no service worker is registered', async () => {
      stubSupportedBrowser();
      vi.stubGlobal('navigator', {
        serviceWorker: { getRegistration: vi.fn(() => Promise.resolve()) },
      });

      await expect(
        webNotificationChannel.clearDelivered([CONVERSATION_ID])
      ).resolves.toBeUndefined();
    });

    it('is a no-op on an unsupported browser', async () => {
      vi.stubGlobal('navigator', {});

      await expect(
        webNotificationChannel.clearDelivered([CONVERSATION_ID])
      ).resolves.toBeUndefined();
    });
  });
});
