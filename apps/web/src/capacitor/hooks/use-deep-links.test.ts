import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

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
});
