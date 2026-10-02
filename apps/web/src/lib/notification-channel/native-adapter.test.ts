import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PushNotifications } from '@capacitor/push-notifications';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { nativeNotificationChannel } from './native-adapter.js';

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    checkPermissions: vi.fn(() => Promise.resolve({ receive: 'prompt' })),
    requestPermissions: vi.fn(() => Promise.resolve({ receive: 'granted' })),
    register: vi.fn(() => Promise.resolve()),
    unregister: vi.fn(() => Promise.resolve()),
    getDeliveredNotifications: vi.fn(() => Promise.resolve({ notifications: [] })),
    removeDeliveredNotifications: vi.fn(() => Promise.resolve()),
  },
}));

vi.mock('@/capacitor/platform', () => ({ getPlatform: vi.fn(() => 'android') }));
vi.mock('@/lib/api-client', () => ({
  fetchJson: vi.fn(() => Promise.resolve({ registered: true })),
  client: { notifications: { 'device-tokens': { $post: vi.fn() } } },
}));

const push = vi.mocked(PushNotifications);

/**
 * The registration outcome is module state, so each case below drives it from
 * a fresh module graph rather than from whatever the previous case left. The
 * failure class comes from that same graph: a reset mints a second `ApiError`
 * class, and the adapter's `instanceof` only recognizes its own.
 */
async function loadAdapter(): Promise<{
  channel: typeof nativeNotificationChannel;
  register: (token: string) => void;
  post: ReturnType<typeof vi.fn>;
  fetchJson: ReturnType<typeof vi.fn>;
  setPlatform: (platform: string) => void;
  failure: typeof import('@/lib/api/api').ApiError;
  recordFailure: typeof import('./native-adapter.js').recordNativeRegistrationFailure;
}> {
  vi.resetModules();
  const apiClient = await import('@/lib/api-client');
  const platform = await import('@/capacitor/platform');
  const api = await import('@/lib/api/api');
  const adapter = await import('./native-adapter.js');
  return {
    channel: adapter.nativeNotificationChannel,
    register: adapter.registerNativeDeviceToken,
    post: vi.mocked(apiClient.client.notifications['device-tokens'].$post),
    fetchJson: vi.mocked(apiClient.fetchJson),
    setPlatform: (value) => {
      vi.mocked(platform.getPlatform).mockReturnValue(
        value as ReturnType<typeof platform.getPlatform>
      );
    },
    failure: api.ApiError,
    recordFailure: adapter.recordNativeRegistrationFailure,
  };
}

