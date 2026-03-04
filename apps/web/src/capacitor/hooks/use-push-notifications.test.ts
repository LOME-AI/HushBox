import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

type RegistrationCallback = (token: { value: string }) => void;
type NotificationCallback = (notification: {
  notification: { title: string; body: string; data: Record<string, string> };
}) => void;

let registrationCallback: RegistrationCallback | null = null;
let actionCallback: NotificationCallback | null = null;

vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    requestPermissions: vi.fn(() => Promise.resolve({ receive: 'granted' })),
    register: vi.fn(() => Promise.resolve()),
    addListener: vi.fn((event: string, callback: RegistrationCallback | NotificationCallback) => {
      if (event === 'registration') {
        registrationCallback = callback as RegistrationCallback;
      }
      if (event === 'pushNotificationActionPerformed') {
        actionCallback = callback as NotificationCallback;
      }
      return Promise.resolve({ remove: vi.fn() });
    }),
  },
}));

vi.mock('../platform.js', () => ({
  isNative: vi.fn(() => false),
}));

describe('usePushNotifications', () => {
  beforeEach(() => {
    registrationCallback = null;
    actionCallback = null;
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

    expect(PushNotifications.requestPermissions).not.toHaveBeenCalled();
  });

  it('requests permissions and registers on native', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { PushNotifications } = await import('@capacitor/push-notifications');
    const { usePushNotifications } = await import('./use-push-notifications.js');

    renderHook(() => {
      usePushNotifications();
    });

    expect(PushNotifications.requestPermissions).toHaveBeenCalled();
    // register is called after permissions resolve
    await vi.waitFor(() => {
      expect(PushNotifications.register).toHaveBeenCalled();
    });
  });

  it('calls onTokenReceived when FCM token arrives', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onTokenReceived = vi.fn();
    const { usePushNotifications } = await import('./use-push-notifications.js');

    renderHook(() => {
      usePushNotifications({ onTokenReceived });
    });

    expect(registrationCallback).not.toBeNull();
    registrationCallback!({ value: 'fcm-token-123' });

    expect(onTokenReceived).toHaveBeenCalledWith('fcm-token-123');
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

  it('does not register when permission is denied', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { PushNotifications } = await import('@capacitor/push-notifications');
    vi.mocked(PushNotifications.requestPermissions).mockResolvedValue({
      receive: 'denied',
    });

    const { usePushNotifications } = await import('./use-push-notifications.js');

    renderHook(() => {
      usePushNotifications();
    });

    // Wait for the async permission check to resolve
    await vi.waitFor(() => {
      expect(PushNotifications.requestPermissions).toHaveBeenCalled();
    });

    expect(PushNotifications.register).not.toHaveBeenCalled();
  });
});
