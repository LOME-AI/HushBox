import { describe, it, expect, vi } from 'vitest';
import { NOTIFICATION_COPY, fromBase64 } from '@hushbox/shared';
import { testUuidV7 } from '@hushbox/shared/test-time';
import {
  handleActivate,
  handlePush,
  handleNotificationClick,
  handlePushSubscriptionChange,
} from './handlers.js';
import type {
  ServiceWorkerScope,
  WindowClientLike,
  PushEventLike,
  NotificationClickEventLike,
  PushSubscriptionChangeEventLike,
} from './handlers.js';

const VALID_ID = testUuidV7(1);
const OTHER_ID = testUuidV7(2);
const VIEWING_URL = `https://app.example/chat/${VALID_ID}`;

function makeClient(overrides: Partial<WindowClientLike> = {}): WindowClientLike {
  return {
    focused: false,
    url: 'https://app.example/chat',
    focus: vi.fn(() => Promise.resolve()),
    navigate: vi.fn(() => Promise.resolve()),
    postMessage: vi.fn(),
    ...overrides,
  };
}

function makeScope(
  overrides: {
    clients?: readonly WindowClientLike[];
    subscribe?: ReturnType<typeof vi.fn>;
    showNotification?: ReturnType<typeof vi.fn>;
    openWindow?: ReturnType<typeof vi.fn>;
    claim?: ReturnType<typeof vi.fn>;
  } = {}
): ServiceWorkerScope {
  const clients = overrides.clients ?? [];
  return {
    clients: {
      matchAll: vi.fn(() => Promise.resolve(clients)),
      openWindow: overrides.openWindow ?? vi.fn(() => Promise.resolve()),
      claim: overrides.claim ?? vi.fn(() => Promise.resolve()),
    },
    registration: {
      showNotification: overrides.showNotification ?? vi.fn(() => Promise.resolve()),
      pushManager: {
        subscribe: overrides.subscribe ?? vi.fn(() => Promise.resolve({ toJSON: () => ({}) })),
      },
    },
    addEventListener: vi.fn(),
  } as unknown as ServiceWorkerScope;
}

function pushEvent(
  data: unknown,
  options: { throws?: boolean; empty?: boolean } = {}
): PushEventLike {
  return {
    waitUntil: vi.fn(),
    data: options.empty
      ? null
      : {
          json: options.throws
            ? () => {
                throw new SyntaxError('bad json');
              }
            : () => data,
        },
  };
}

