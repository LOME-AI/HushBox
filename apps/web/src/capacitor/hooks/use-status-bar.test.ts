import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

vi.mock('@capacitor/status-bar', () => ({
  StatusBar: {
    setStyle: vi.fn(),
    setBackgroundColor: vi.fn(),
  },
  Style: {
    Dark: 'DARK',
    Light: 'LIGHT',
  },
}));

vi.mock('../platform.js', () => ({
  isNative: vi.fn(() => false),
  getPlatform: vi.fn(() => 'web' as const),
}));

/**
 * Stand-in brand tokens. Deliberately not the real palette: the hook must report
 * whatever the stylesheet says, so a value that could never be mistaken for a
 * brand colour is what proves it is reading rather than reciting.
 */
const LIGHT_BACKGROUND = '#010101';
const DARK_BACKGROUND = '#050505';

let tokenSheet: HTMLStyleElement | undefined;

/**
 * Only the background is defined. The hook asks for that token alone, so the
 * rest of the palette being absent must not reach it.
 */
function installTokens(): void {
  tokenSheet = document.createElement('style');
  tokenSheet.textContent = `:root { --background: ${LIGHT_BACKGROUND}; } .dark { --background: ${DARK_BACKGROUND}; }`;
  document.head.append(tokenSheet);
}

describe('useStatusBar', () => {
  afterEach(() => {
    vi.clearAllMocks();
    tokenSheet?.remove();
    tokenSheet = undefined;
    document.documentElement.classList.remove('dark');
  });

  it('does nothing on web', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(false);

    const { StatusBar } = await import('@capacitor/status-bar');
    const { useStatusBar } = await import('./use-status-bar.js');

    renderHook(() => {
      useStatusBar('dark');
    });

    expect(StatusBar.setStyle).not.toHaveBeenCalled();
  });

  it('sets light content style for dark theme on iOS', async () => {
    const { isNative, getPlatform } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
    vi.mocked(getPlatform).mockReturnValue('ios');

    const { StatusBar, Style } = await import('@capacitor/status-bar');
    const { useStatusBar } = await import('./use-status-bar.js');

    renderHook(() => {
      useStatusBar('dark');
    });

    expect(StatusBar.setStyle).toHaveBeenCalledWith({ style: Style.Dark });
    expect(StatusBar.setBackgroundColor).not.toHaveBeenCalled();
  });

  it('sets dark content style for light theme on iOS', async () => {
    const { isNative, getPlatform } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
    vi.mocked(getPlatform).mockReturnValue('ios');

    const { StatusBar, Style } = await import('@capacitor/status-bar');
    const { useStatusBar } = await import('./use-status-bar.js');

    renderHook(() => {
      useStatusBar('light');
    });

    expect(StatusBar.setStyle).toHaveBeenCalledWith({ style: Style.Light });
    expect(StatusBar.setBackgroundColor).not.toHaveBeenCalled();
  });

  it('sets both style and the stylesheet background on Android in dark mode', async () => {
    const { isNative, getPlatform } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
    vi.mocked(getPlatform).mockReturnValue('android');

    const { StatusBar, Style } = await import('@capacitor/status-bar');
    const { useStatusBar } = await import('./use-status-bar.js');

    installTokens();
    document.documentElement.classList.add('dark');

    renderHook(() => {
      useStatusBar('dark');
    });

    expect(StatusBar.setStyle).toHaveBeenCalledWith({ style: Style.Dark });
    expect(StatusBar.setBackgroundColor).toHaveBeenCalledWith({ color: DARK_BACKGROUND });
  });

  it('sets the stylesheet background on Android in light mode', async () => {
    const { isNative, getPlatform } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
    vi.mocked(getPlatform).mockReturnValue('android');

    const { StatusBar, Style } = await import('@capacitor/status-bar');
    const { useStatusBar } = await import('./use-status-bar.js');

    installTokens();

    renderHook(() => {
      useStatusBar('light');
    });

    expect(StatusBar.setStyle).toHaveBeenCalledWith({ style: Style.Light });
    expect(StatusBar.setBackgroundColor).toHaveBeenCalledWith({ color: LIGHT_BACKGROUND });
  });
});
