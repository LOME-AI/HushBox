import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { APP_RETURN_TO_BILLING_URL } from '@hushbox/shared/billing-portal';

type UrlOpenCallback = (event: { url: string }) => void;
let capturedCallback: UrlOpenCallback | null = null;

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((event: string, callback: UrlOpenCallback) => {
      if (event === 'appUrlOpen') {
        capturedCallback = callback;
      }
      return Promise.resolve({ remove: vi.fn() });
    }),
  },
}));

let browserFinished: (() => void) | null = null;

vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    addListener: vi.fn((event: string, callback: () => void) => {
      if (event === 'browserFinished') {
        browserFinished = callback;
      }
      return Promise.resolve({ remove: vi.fn() });
    }),
  },
}));

vi.mock('../platform.js', () => ({
  isNative: vi.fn(() => false),
}));

describe('useDeepLinks', () => {
  beforeEach(() => {
    capturedCallback = null;
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not register listener on web', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(false);

    const { App } = await import('@capacitor/app');
    const { useDeepLinks } = await import('./use-deep-links.js');

    renderHook(() => {
      useDeepLinks();
    });

    expect(App.addListener).not.toHaveBeenCalled();
  });

  it('registers appUrlOpen listener on native', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { App } = await import('@capacitor/app');
    const { useDeepLinks } = await import('./use-deep-links.js');

    renderHook(() => {
      useDeepLinks();
    });

    expect(App.addListener).toHaveBeenCalledWith('appUrlOpen', expect.any(Function));
  });

  it('calls onDeepLink with parsed URL path', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onDeepLink = vi.fn();
    const { useDeepLinks } = await import('./use-deep-links.js');

    renderHook(() => {
      useDeepLinks(onDeepLink);
    });

    expect(capturedCallback).not.toBeNull();
    capturedCallback!({ url: 'https://hushbox.ai/chat/123' });

    expect(onDeepLink).toHaveBeenCalledWith('/chat/123');
  });

  it('handles URLs with query params', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onDeepLink = vi.fn();
    const { useDeepLinks } = await import('./use-deep-links.js');

    renderHook(() => {
      useDeepLinks(onDeepLink);
    });

    capturedCallback!({ url: 'https://hushbox.ai/billing?token=abc' });

    expect(onDeepLink).toHaveBeenCalledWith('/billing?token=abc');
  });

  it('handles root URL path', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onDeepLink = vi.fn();
    const { useDeepLinks } = await import('./use-deep-links.js');

    renderHook(() => {
      useDeepLinks(onDeepLink);
    });

    capturedCallback!({ url: 'https://hushbox.ai/' });

    expect(onDeepLink).toHaveBeenCalledWith('/');
  });

  it('falls back to root for a malformed URL without throwing', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onDeepLink = vi.fn();
    const { useDeepLinks } = await import('./use-deep-links.js');

    renderHook(() => {
      useDeepLinks(onDeepLink);
    });

    expect(() => {
      capturedCallback!({ url: 'not a url' });
    }).not.toThrow();
    expect(onDeepLink).toHaveBeenCalledWith('/');
  });

  it('falls back to root for a non-allowlisted path', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onDeepLink = vi.fn();
    const { useDeepLinks } = await import('./use-deep-links.js');

    renderHook(() => {
      useDeepLinks(onDeepLink);
    });

    capturedCallback!({ url: 'hushbox://app/verify?token=attacker' });

    expect(onDeepLink).toHaveBeenCalledWith('/');
  });

  it('falls back to root for /login (kept out of the AASA universal-link targets)', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onDeepLink = vi.fn();
    const { useDeepLinks } = await import('./use-deep-links.js');

    renderHook(() => {
      useDeepLinks(onDeepLink);
    });

    capturedCallback!({ url: 'https://hushbox.ai/login?token=attacker' });

    expect(onDeepLink).toHaveBeenCalledWith('/');
  });

  it('falls back to root for /signup (kept out of the AASA universal-link targets)', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onDeepLink = vi.fn();
    const { useDeepLinks } = await import('./use-deep-links.js');

    renderHook(() => {
      useDeepLinks(onDeepLink);
    });

    capturedCallback!({ url: 'https://hushbox.ai/signup?token=attacker' });

    expect(onDeepLink).toHaveBeenCalledWith('/');
  });

  it('preserves the URL fragment, which carries a share link decryption key', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onDeepLink = vi.fn();
    const { useDeepLinks } = await import('./use-deep-links.js');

    renderHook(() => {
      useDeepLinks(onDeepLink);
    });

    capturedCallback!({ url: 'https://hushbox.ai/share/m/abc#Zm9vYmFy' });

    expect(onDeepLink).toHaveBeenCalledWith('/share/m/abc#Zm9vYmFy');
  });

  it('falls back to root for a protocol-relative URL', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const onDeepLink = vi.fn();
    const { useDeepLinks } = await import('./use-deep-links.js');

    renderHook(() => {
      useDeepLinks(onDeepLink);
    });

    capturedCallback!({ url: '//evil.com/chat/123' });

    expect(onDeepLink).toHaveBeenCalledWith('/');
  });
});

