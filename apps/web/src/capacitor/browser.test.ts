import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { MARKETING_BASE_URL } from '@hushbox/shared';

let browserFinished: (() => void) | null = null;

vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: vi.fn(),
    close: vi.fn(() => Promise.resolve()),
    addListener: vi.fn((event: string, callback: () => void) => {
      if (event === 'browserFinished') {
        browserFinished = callback;
      }
      return Promise.resolve({ remove: vi.fn() });
    }),
  },
}));

vi.mock('./platform.js', () => ({
  isNative: vi.fn(() => false),
}));

describe('openExternalUrl', () => {
  let windowOpenSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    windowOpenSpy = vi.spyOn(globalThis, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('opens URL in system browser on native via Browser.open', async () => {
    const { isNative } = await import('./platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { Browser } = await import('@capacitor/browser');
    const { openExternalUrl } = await import('./browser.js');
    await openExternalUrl('https://hushbox.ai/privacy');

    expect(Browser.open).toHaveBeenCalledWith({ url: 'https://hushbox.ai/privacy' });
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it('opens URL in new tab on web via window.open', async () => {
    const { isNative } = await import('./platform.js');
    vi.mocked(isNative).mockReturnValue(false);

    const { Browser } = await import('@capacitor/browser');
    const { openExternalUrl } = await import('./browser.js');
    await openExternalUrl('https://hushbox.ai/terms');

    expect(windowOpenSpy).toHaveBeenCalledWith('https://hushbox.ai/terms', '_blank');
    expect(Browser.open).not.toHaveBeenCalled();
  });
});

describe('openExternalPage', () => {
  let windowOpenSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    windowOpenSpy = vi.spyOn(globalThis, 'open').mockImplementation(() => null);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('opens full URL via system browser on native', async () => {
    const { isNative } = await import('./platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { Browser } = await import('@capacitor/browser');
    const { openExternalPage } = await import('./browser.js');
    await openExternalPage('/privacy');

    expect(Browser.open).toHaveBeenCalledWith({
      url: `${MARKETING_BASE_URL}/privacy`,
    });
    expect(windowOpenSpy).not.toHaveBeenCalled();
  });

  it('opens relative path in new tab on web', async () => {
    const { isNative } = await import('./platform.js');
    vi.mocked(isNative).mockReturnValue(false);

    const { Browser } = await import('@capacitor/browser');
    const { openExternalPage } = await import('./browser.js');
    await openExternalPage('/terms');

    expect(windowOpenSpy).toHaveBeenCalledWith('/terms', '_blank');
    expect(Browser.open).not.toHaveBeenCalled();
  });

  it('constructs correct URL for paths with trailing content', async () => {
    const { isNative } = await import('./platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { Browser } = await import('@capacitor/browser');
    const { openExternalPage } = await import('./browser.js');
    await openExternalPage('/terms');

    expect(Browser.open).toHaveBeenCalledWith({
      url: `${MARKETING_BASE_URL}/terms`,
    });
  });
});

describe('the in-app browser sheet', () => {
  beforeEach(async () => {
    browserFinished = null;
    const { isNative } = await import('./platform.js');
    vi.mocked(isNative).mockReturnValue(true);
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('is not open before anything is opened', async () => {
    const { isInAppBrowserOpen } = await import('./browser.js');

    expect(isInAppBrowserOpen()).toBe(false);
  });

  it('is recorded as open once openExternalUrl opens it', async () => {
    const { openExternalUrl, isInAppBrowserOpen } = await import('./browser.js');
    await openExternalUrl('https://hushbox.ai/billing-portal');

    expect(isInAppBrowserOpen()).toBe(true);
  });

  it('is recorded as closed once the plugin reports browserFinished', async () => {
    const { openExternalUrl, isInAppBrowserOpen } = await import('./browser.js');
    await openExternalUrl('https://hushbox.ai/billing-portal');

    browserFinished?.();

    expect(isInAppBrowserOpen()).toBe(false);
  });

  it('listens for browserFinished once however many sheets are opened', async () => {
    const { Browser } = await import('@capacitor/browser');
    const { openExternalUrl } = await import('./browser.js');
    await openExternalUrl('https://hushbox.ai/billing-portal');
    await openExternalUrl('https://hushbox.ai/billing-portal');

    expect(Browser.addListener).toHaveBeenCalledTimes(1);
  });

  it('is not recorded as open when the plugin fails to open it', async () => {
    const { Browser } = await import('@capacitor/browser');
    vi.mocked(Browser.open).mockRejectedValueOnce(new Error('Unable to display URL'));
    const { openExternalUrl, isInAppBrowserOpen } = await import('./browser.js');

    await expect(openExternalUrl('https://hushbox.ai/billing-portal')).rejects.toThrow(
      'Unable to display URL'
    );
    expect(isInAppBrowserOpen()).toBe(false);
  });

  it('closeInAppBrowser asks the plugin to close the sheet', async () => {
    const { Browser } = await import('@capacitor/browser');
    const { openExternalUrl, closeInAppBrowser } = await import('./browser.js');
    await openExternalUrl('https://hushbox.ai/billing-portal');

    await closeInAppBrowser();

    expect(Browser.close).toHaveBeenCalledTimes(1);
  });

  it('closeInAppBrowser resolves when the plugin has no sheet to close', async () => {
    const { Browser } = await import('@capacitor/browser');
    vi.mocked(Browser.close).mockRejectedValueOnce(new Error('No active window to close!'));
    const { closeInAppBrowser } = await import('./browser.js');

    await expect(closeInAppBrowser()).resolves.toBeUndefined();
  });

  it('closeInAppBrowser records the sheet as closed when the plugin has none to close', async () => {
    const { Browser } = await import('@capacitor/browser');
    const { openExternalUrl, closeInAppBrowser, isInAppBrowserOpen } = await import('./browser.js');
    await openExternalUrl('https://hushbox.ai/billing-portal');
    vi.mocked(Browser.close).mockRejectedValueOnce(new Error('No active window to close!'));

    await closeInAppBrowser();

    expect(isInAppBrowserOpen()).toBe(false);
  });

  it('closeInAppBrowser passes on any other plugin failure', async () => {
    const { Browser } = await import('@capacitor/browser');
    vi.mocked(Browser.close).mockRejectedValueOnce(new Error('Plugin not implemented'));
    const { closeInAppBrowser } = await import('./browser.js');

    await expect(closeInAppBrowser()).rejects.toThrow('Plugin not implemented');
  });

  it('closeInAppBrowser records the sheet as closed', async () => {
    const { openExternalUrl, closeInAppBrowser, isInAppBrowserOpen } = await import('./browser.js');
    await openExternalUrl('https://hushbox.ai/billing-portal');

    await closeInAppBrowser();

    expect(isInAppBrowserOpen()).toBe(false);
  });
});
