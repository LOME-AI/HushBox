import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('@capacitor/browser', () => ({
  Browser: {
    open: vi.fn(),
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
      url: 'https://hushbox.ai/privacy',
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
      url: 'https://hushbox.ai/terms',
    });
  });
});
