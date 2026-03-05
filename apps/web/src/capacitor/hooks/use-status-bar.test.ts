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

describe('useStatusBar', () => {
  afterEach(() => {
    vi.clearAllMocks();
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

  it('sets both style and background color on Android', async () => {
    const { isNative, getPlatform } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
    vi.mocked(getPlatform).mockReturnValue('android');

    const { StatusBar, Style } = await import('@capacitor/status-bar');
    const { useStatusBar } = await import('./use-status-bar.js');

    renderHook(() => {
      useStatusBar('dark');
    });

    expect(StatusBar.setStyle).toHaveBeenCalledWith({ style: Style.Dark });
    expect(StatusBar.setBackgroundColor).toHaveBeenCalledWith({ color: '#1a1816' });
  });

  it('sets light background on Android for light theme', async () => {
    const { isNative, getPlatform } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);
    vi.mocked(getPlatform).mockReturnValue('android');

    const { StatusBar, Style } = await import('@capacitor/status-bar');
    const { useStatusBar } = await import('./use-status-bar.js');

    renderHook(() => {
      useStatusBar('light');
    });

    expect(StatusBar.setStyle).toHaveBeenCalledWith({ style: Style.Light });
    expect(StatusBar.setBackgroundColor).toHaveBeenCalledWith({ color: '#faf9f6' });
  });
});
