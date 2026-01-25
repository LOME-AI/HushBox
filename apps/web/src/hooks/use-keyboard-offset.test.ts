import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboardOffset } from './use-keyboard-offset';

describe('useKeyboardOffset', () => {
  const originalInnerHeight = window.innerHeight;
  let mockVisualViewport: {
    height: number;
    offsetTop: number;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
  };
  let resizeCallback: (() => void) | null = null;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    // Mock window.innerHeight
    Object.defineProperty(globalThis, 'innerHeight', {
      value: 844,
      writable: true,
      configurable: true,
    });

    // Mock visualViewport
    mockVisualViewport = {
      height: 844,
      offsetTop: 0,
      addEventListener: vi.fn((event: string, callback: () => void) => {
        if (event === 'resize') {
          resizeCallback = callback;
        }
      }),
      removeEventListener: vi.fn(),
    };

    Object.defineProperty(globalThis, 'visualViewport', {
      value: mockVisualViewport,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(globalThis, 'innerHeight', {
      value: originalInnerHeight,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(globalThis, 'visualViewport', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    resizeCallback = null;
  });

  it('returns zero offset when keyboard is not visible', async () => {
    const { result } = renderHook(() => useKeyboardOffset());

    // Wait for RAF to execute
    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
    });

    expect(result.current.bottom).toBe(0);
    expect(result.current.isKeyboardVisible).toBe(false);
  });

  it('calculates keyboard offset when keyboard is visible', async () => {
    const { result } = renderHook(() => useKeyboardOffset());

    // Simulate keyboard opening (reduces visual viewport height)
    mockVisualViewport.height = 444; // 400px keyboard

    await act(async () => {
      resizeCallback?.();
      await vi.advanceTimersToNextTimerAsync();
    });

    expect(result.current.bottom).toBe(400);
    expect(result.current.isKeyboardVisible).toBe(true);
  });

  it('does not treat small height changes as keyboard', async () => {
    const { result } = renderHook(() => useKeyboardOffset());

    // Simulate small viewport change (address bar showing)
    mockVisualViewport.height = 744; // Only 100px change

    await act(async () => {
      resizeCallback?.();
      await vi.advanceTimersToNextTimerAsync();
    });

    expect(result.current.bottom).toBe(100);
    expect(result.current.isKeyboardVisible).toBe(false); // Below 150px threshold
  });

  it('returns zero offset when visualViewport is not available', async () => {
    Object.defineProperty(globalThis, 'visualViewport', {
      value: null,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useKeyboardOffset());

    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
    });

    expect(result.current.bottom).toBe(0);
    expect(result.current.isKeyboardVisible).toBe(false);
  });

  it('registers event listeners on mount', async () => {
    renderHook(() => useKeyboardOffset());

    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
    });

    expect(mockVisualViewport.addEventListener).toHaveBeenCalledWith(
      'resize',
      expect.any(Function)
    );
    expect(mockVisualViewport.addEventListener).toHaveBeenCalledWith(
      'scroll',
      expect.any(Function)
    );
  });

  it('removes event listeners on unmount', async () => {
    const { unmount } = renderHook(() => useKeyboardOffset());

    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
    });

    unmount();

    expect(mockVisualViewport.removeEventListener).toHaveBeenCalledWith(
      'resize',
      expect.any(Function)
    );
    expect(mockVisualViewport.removeEventListener).toHaveBeenCalledWith(
      'scroll',
      expect.any(Function)
    );
  });

  it('accounts for visualViewport offsetTop', async () => {
    const { result } = renderHook(() => useKeyboardOffset());

    // Simulate keyboard + scroll offset
    mockVisualViewport.height = 444;
    mockVisualViewport.offsetTop = 50;

    await act(async () => {
      resizeCallback?.();
      await vi.advanceTimersToNextTimerAsync();
    });

    // 844 - 444 - 50 = 350
    expect(result.current.bottom).toBe(350);
  });

  it('returns viewport height', async () => {
    const { result } = renderHook(() => useKeyboardOffset());

    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
    });

    expect(result.current.viewportHeight).toBe(844);
  });

  it('updates viewport height when visualViewport changes', async () => {
    const { result } = renderHook(() => useKeyboardOffset());

    // Simulate keyboard opening
    mockVisualViewport.height = 500;

    await act(async () => {
      resizeCallback?.();
      await vi.advanceTimersToNextTimerAsync();
    });

    expect(result.current.viewportHeight).toBe(500);
  });

  it('returns window.innerHeight when visualViewport not available', async () => {
    Object.defineProperty(globalThis, 'visualViewport', {
      value: null,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(() => useKeyboardOffset());

    await act(async () => {
      await vi.advanceTimersToNextTimerAsync();
    });

    expect(result.current.viewportHeight).toBe(844); // Falls back to window.innerHeight
  });
});
