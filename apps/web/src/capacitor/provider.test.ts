import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import * as React from 'react';
import { testUuidV7 } from '@hushbox/shared/test-time';

const mockNavigate = vi.fn();

vi.mock('./hooks/use-back-button.js', () => ({
  useBackButton: vi.fn(),
}));
vi.mock('./hooks/use-deep-links.js', () => ({
  useDeepLinks: vi.fn(),
}));
const { useAppLifecycleMock, lifecycleCallbacks, disposePredictionSession } = vi.hoisted(() => {
  const callbacks: ({ onPause?: () => void } | undefined)[] = [];
  return {
    lifecycleCallbacks: callbacks,
    disposePredictionSession: vi.fn(),
    useAppLifecycleMock: vi.fn((registered?: { onPause?: () => void }) => {
      callbacks.push(registered);
    }),
  };
});

vi.mock('./hooks/use-app-lifecycle.js', () => ({
  useAppLifecycle: useAppLifecycleMock,
}));
// The prediction disposal hook reaches the same module through the alias, which
// resolves to the same file but is a second specifier for the mock registry.
vi.mock('@/capacitor/hooks/use-app-lifecycle', () => ({
  useAppLifecycle: useAppLifecycleMock,
}));
vi.mock('@/lib/prediction/prediction-session', () => ({ disposePredictionSession }));
vi.mock('./hooks/use-network-status.js', () => ({
  useNetworkStatus: vi.fn(() => ({ isOffline: false })),
}));
vi.mock('./hooks/use-splash-screen.js', () => ({
  useSplashScreen: vi.fn(),
}));
vi.mock('./hooks/use-push-notifications.js', () => ({
  usePushNotifications: vi.fn(),
}));
vi.mock('./hooks/use-live-update.js', () => ({
  useLiveUpdate: vi.fn(),
}));
vi.mock('@tanstack/react-router', () => ({
  useNavigate: vi.fn(() => mockNavigate),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock factory
const mockPostDeviceToken = vi.fn((): any => Promise.resolve(new Response('{}', { status: 201 })));
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mock factory
const mockFetchJson = vi.fn((): any => Promise.resolve({ registered: true }));
// The token now leaves through the notification channel, which reaches the api
// client and the platform module through the alias — a second specifier for the
// mock registry, and so a second registration over the same functions.
vi.mock('../lib/api-client.js', () => ({
  client: { notifications: { 'device-tokens': { $post: mockPostDeviceToken } } },
  fetchJson: mockFetchJson,
}));
vi.mock('@/lib/api-client', () => ({
  client: { notifications: { 'device-tokens': { $post: mockPostDeviceToken } } },
  fetchJson: mockFetchJson,
}));
const { mockGetPlatform } = vi.hoisted(() => ({ mockGetPlatform: vi.fn(() => 'android') }));
vi.mock('./platform.js', () => ({
  getPlatform: mockGetPlatform,
  isNative: vi.fn(() => true),
  isPaymentDisabled: vi.fn(() => false),
}));
vi.mock('@/capacitor/platform', () => ({
  getPlatform: mockGetPlatform,
  isNative: vi.fn(() => true),
  isPaymentDisabled: vi.fn(() => false),
}));

describe('CapacitorProvider', () => {
  afterEach(() => {
    vi.clearAllMocks();
    lifecycleCallbacks.length = 0;
  });

  it('renders children unchanged', async () => {
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: false },
        React.createElement('div', { 'data-testid': 'child' }, 'Hello')
      )
    );

    expect(screen.getByTestId('child')).toHaveTextContent('Hello');
  });

  it('renders multiple children', async () => {
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: true },
        React.createElement('span', { 'data-testid': 'first' }, 'A'),
        React.createElement('span', { 'data-testid': 'second' }, 'B')
      )
    );

    expect(screen.getByTestId('first')).toHaveTextContent('A');
    expect(screen.getByTestId('second')).toHaveTextContent('B');
  });

  it('forwards isAppStable=true to splash screen hook', async () => {
    const { useSplashScreen } = await import('./hooks/use-splash-screen.js');
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: true },
        React.createElement('div', null, 'test')
      )
    );

    expect(useSplashScreen).toHaveBeenCalledWith(true);
  });

  it('forwards isAppStable=false to splash screen hook', async () => {
    const { useSplashScreen } = await import('./hooks/use-splash-screen.js');
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: false },
        React.createElement('div', null, 'test')
      )
    );

    expect(useSplashScreen).toHaveBeenCalledWith(false);
  });

  it('wires deep link handler to navigate', async () => {
    const { useDeepLinks } = await import('./hooks/use-deep-links.js');
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: true },
        React.createElement('div', null, 'test')
      )
    );

    // Extract the callback that was passed to useDeepLinks and invoke it
    const callback = vi.mocked(useDeepLinks).mock.calls[0]![0]!;
    callback('/chat/123');

    expect(mockNavigate).toHaveBeenCalledWith({ to: '/chat/123' });
  });

  it('activates all platform hooks on render', async () => {
    const { useBackButton } = await import('./hooks/use-back-button.js');
    const { useDeepLinks } = await import('./hooks/use-deep-links.js');
    const { useAppLifecycle } = await import('./hooks/use-app-lifecycle.js');
    const { useNetworkStatus } = await import('./hooks/use-network-status.js');
    const { useSplashScreen } = await import('./hooks/use-splash-screen.js');
    const { usePushNotifications } = await import('./hooks/use-push-notifications.js');
    const { useLiveUpdate } = await import('./hooks/use-live-update.js');

    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: true },
        React.createElement('div', null, 'test')
      )
    );

    expect(useBackButton).toHaveBeenCalled();
    expect(useDeepLinks).toHaveBeenCalledWith(expect.any(Function));
    expect(useAppLifecycle).toHaveBeenCalled();
    expect(useNetworkStatus).toHaveBeenCalled();
    expect(useSplashScreen).toHaveBeenCalledWith(true);
    expect(useLiveUpdate).toHaveBeenCalled();
    expect(usePushNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        onTokenReceived: expect.any(Function),
        onNotificationTap: expect.any(Function),
        onRegistrationError: expect.any(Function),
      })
    );
  });

  it('drops the shared prediction session when the app is backgrounded', async () => {
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: true },
        React.createElement('div', null, 'test')
      )
    );

    for (const registered of lifecycleCallbacks) registered?.onPause?.();

    expect(disposePredictionSession).toHaveBeenCalledTimes(1);
  });

  it('holds the prediction session while the app stays in the foreground', async () => {
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: true },
        React.createElement('div', null, 'test')
      )
    );

    expect(disposePredictionSession).not.toHaveBeenCalled();
  });

  it('onTokenReceived calls device-tokens API with token and platform', async () => {
    const { usePushNotifications } = await import('./hooks/use-push-notifications.js');
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: true },
        React.createElement('div', null, 'test')
      )
    );

    const callbacks = vi.mocked(usePushNotifications).mock.calls[0]![0]!;
    callbacks.onTokenReceived!('fcm-token-123');

    // Allow the fire-and-forget promise to settle
    await vi.waitFor(() => {
      expect(mockPostDeviceToken).toHaveBeenCalledWith({
        json: { token: 'fcm-token-123', platform: 'android' },
      });
    });
  });

  it('onTokenReceived maps the iOS platform through unchanged', async () => {
    mockGetPlatform.mockReturnValue('ios');
    const { usePushNotifications } = await import('./hooks/use-push-notifications.js');
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: true },
        React.createElement('div', null, 'test')
      )
    );

    const callbacks = vi.mocked(usePushNotifications).mock.calls[0]![0]!;
    callbacks.onTokenReceived!('apns-token-1');

    await vi.waitFor(() => {
      expect(mockPostDeviceToken).toHaveBeenCalledWith({
        json: { token: 'apns-token-1', platform: 'ios' },
      });
    });
  });

  it('onTokenReceived records a failed registration instead of rejecting', async () => {
    const { notificationChannel } = await import('@/lib/notification-channel');
    const { usePushNotifications } = await import('./hooks/use-push-notifications.js');
    const { CapacitorProvider } = await import('./provider.js');
    mockFetchJson.mockRejectedValueOnce(new Error('offline'));
    const unhandled: unknown[] = [];
    const capture = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', capture);

    try {
      render(
        React.createElement(
          CapacitorProvider,
          { isAppStable: true },
          React.createElement('div', null, 'test')
        )
      );

      const callbacks = vi.mocked(usePushNotifications).mock.calls[0]![0]!;
      callbacks.onTokenReceived!('fcm-token-123');

      await vi.waitFor(() => {
        expect(notificationChannel.getLastRegistrationOutcome()).toBe('failed-retryable');
      });
      // A rejection Node has no handler for is reported at the end of a
      // microtask checkpoint, so one macrotask turn is enough to see it.
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', capture);
    }
  });

  it('onRegistrationError records the platform refusing this device', async () => {
    const { notificationChannel } = await import('@/lib/notification-channel');
    const { usePushNotifications } = await import('./hooks/use-push-notifications.js');
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: true },
        React.createElement('div', null, 'test')
      )
    );

    // Driven up to `succeeded` first: the outcome is session-lived module state,
    // so a bare assertion of the failure reading would pass on what an earlier
    // case left behind rather than on the refusal this case sends.
    const callbacks = vi.mocked(usePushNotifications).mock.calls[0]![0]!;
    callbacks.onTokenReceived!('fcm-token-123');
    await vi.waitFor(() => {
      expect(notificationChannel.getLastRegistrationOutcome()).toBe('succeeded');
    });

    callbacks.onRegistrationError!();

    expect(notificationChannel.getLastRegistrationOutcome()).toBe('failed-retryable');
  });

  it('onNotificationTap navigates to conversation', async () => {
    const { usePushNotifications } = await import('./hooks/use-push-notifications.js');
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: true },
        React.createElement('div', null, 'test')
      )
    );

    const validId = testUuidV7(1);
    const callbacks = vi.mocked(usePushNotifications).mock.calls[0]![0]!;
    callbacks.onNotificationTap!({ conversationId: validId });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: `/chat/${validId}`,
    });
  });

  it('onNotificationTap ignores a malformed conversationId', async () => {
    const { usePushNotifications } = await import('./hooks/use-push-notifications.js');
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: true },
        React.createElement('div', null, 'test')
      )
    );

    const callbacks = vi.mocked(usePushNotifications).mock.calls[0]![0]!;
    callbacks.onNotificationTap!({ conversationId: '../../verify?token=x' });

    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('onNotificationTap ignores tap without conversationId', async () => {
    const { usePushNotifications } = await import('./hooks/use-push-notifications.js');
    const { CapacitorProvider } = await import('./provider.js');

    render(
      React.createElement(
        CapacitorProvider,
        { isAppStable: true },
        React.createElement('div', null, 'test')
      )
    );

    const callbacks = vi.mocked(usePushNotifications).mock.calls[0]![0]!;
    callbacks.onNotificationTap!({});

    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
