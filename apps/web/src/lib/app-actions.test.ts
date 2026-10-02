import { describe, it, expect, vi, type Mock } from 'vitest';
import { ROUTES } from '@hushbox/shared';
import { APP_ACTIONS, type AppActionContext } from './app-actions';

interface ContextSpies {
  context: AppActionContext;
  /** What the context's `navigate` was called with; the router's type is generic, so no mock is one. */
  navigate: Mock<(options: unknown) => void>;
  closeDrawer: Mock<AppActionContext['closeDrawer']>;
  openFeedback: Mock<AppActionContext['openFeedback']>;
}

function makeContext(): ContextSpies {
  const navigateSpy = vi.fn<(options: unknown) => void>();
  const navigate: AppActionContext['navigate'] = (options) => {
    navigateSpy(options);
    return Promise.resolve();
  };
  const closeDrawer = vi.fn<AppActionContext['closeDrawer']>();
  const openFeedback = vi.fn<AppActionContext['openFeedback']>();
  const context: AppActionContext = { navigate, closeDrawer, openFeedback };
  return { context, navigate: navigateSpy, closeDrawer, openFeedback };
}

describe('APP_ACTIONS', () => {
  it.each([
    ['newChat', ROUTES.CHAT],
    ['settings', ROUTES.SETTINGS],
    ['usage', ROUTES.USAGE],
    ['addCredit', ROUTES.BILLING],
    ['accessibilityPage', ROUTES.ACCESSIBILITY],
  ] as const)('%s navigates to %s', (key, route) => {
    const { context, navigate } = makeContext();

    APP_ACTIONS[key].run(context);

    expect(navigate).toHaveBeenCalledWith({ to: route });
  });

  it.each([
    'newChat',
    'settings',
    'usage',
    'addCredit',
    'accessibilityPage',
    'sendFeedback',
  ] as const)('%s closes the phone drawer first', (key) => {
    const { context, closeDrawer, navigate, openFeedback } = makeContext();

    APP_ACTIONS[key].run(context);

    expect(closeDrawer).toHaveBeenCalledOnce();
    const [closed] = closeDrawer.mock.invocationCallOrder;
    const [followed] = [
      ...navigate.mock.invocationCallOrder,
      ...openFeedback.mock.invocationCallOrder,
    ];
    expect(closed).toBeLessThan(followed ?? Number.POSITIVE_INFINITY);
  });

  it('sendFeedback opens the feedback dialog without navigating', () => {
    const { context, navigate, openFeedback } = makeContext();

    APP_ACTIONS.sendFeedback.run(context);

    expect(openFeedback).toHaveBeenCalledOnce();
    expect(navigate).not.toHaveBeenCalled();
  });

  it('requires a session for the account-only actions', () => {
    expect(APP_ACTIONS.settings.requiresSession).toBe(true);
    expect(APP_ACTIONS.usage.requiresSession).toBe(true);
    expect(APP_ACTIONS.addCredit.requiresSession).toBe(true);
    expect(APP_ACTIONS.sendFeedback.requiresSession).toBe(true);
  });

  it('lets a visitor with no session start a chat and open the accessibility page', () => {
    expect(APP_ACTIONS.newChat.requiresSession).toBe(false);
    expect(APP_ACTIONS.accessibilityPage.requiresSession).toBe(false);
  });
});