describe('useDeepLinks with the billing return link', () => {
  beforeEach(async () => {
    capturedCallback = null;
    browserFinished = null;
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function listen(platform: 'ios' | 'android'): Promise<ReturnType<typeof vi.fn>> {
    const { Capacitor } = await import('@capacitor/core');
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue(platform);
    const onDeepLink = vi.fn();
    const { useDeepLinks } = await import('./use-deep-links.js');
    renderHook(() => {
      useDeepLinks(onDeepLink);
    });
    return onDeepLink;
  }

  async function openSheet(): Promise<void> {
    const { openExternalUrl } = await import('../browser.js');
    await openExternalUrl('https://hushbox.ai/billing-portal');
  }

  it('navigates to billing, never to root', async () => {
    const onDeepLink = await listen('ios');

    capturedCallback!({ url: APP_RETURN_TO_BILLING_URL });

    expect(onDeepLink.mock.calls).toEqual([['/billing']]);
  });

  it.each([APP_RETURN_TO_BILLING_URL, `${APP_RETURN_TO_BILLING_URL}/`])(
    'sends %s to billing',
    async (url) => {
      const onDeepLink = await listen('android');

      capturedCallback!({ url });

      expect(onDeepLink.mock.calls).toEqual([['/billing']]);
    }
  );

  it('navigates to billing on ios when there is no sheet to close', async () => {
    const onDeepLink = await listen('ios');
    const { Browser } = await import('@capacitor/browser');
    vi.mocked(Browser.close).mockRejectedValueOnce(new Error('No active window to close!'));

    capturedCallback!({ url: APP_RETURN_TO_BILLING_URL });

    expect(onDeepLink.mock.calls).toEqual([['/billing']]);
  });

  it('leaves no unhandled rejection on ios when there is no sheet to close', async () => {
    await listen('ios');
    const { Browser } = await import('@capacitor/browser');
    vi.mocked(Browser.close).mockRejectedValueOnce(new Error('No active window to close!'));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);

    try {
      capturedCallback!({ url: APP_RETURN_TO_BILLING_URL });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }

    expect(unhandled).toEqual([]);
  });

  it('navigates to billing and carries nothing from the query', async () => {
    const onDeepLink = await listen('ios');

    capturedCallback!({ url: `${APP_RETURN_TO_BILLING_URL}?token=a` });

    expect(onDeepLink.mock.calls).toEqual([['/billing']]);
  });

  it('closes the open sheet once on ios', async () => {
    const onDeepLink = await listen('ios');
    await openSheet();
    const { Browser } = await import('@capacitor/browser');

    capturedCallback!({ url: APP_RETURN_TO_BILLING_URL });

    expect(Browser.close).toHaveBeenCalledTimes(1);
    expect(onDeepLink).toHaveBeenCalledWith('/billing');
  });

  it('asks for the sheet to close on ios even when none was recorded open', async () => {
    await listen('ios');
    const { Browser } = await import('@capacitor/browser');

    capturedCallback!({ url: APP_RETURN_TO_BILLING_URL });

    expect(Browser.close).toHaveBeenCalledTimes(1);
  });

  it('closes the open sheet once on android', async () => {
    await listen('android');
    await openSheet();
    const { Browser } = await import('@capacitor/browser');

    capturedCallback!({ url: APP_RETURN_TO_BILLING_URL });

    expect(Browser.close).toHaveBeenCalledTimes(1);
  });

  it('leaves the sheet alone on android once it reported browserFinished', async () => {
    const onDeepLink = await listen('android');
    await openSheet();
    browserFinished!();
    const { Browser } = await import('@capacitor/browser');

    capturedCallback!({ url: APP_RETURN_TO_BILLING_URL });

    expect(Browser.close).not.toHaveBeenCalled();
    expect(onDeepLink).toHaveBeenCalledWith('/billing');
  });

  it('navigates to billing on android with no sheet ever opened, closing nothing', async () => {
    const onDeepLink = await listen('android');
    const { Browser } = await import('@capacitor/browser');

    capturedCallback!({ url: APP_RETURN_TO_BILLING_URL });

    expect(Browser.close).not.toHaveBeenCalled();
    expect(onDeepLink.mock.calls).toEqual([['/billing']]);
  });

  it.each([
    'hushbox://settings',
    'hushbox://billing/settings',
    'hushbox://billing//',
    'hushbox://x/share/c/abc',
  ])('sends %s to root', async (url) => {
    const onDeepLink = await listen('android');

    capturedCallback!({ url });

    expect(onDeepLink.mock.calls).toEqual([['/']]);
  });

  it('still sends an https share link to its safe path', async () => {
    const onDeepLink = await listen('android');

    capturedCallback!({ url: 'https://hushbox.ai/share/c/abc' });

    expect(onDeepLink.mock.calls).toEqual([['/share/c/abc']]);
  });
});