describe('handlePush', () => {
  it('shows a generic notification when no client is focused', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification, clients: [makeClient({ focused: false })] });
    await handlePush(scope, pushEvent({ category: 'message', conversationId: VALID_ID }));

    expect(showNotification).toHaveBeenCalledWith(
      NOTIFICATION_COPY.message.title,
      expect.objectContaining({ body: NOTIFICATION_COPY.message.body, tag: VALID_ID })
    );
  });

  it('shows no notification while a focused client is viewing that conversation', async () => {
    const focused = makeClient({ focused: true, url: VIEWING_URL });
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification, clients: [focused] });
    await handlePush(scope, pushEvent({ category: 'runCompletion', conversationId: VALID_ID }));

    expect(showNotification).not.toHaveBeenCalled();
  });

  it('shows the notification when the focused client is viewing another conversation', async () => {
    const focused = makeClient({ focused: true, url: `https://app.example/chat/${OTHER_ID}` });
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification, clients: [focused] });
    await handlePush(scope, pushEvent({ category: 'message', conversationId: VALID_ID }));

    expect(showNotification).toHaveBeenCalled();
  });

  it('shows the notification when the focused client is on an unrelated page', async () => {
    const focused = makeClient({ focused: true, url: 'https://app.example/blog/some-post' });
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification, clients: [focused] });
    await handlePush(scope, pushEvent({ category: 'message', conversationId: VALID_ID }));

    expect(showNotification).toHaveBeenCalled();
  });

  it('shows the notification when the client on that conversation is not focused', async () => {
    const background = makeClient({ focused: false, url: VIEWING_URL });
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification, clients: [background] });
    await handlePush(scope, pushEvent({ category: 'message', conversationId: VALID_ID }));

    expect(showNotification).toHaveBeenCalled();
  });

  it('does not mistake a longer path segment for the conversation being viewed', async () => {
    const focused = makeClient({ focused: true, url: `https://app.example/chat/${VALID_ID}-copy` });
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification, clients: [focused] });
    await handlePush(scope, pushEvent({ category: 'message', conversationId: VALID_ID }));

    expect(showNotification).toHaveBeenCalled();
  });

  it('hands the client viewing that conversation nothing', async () => {
    const focused = makeClient({ focused: true, url: VIEWING_URL });
    const scope = makeScope({ clients: [focused] });
    await handlePush(scope, pushEvent({ category: 'runCompletion', conversationId: VALID_ID }));

    expect(focused.postMessage).not.toHaveBeenCalled();
  });

  it('drops a push with no data', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification });
    await handlePush(scope, pushEvent(undefined, { empty: true }));
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('drops a push whose data is not valid JSON', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification });
    await handlePush(scope, pushEvent(undefined, { throws: true }));
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('drops a push whose payload fails the shared schema (unknown key)', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification });
    await handlePush(
      scope,
      pushEvent({ category: 'message', conversationId: VALID_ID, title: 'secret' })
    );
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('drops a push whose conversationId is not a uuid', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification });
    await handlePush(scope, pushEvent({ category: 'message', conversationId: '../etc' }));
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('stores the validated payload as notification data for the click handler', async () => {
    const showNotification = vi.fn(() => Promise.resolve());
    const scope = makeScope({ showNotification });
    const payload = { category: 'membership' as const, conversationId: VALID_ID };
    await handlePush(scope, pushEvent(payload));
    expect(showNotification).toHaveBeenCalledWith(
      NOTIFICATION_COPY.membership.title,
      expect.objectContaining({ data: payload })
    );
  });
});

function clickEvent(data: unknown): NotificationClickEventLike {
  return {
    waitUntil: vi.fn(),
    notification: { data, close: vi.fn() },
  };
}

