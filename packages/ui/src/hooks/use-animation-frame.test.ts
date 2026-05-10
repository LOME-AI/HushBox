import { renderHook } from '@testing-library/react';
import { describe, expect, it, afterEach, vi } from 'vitest';
import { useAnimationFrame } from './use-animation-frame';

describe('useAnimationFrame', () => {
  const originalRAF = globalThis.requestAnimationFrame;
  const originalCAF = globalThis.cancelAnimationFrame;
  const originalMatchMedia = globalThis.matchMedia;

  let rafCallbacks: FrameRequestCallback[];
  let nextRafId: number;

  function setupRAF(): {
    requestSpy: ReturnType<typeof vi.fn>;
    cancelSpy: ReturnType<typeof vi.fn>;
  } {
    rafCallbacks = [];
    nextRafId = 1;
    const requestSpy = vi.fn((callback: FrameRequestCallback) => {
      rafCallbacks.push(callback);
      return nextRafId++;
    });
    const cancelSpy = vi.fn();
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      writable: true,
      configurable: true,
      value: requestSpy,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      writable: true,
      configurable: true,
      value: cancelSpy,
    });
    return { requestSpy, cancelSpy };
  }

  function setupMatchMedia(matches: boolean): ReturnType<typeof vi.fn> {
    const mockMatchMedia = vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      configurable: true,
      value: mockMatchMedia,
    });
    return mockMatchMedia;
  }

  function tickFrame(timestamp: number): void {
    const callback = rafCallbacks.shift();
    if (callback) callback(timestamp);
  }

  afterEach(() => {
    Object.defineProperty(globalThis, 'requestAnimationFrame', {
      writable: true,
      configurable: true,
      value: originalRAF,
    });
    Object.defineProperty(globalThis, 'cancelAnimationFrame', {
      writable: true,
      configurable: true,
      value: originalCAF,
    });
    Object.defineProperty(globalThis, 'matchMedia', {
      writable: true,
      configurable: true,
      value: originalMatchMedia,
    });
    vi.restoreAllMocks();
  });

  it('invokes callback with timestamp on each animation frame', () => {
    setupRAF();
    setupMatchMedia(false);
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback);
    });

    tickFrame(100);
    tickFrame(200);
    tickFrame(300);

    expect(callback).toHaveBeenCalledTimes(3);
    expect(callback).toHaveBeenNthCalledWith(1, 100);
    expect(callback).toHaveBeenNthCalledWith(2, 200);
    expect(callback).toHaveBeenNthCalledWith(3, 300);
  });

  it('schedules next frame after each tick (continuous loop)', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(false);

    renderHook(() => {
      useAnimationFrame(vi.fn());
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);

    tickFrame(16);
    expect(requestSpy).toHaveBeenCalledTimes(2);

    tickFrame(32);
    expect(requestSpy).toHaveBeenCalledTimes(3);
  });

  it('does not tick when paused=true', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(false);
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback, { paused: true });
    });

    expect(requestSpy).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('does not tick when respectMotion=true and prefers-reduced-motion matches', () => {
    const { requestSpy } = setupRAF();
    const mockMatchMedia = setupMatchMedia(true);
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback, { respectMotion: true });
    });

    expect(mockMatchMedia).toHaveBeenCalledWith('(prefers-reduced-motion: reduce)');
    expect(requestSpy).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('defaults respectMotion to true (reduced motion blocks ticks)', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(true);
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback);
    });

    expect(requestSpy).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
  });

  it('still ticks when respectMotion=false even if prefers-reduced-motion matches', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(true);
    const callback = vi.fn();

    renderHook(() => {
      useAnimationFrame(callback, { respectMotion: false });
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);

    tickFrame(50);
    expect(callback).toHaveBeenCalledWith(50);
  });

  it('cancels in-flight rAF when component unmounts', () => {
    const { requestSpy, cancelSpy } = setupRAF();
    setupMatchMedia(false);

    const { unmount } = renderHook(() => {
      useAnimationFrame(vi.fn());
    });

    expect(requestSpy).toHaveBeenCalledTimes(1);
    const scheduledId = requestSpy.mock.results[0]?.value as number;

    unmount();

    expect(cancelSpy).toHaveBeenCalledWith(scheduledId);
  });

  it('uses the latest callback closure without re-subscribing rAF', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(false);

    const first = vi.fn();
    const second = vi.fn();

    const { rerender } = renderHook(
      ({ cb }: { cb: (timestamp: number) => void }) => {
        useAnimationFrame(cb);
      },
      { initialProps: { cb: first } }
    );

    expect(requestSpy).toHaveBeenCalledTimes(1);

    rerender({ cb: second });

    // Effect should not re-subscribe just because callback identity changed.
    expect(requestSpy).toHaveBeenCalledTimes(1);

    tickFrame(123);

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(123);
  });

  it('re-subscribes rAF when paused changes from true to false', () => {
    const { requestSpy } = setupRAF();
    setupMatchMedia(false);

    const { rerender } = renderHook(
      ({ paused }: { paused: boolean }) => {
        useAnimationFrame(vi.fn(), { paused });
      },
      { initialProps: { paused: true } }
    );

    expect(requestSpy).not.toHaveBeenCalled();

    rerender({ paused: false });

    expect(requestSpy).toHaveBeenCalledTimes(1);
  });

  it('does not crash when window.matchMedia is unavailable', () => {
    const { requestSpy } = setupRAF();
    // Simulate environment where matchMedia API is missing entirely.
    // Use `delete` so the `'matchMedia' in window` guard returns false.
    // @ts-expect-error — intentionally removing for test
    delete globalThis.matchMedia;

    const callback = vi.fn();

    expect(() => {
      renderHook(() => {
        useAnimationFrame(callback);
      });
    }).not.toThrow();

    // No matchMedia means we can't detect reduced motion → tick anyway.
    expect(requestSpy).toHaveBeenCalledTimes(1);

    tickFrame(10);
    expect(callback).toHaveBeenCalledWith(10);
  });
});