describe('nativeNotificationChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('getPermissionState', () => {
    it.each([
      ['granted', 'granted'],
      ['denied', 'denied'],
      ['prompt', 'default'],
      ['prompt-with-rationale', 'default'],
    ] as const)('maps the %s OS permission to %s', async (receive, expected) => {
      push.checkPermissions.mockResolvedValue({ receive });

      expect(await nativeNotificationChannel.getPermissionState()).toBe(expected);
    });

    it('never prompts', async () => {
      await nativeNotificationChannel.getPermissionState();

      expect(push.requestPermissions).not.toHaveBeenCalled();
    });
  });

  describe('requestPermissionAndRegister', () => {
    it('registers for remote notifications once permission is granted', async () => {
      push.requestPermissions.mockResolvedValue({ receive: 'granted' });

      expect(await nativeNotificationChannel.requestPermissionAndRegister()).toBe('granted');
      expect(push.register).toHaveBeenCalled();
    });

    it('does not register when permission is denied', async () => {
      push.requestPermissions.mockResolvedValue({ receive: 'denied' });

      expect(await nativeNotificationChannel.requestPermissionAndRegister()).toBe('denied');
      expect(push.register).not.toHaveBeenCalled();
    });
  });

  describe('ensureRegistered', () => {
    it('registers when the OS permission is already granted', async () => {
      push.checkPermissions.mockResolvedValue({ receive: 'granted' });

      await nativeNotificationChannel.ensureRegistered();

      expect(push.register).toHaveBeenCalled();
      expect(push.requestPermissions).not.toHaveBeenCalled();
    });

    it('does not register — or prompt — while permission is unresolved', async () => {
      push.checkPermissions.mockResolvedValue({ receive: 'prompt' });

      await nativeNotificationChannel.ensureRegistered();

      expect(push.register).not.toHaveBeenCalled();
      expect(push.requestPermissions).not.toHaveBeenCalled();
    });
  });

  describe('registerNativeDeviceToken', () => {
    it('reports no attempt before a token has arrived', async () => {
      const { channel } = await loadAdapter();

      expect(channel.getLastRegistrationOutcome()).toBe('not-attempted');
    });

    it('posts the token for this platform and records the success', async () => {
      const { channel, register, post } = await loadAdapter();

      register('fcm-token-123');

      await vi.waitFor(() => {
        expect(channel.getLastRegistrationOutcome()).toBe('succeeded');
      });
      expect(post).toHaveBeenCalledWith({
        json: { token: 'fcm-token-123', platform: 'android' },
      });
    });

    it('maps the iOS platform through unchanged', async () => {
      const { register, post, setPlatform } = await loadAdapter();
      setPlatform('ios');

      register('apns-token-1');

      await vi.waitFor(() => {
        expect(post).toHaveBeenCalledWith({ json: { token: 'apns-token-1', platform: 'ios' } });
      });
    });

    it('records a failed POST instead of rejecting at the listener', async () => {
      const { channel, register, fetchJson, failure } = await loadAdapter();
      fetchJson.mockRejectedValueOnce(new failure('INTERNAL', 503, undefined));

      expect(() => {
        register('fcm-token-123');
      }).not.toThrow();

      await vi.waitFor(() => {
        expect(channel.getLastRegistrationOutcome()).toBe('failed-retryable');
      });
    });

    it('records a token held by another account as terminal', async () => {
      const { channel, register, fetchJson, failure } = await loadAdapter();
      fetchJson.mockRejectedValueOnce(new failure('CONFLICT', 409, undefined));

      register('fcm-token-123');

      await vi.waitFor(() => {
        expect(channel.getLastRegistrationOutcome()).toBe('failed-terminal');
      });
    });
  });

  describe('recordNativeRegistrationFailure', () => {
    it('records a platform refusal to register this device', async () => {
      const { channel, recordFailure } = await loadAdapter();

      recordFailure();

      expect(channel.getLastRegistrationOutcome()).toBe('failed-retryable');
    });

    it('overrides a registration that had succeeded earlier in the session', async () => {
      const { channel, register, recordFailure } = await loadAdapter();
      register('fcm-token-123');
      await vi.waitFor(() => {
        expect(channel.getLastRegistrationOutcome()).toBe('succeeded');
      });

      recordFailure();

      expect(channel.getLastRegistrationOutcome()).toBe('failed-retryable');
    });
  });

  it('unregister drops the platform registration', async () => {
    await nativeNotificationChannel.unregister();

    expect(push.unregister).toHaveBeenCalled();
  });

  describe('clearDelivered', () => {
    // A shade entry is addressed by the raw conversation id — never the
    // collapse alias, which stays on the transport headers. Android puts the id
    // in the notification tag and nothing useful in its extras; iOS has no tag
    // and puts the id in the data payload. Each fixture below models one of the
    // two, so neither platform's path can be dropped unnoticed.
    const CONVERSATION_ID = testUuidV7(1);
    const OTHER_ID = testUuidV7(2);

    function delivered(
      notifications: { id: string; tag?: string; data: unknown }[]
    ): ReturnType<typeof vi.fn> {
      return push.getDeliveredNotifications.mockResolvedValue({
        notifications,
      } as Awaited<ReturnType<typeof PushNotifications.getDeliveredNotifications>>);
    }

    it('removes the notification tagged with the conversation id (Android)', async () => {
      // Android extras, which carry no conversation id — the tag is the only
      // thing that can match, and it is what the sender stamps there.
      const mine = { id: '1', tag: CONVERSATION_ID, data: { title: 'Response ready' } };
      delivered([mine, { id: '2', tag: OTHER_ID, data: { title: 'New message' } }]);

      await nativeNotificationChannel.clearDelivered([CONVERSATION_ID]);

      expect(push.removeDeliveredNotifications).toHaveBeenCalledWith({ notifications: [mine] });
    });

    it('matches the conversation id carried in the data payload where no tag exists (iOS)', async () => {
      const mine = { id: '1', data: { conversationId: CONVERSATION_ID } };
      delivered([mine, { id: '2', data: { conversationId: OTHER_ID } }]);

      await nativeNotificationChannel.clearDelivered([CONVERSATION_ID]);

      expect(push.removeDeliveredNotifications).toHaveBeenCalledWith({ notifications: [mine] });
    });

    it('ignores a notification carrying no conversation at all', async () => {
      delivered([
        { id: '1', data: null },
        { id: '2', data: { conversationId: 7 } },
      ]);

      await nativeNotificationChannel.clearDelivered([CONVERSATION_ID]);

      expect(push.removeDeliveredNotifications).not.toHaveBeenCalled();
    });

    it('leaves the shade alone when nothing matches', async () => {
      delivered([{ id: '2', tag: OTHER_ID, data: {} }]);

      await nativeNotificationChannel.clearDelivered([CONVERSATION_ID]);

      expect(push.removeDeliveredNotifications).not.toHaveBeenCalled();
    });

    it('does not read the shade when asked to clear nothing', async () => {
      await nativeNotificationChannel.clearDelivered([]);

      expect(push.getDeliveredNotifications).not.toHaveBeenCalled();
    });
  });
});