describe('handleNotificationClick', () => {
  it('focuses and navigates an existing client to the deep link', async () => {
    const client = makeClient();
    const scope = makeScope({ clients: [client] });
    await handleNotificationClick(
      scope,
      clickEvent({ category: 'message', conversationId: VALID_ID })
    );

    expect(client.focus).toHaveBeenCalled();
    expect(client.navigate).toHaveBeenCalledWith(`/chat/${VALID_ID}`);
  });

  it('opens a new window when no client is available', async () => {
    const openWindow = vi.fn(() => Promise.resolve());
    const scope = makeScope({ clients: [], openWindow });
    await handleNotificationClick(
      scope,
      clickEvent({ category: 'message', conversationId: VALID_ID })
    );

    expect(openWindow).toHaveBeenCalledWith(`/chat/${VALID_ID}`);
  });

  it('closes the notification on click', async () => {
    const scope = makeScope({ clients: [] });
    const event = clickEvent({ category: 'message', conversationId: VALID_ID });
    await handleNotificationClick(scope, event);
    expect(event.notification.close).toHaveBeenCalled();
  });

  it('drops a click whose id is invalid (no navigation, no window)', async () => {
    const openWindow = vi.fn(() => Promise.resolve());
    const scope = makeScope({ clients: [], openWindow });
    await handleNotificationClick(
      scope,
      clickEvent({ category: 'message', conversationId: 'nope' })
    );
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('drops a click whose data is missing entirely', async () => {
    const openWindow = vi.fn(() => Promise.resolve());
    const scope = makeScope({ clients: [], openWindow });
    await handleNotificationClick(scope, clickEvent(null));
    expect(openWindow).not.toHaveBeenCalled();
  });

  // A real `WindowClient.navigate()` rejects with a TypeError for a client this
  // worker does not control, so a mock that always resolves can never see the
  // fallback. This one rejects the way the platform does.
  it('opens a window when the existing client refuses to be navigated', async () => {
    const openWindow = vi.fn(() => Promise.resolve());
    const client = makeClient({
      navigate: vi.fn(() => Promise.reject(new TypeError('client is not controlled'))),
    });
    const scope = makeScope({ clients: [client], openWindow });

    await handleNotificationClick(
      scope,
      clickEvent({ category: 'message', conversationId: VALID_ID })
    );

    expect(openWindow).toHaveBeenCalledWith(`/chat/${VALID_ID}`);
  });

  it('opens no second window when the existing client navigates', async () => {
    const openWindow = vi.fn(() => Promise.resolve());
    const scope = makeScope({ clients: [makeClient()], openWindow });

    await handleNotificationClick(
      scope,
      clickEvent({ category: 'message', conversationId: VALID_ID })
    );

    expect(openWindow).not.toHaveBeenCalled();
  });
});

describe('handleActivate', () => {
  it('claims the pages that were already open when the worker installed', async () => {
    const claim = vi.fn(() => Promise.resolve());
    const scope = makeScope({ claim });

    await handleActivate(scope);

    expect(claim).toHaveBeenCalled();
  });
});

/** The configured VAPID public key (base64url) and the key of a retired pair. */
const VAPID_PUBLIC_KEY = 'BOeIadxzr8jCEiJstuK2';
const RETIRED_VAPID_PUBLIC_KEY = 'BRetiredKeyBytesXXXX';

/**
 * The browser's event still carries the old subscription; the handler must
 * not read its key, so every event here carries a retired one as bait.
 */
function subscriptionChangeEvent(): PushSubscriptionChangeEventLike {
  const event = {
    waitUntil: vi.fn(),
    oldSubscription: {
      options: {
        applicationServerKey: new Uint8Array(fromBase64(RETIRED_VAPID_PUBLIC_KEY)).buffer,
      },
    },
  };
  return event;
}

function subscribedKeyBytes(subscribe: ReturnType<typeof vi.fn>): Uint8Array {
  const [options] = subscribe.mock.calls[0] as [{ applicationServerKey: ArrayBuffer }];
  return new Uint8Array(options.applicationServerKey);
}

describe('handlePushSubscriptionChange', () => {
  it("re-subscribes under the build-time public key, not the old subscription's", async () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', VAPID_PUBLIC_KEY);
    const subscribe = vi.fn(() => Promise.resolve({ toJSON: () => ({}) }));
    const scope = makeScope({ subscribe });

    await handlePushSubscriptionChange(scope, subscriptionChangeEvent());

    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: expect.any(ArrayBuffer),
    });
    expect(subscribedKeyBytes(subscribe)).toEqual(fromBase64(VAPID_PUBLIC_KEY));
  });

  it('notifies open clients to re-register the new subscription', async () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', VAPID_PUBLIC_KEY);
    const newSubscription = { toJSON: () => ({ endpoint: 'https://push/new' }) };
    const subscribe = vi.fn(() => Promise.resolve(newSubscription));
    const client = makeClient();
    const scope = makeScope({ subscribe, clients: [client] });

    await handlePushSubscriptionChange(scope, subscriptionChangeEvent());

    expect(client.postMessage).toHaveBeenCalledWith({
      type: 'pushsubscriptionchange',
      subscription: { endpoint: 'https://push/new' },
    });
  });

  it('fails fast when the build-time public key is missing', async () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', '');
    const subscribe = vi.fn(() => Promise.resolve({ toJSON: () => ({}) }));
    const scope = makeScope({ subscribe });

    await expect(handlePushSubscriptionChange(scope, subscriptionChangeEvent())).rejects.toThrow();
    expect(subscribe).not.toHaveBeenCalled();
  });

  it('resolves without rejecting and notifies no client when re-subscribe fails', async () => {
    vi.stubEnv('VITE_VAPID_PUBLIC_KEY', VAPID_PUBLIC_KEY);
    const subscribe = vi.fn(() => Promise.reject(new Error('subscribe failed')));
    const client = makeClient();
    const scope = makeScope({ subscribe, clients: [client] });

    await expect(
      handlePushSubscriptionChange(scope, subscriptionChangeEvent())
    ).resolves.toBeUndefined();
    expect(client.postMessage).not.toHaveBeenCalled();
  });
});
