import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

type BackButtonCallback = (event: { canGoBack: boolean }) => void;
let capturedCallback: BackButtonCallback | null = null;

vi.mock('@capacitor/app', () => ({
  App: {
    addListener: vi.fn((event: string, callback: BackButtonCallback) => {
      if (event === 'backButton') {
        capturedCallback = callback;
      }
      return Promise.resolve({ remove: vi.fn() });
    }),
    exitApp: vi.fn(),
  },
}));

vi.mock('../platform.js', () => ({
  isNative: vi.fn(() => false),
}));

describe('useBackButton', () => {
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
    const { useBackButton } = await import('./use-back-button.js');

    renderHook(() => {
      useBackButton();
    });

    expect(App.addListener).not.toHaveBeenCalled();
  });

  it('registers backButton listener on native', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { App } = await import('@capacitor/app');
    const { useBackButton } = await import('./use-back-button.js');

    renderHook(() => {
      useBackButton();
    });

    expect(App.addListener).toHaveBeenCalledWith('backButton', expect.any(Function));
  });

  it('calls history.back when canGoBack is true', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const historySpy = vi.spyOn(globalThis.history, 'back').mockImplementation(() => {});
    const { useBackButton } = await import('./use-back-button.js');

    renderHook(() => {
      useBackButton();
    });

    expect(capturedCallback).not.toBeNull();
    capturedCallback!({ canGoBack: true });

    expect(historySpy).toHaveBeenCalled();
    historySpy.mockRestore();
  });

  it('calls App.exitApp when canGoBack is false', async () => {
    const { isNative } = await import('../platform.js');
    vi.mocked(isNative).mockReturnValue(true);

    const { App } = await import('@capacitor/app');
    const { useBackButton } = await import('./use-back-button.js');

    renderHook(() => {
      useBackButton();
    });

    expect(capturedCallback).not.toBeNull();
    capturedCallback!({ canGoBack: false });

    expect(App.exitApp).toHaveBeenCalled();
  });
});
