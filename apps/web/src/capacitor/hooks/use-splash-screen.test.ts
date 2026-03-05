import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@capacitor/splash-screen', () => ({
  SplashScreen: {
    hide: vi.fn(),
  },
}));

vi.mock('../platform.js', () => ({
  isNative: vi.fn(() => false),
}));

describe('useSplashScreen', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('does not call hide on web', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(false);

    const { SplashScreen } = await import('@capacitor/splash-screen');
    const { useSplashScreen } = await import('./use-splash-screen.js');

    renderHook(() => {
      useSplashScreen(true);
    });

    expect(SplashScreen.hide).not.toHaveBeenCalled();
  });

  it('does not hide splash when app is not stable', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { SplashScreen } = await import('@capacitor/splash-screen');
    const { useSplashScreen } = await import('./use-splash-screen.js');

    renderHook(() => {
      useSplashScreen(false);
    });

    expect(SplashScreen.hide).not.toHaveBeenCalled();
  });

  it('hides splash when app becomes stable on native', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { SplashScreen } = await import('@capacitor/splash-screen');
    const { useSplashScreen } = await import('./use-splash-screen.js');

    renderHook(() => {
      useSplashScreen(true);
    });

    expect(SplashScreen.hide).toHaveBeenCalledTimes(1);
  });
});
