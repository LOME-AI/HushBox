import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

type RegistrationCallback = (token: { value: string }) => void;
type NotificationCallback = (notification: {
  notification: { title: string; body: string; data: Record<string, string> };
}) => void;
type RegistrationErrorCallback = (event: { error: string }) => void;
type PluginCallback = RegistrationCallback | NotificationCallback | RegistrationErrorCallback;

let registrationCallback: RegistrationCallback | null = null;
let actionCallback: NotificationCallback | null = null;
let registrationErrorCallback: RegistrationErrorCallback | null = null;
/** One entry per attached listener, so a case can ask whether all of them were dropped. */
const removals: ReturnType<typeof vi.fn>[] = [];

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    requestPermissions: vi.fn(() => Promise.resolve({ receive: 'granted' })),
    register: vi.fn(() => Promise.resolve()),
    addListener: vi.fn((event: string, callback: PluginCallback) => {
      if (event === 'registration') {
        registrationCallback = callback as RegistrationCallback;
      }
      if (event === 'pushNotificationActionPerformed') {
        actionCallback = callback as NotificationCallback;
      }
      if (event === 'registrationError') {
        registrationErrorCallback = callback as RegistrationErrorCallback;
      }
      const remove = vi.fn(() => Promise.resolve());
      removals.push(remove);
      return Promise.resolve({ remove });
    }),
  },
}));

vi.mock('@capacitor-community/fcm', () => ({
  FCM: {
    getToken: vi.fn(() => Promise.resolve({ token: 'fcm-token-from-firebase' })),
  },
}));

vi.mock('../platform.js', () => ({
  isNative: vi.fn(() => false),
  getPlatform: vi.fn(() => 'android'),
}));

describe('usePushNotifications', () => {
  beforeEach(() => {
    registrationCallback = null;
    actionCallback = null;
    registrationErrorCallback = null;
    removals.length = 0;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing on web', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(false);

    const { PushNotifications } = await import('@capacitor/push-notifications');
    const { usePushNotifications } = await import('./use-push-notifications.js');

    renderHook(() => {
      usePushNotifications();
    });

    expect(PushNotifications.addListener).not.toHaveBeenCalled();
    expect(PushNotifications.requestPermissions).not.toHaveBeenCalled();
  });

  it('never asks for permission on mount', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { PushNotifications } = await import('@capacitor/push-notifications');
    const { usePushNotifications } = await import('./use-push-notifications.js');

    renderHook(() => {
      usePushNotifications();
    });

    await vi.waitFor(() => {
      expect(PushNotifications.addListener).toHaveBeenCalled();
    });
    expect(PushNotifications.requestPermissions).not.toHaveBeenCalled();
    expect(PushNotifications.register).not.toHaveBeenCalled();
  });

  it('forwards the registration event token on Android', async () => {
    const { isNative, getPlatform } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
    vi.mocked(getPlatform).mockReturnValue('android');

    const onTokenReceived = vi.fn();
    const { usePushNotifications } = await import('./use-push-notifications.js');

    renderHook(() => {
      usePushNotifications({ onTokenReceived });
    });

    expect(registrationCallback).not.toBeNull();
    registrationCallback!({ value: 'android-fcm-token' });

    expect(onTokenReceived).toHaveBeenCalledWith('android-fcm-token');
  });

  it('exchanges the APNs token for an FCM token on iOS', async () => {
    const { isNative, getPlatform } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
    vi.mocked(getPlatform).mockReturnValue('ios');

    const { FCM } = await import('@capacitor-community/fcm');
    const onTokenReceived = vi.fn();
    const { usePushNotifications } = await import('./use-push-notifications.js');

    renderHook(() => {
      usePushNotifications({ onTokenReceived });
    });

    expect(registrationCallback).not.toBeNull();
    // The registration event carries the raw APNs token on iOS; it must be
    // ignored in favour of the FCM token.
    registrationCallback!({ value: 'raw-apns-token' });

    await vi.waitFor(() => {
      expect(FCM.getToken).toHaveBeenCalled();
      expect(onTokenReceived).toHaveBeenCalledWith('fcm-token-from-firebase');
    });
    expect(onTokenReceived).not.toHaveBeenCalledWith('raw-apns-token');
  });

  it('logs and skips registration when the iOS FCM token lookup fails', async () => {
    const { isNative, getPlatform } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
    vi.mocked(getPlatform).mockReturnValue('ios');

    const { FCM } = await import('@capacitor-community/fcm');
    vi.mocked(FCM.getToken).mockRejectedValueOnce(new Error('no apns token'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const onTokenReceived = vi.fn();
    const { usePushNotifications } = await import('./use-push-notifications.js');

    renderHook(() => {
      usePushNotifications({ onTokenReceived });
    });

    expect(registrationCallback).not.toBeNull();
    registrationCallback!({ value: 'raw-apns-token' });

    await vi.waitFor(() => {
      expect(errorSpy).toHaveBeenCalled();
    });
    expect(onTokenReceived).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('calls onNotificationTap when user taps a notification', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onNotificationTap = vi.fn();
    const { usePushNotifications } = await import('./use-push-notifications.js');

    renderHook(() => {
      usePushNotifications({ onNotificationTap });
    });

    expect(actionCallback).not.toBeNull();
    actionCallback!({
      notification: {
        title: 'New message',
        body: 'Hey there',
        data: { conversationId: 'conv-456' },
      },
    });

    expect(onNotificationTap).toHaveBeenCalledWith({
      conversationId: 'conv-456',
    });
  });

  it('forwards the platform refusing to register this device', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onRegistrationError = vi.fn();
    const { usePushNotifications } = await import('./use-push-notifications.js');

    renderHook(() => {
      usePushNotifications({ onRegistrationError });
    });

    expect(registrationErrorCallback).not.toBeNull();
    registrationErrorCallback!({ error: 'no push entitlement' });

    expect(onRegistrationError).toHaveBeenCalled();
  });

  it('reports no refusal while the platform has refused nothing', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onRegistrationError = vi.fn();
    const { usePushNotifications } = await import('./use-push-notifications.js');

    renderHook(() => {
      usePushNotifications({ onRegistrationError });
    });

    expect(onRegistrationError).not.toHaveBeenCalled();
  });

  it('drops every listener it attached when the shell unmounts', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { PushNotifications } = await import('@capacitor/push-notifications');
    const { usePushNotifications } = await import('./use-push-notifications.js');

    const { unmount } = renderHook(() => {
      usePushNotifications();
    });
    const attached = vi.mocked(PushNotifications.addListener).mock.calls.length;
    unmount();

    expect(attached).toBeGreaterThan(0);
    await vi.waitFor(() => {
      expect(removals.filter((remove) => remove.mock.calls.length > 0)).toHaveLength(attached);
    });
  });
});
