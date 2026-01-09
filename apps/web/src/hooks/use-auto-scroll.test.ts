import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoScroll } from './use-auto-scroll';
import * as React from 'react';

describe('useAutoScroll', () => {
  let mockViewport: HTMLDivElement;
  let viewportRef: React.RefObject<HTMLDivElement | null>;

  beforeEach(() => {
    mockViewport = document.createElement('div');
    Object.defineProperties(mockViewport, {
      scrollTop: { value: 0, writable: true },
      scrollHeight: { value: 1000, writable: true },
      clientHeight: { value: 500, writable: true },
    });
    viewportRef = { current: mockViewport };
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('when streaming starts', () => {
    it('enables auto-scroll when user is at bottom', () => {
      // Simulate user at bottom (scrollTop + clientHeight = scrollHeight)
      Object.defineProperty(mockViewport, 'scrollTop', { value: 500, writable: true });

      const { result } = renderHook(() => useAutoScroll({ isStreaming: true, viewportRef }));

      // Run RAF to trigger initial position check
      act(() => {
        vi.runAllTimers();
      });

      expect(result.current.isAutoScrollEnabled).toBe(true);
    });

    it('enables auto-scroll when user is near bottom (within threshold)', () => {
      // Simulate user near bottom (within 50px threshold)
      Object.defineProperty(mockViewport, 'scrollTop', { value: 460, writable: true });

      const { result } = renderHook(() => useAutoScroll({ isStreaming: true, viewportRef }));

      // Run RAF to trigger initial position check
      act(() => {
        vi.runAllTimers();
      });

      expect(result.current.isAutoScrollEnabled).toBe(true);
    });

    it('disables auto-scroll when user is not at bottom', () => {
      // Simulate user scrolled up
      Object.defineProperty(mockViewport, 'scrollTop', { value: 100, writable: true });

      const { result } = renderHook(() => useAutoScroll({ isStreaming: true, viewportRef }));

      // Run RAF to trigger initial position check
      act(() => {
        vi.runAllTimers();
      });

      expect(result.current.isAutoScrollEnabled).toBe(false);
    });

    it('handles null viewport ref gracefully', () => {
      const nullRef = { current: null };

      const { result } = renderHook(() =>
        useAutoScroll({ isStreaming: true, viewportRef: nullRef })
      );

      // Run RAF to trigger initial position check
      act(() => {
        vi.runAllTimers();
      });

      expect(result.current.isAutoScrollEnabled).toBe(false);
    });
  });

  describe('during streaming', () => {
    it('disables auto-scroll when user scrolls up', () => {
      // Start at bottom
      Object.defineProperty(mockViewport, 'scrollTop', { value: 500, writable: true });

      const { result } = renderHook(() => useAutoScroll({ isStreaming: true, viewportRef }));

      // Run RAF to trigger initial position check
      act(() => {
        vi.runAllTimers();
      });

      expect(result.current.isAutoScrollEnabled).toBe(true);

      // User scrolls up
      Object.defineProperty(mockViewport, 'scrollTop', { value: 100, writable: true });

      act(() => {
        result.current.handleScroll();
      });

      expect(result.current.isAutoScrollEnabled).toBe(false);
    });

    it('re-enables auto-scroll when user scrolls back to bottom', () => {
      // Start at bottom
      Object.defineProperty(mockViewport, 'scrollTop', { value: 500, writable: true });

      const { result } = renderHook(() => useAutoScroll({ isStreaming: true, viewportRef }));

      // Run RAF to trigger initial position check
      act(() => {
        vi.runAllTimers();
      });

      // User scrolls up
      Object.defineProperty(mockViewport, 'scrollTop', { value: 100, writable: true });
      act(() => {
        result.current.handleScroll();
      });
      expect(result.current.isAutoScrollEnabled).toBe(false);

      // User scrolls back to bottom
      Object.defineProperty(mockViewport, 'scrollTop', { value: 500, writable: true });
      act(() => {
        result.current.handleScroll();
      });

      expect(result.current.isAutoScrollEnabled).toBe(true);
    });

    it('does not re-enable when user was not initially at bottom', () => {
      // Start NOT at bottom
      Object.defineProperty(mockViewport, 'scrollTop', { value: 100, writable: true });

      const { result } = renderHook(() => useAutoScroll({ isStreaming: true, viewportRef }));

      // Run RAF to trigger initial position check
      act(() => {
        vi.runAllTimers();
      });

      expect(result.current.isAutoScrollEnabled).toBe(false);

      // User scrolls to bottom
      Object.defineProperty(mockViewport, 'scrollTop', { value: 500, writable: true });
      act(() => {
        result.current.handleScroll();
      });

      // Should NOT enable because user was not at bottom when streaming started
      expect(result.current.isAutoScrollEnabled).toBe(false);
    });
  });

  describe('scrollToBottom', () => {
    it('scrolls viewport to bottom', () => {
      Object.defineProperty(mockViewport, 'scrollTop', { value: 500, writable: true });

      const { result } = renderHook(() => useAutoScroll({ isStreaming: true, viewportRef }));

      // Run RAF to trigger initial position check
      act(() => {
        vi.runAllTimers();
      });

      Object.defineProperty(mockViewport, 'scrollTop', { value: 0, writable: true });

      act(() => {
        result.current.scrollToBottom();
        vi.runAllTimers(); // Run requestAnimationFrame
      });

      expect(mockViewport.scrollTop).toBe(1000);
    });

    it('handles null viewport gracefully', () => {
      const nullRef = { current: null };

      const { result } = renderHook(() =>
        useAutoScroll({ isStreaming: true, viewportRef: nullRef })
      );

      // Run RAF to trigger initial position check
      act(() => {
        vi.runAllTimers();
      });

      // Should not throw
      expect(() => {
        act(() => {
          result.current.scrollToBottom();
          vi.runAllTimers();
        });
      }).not.toThrow();
    });

    it('batches rapid scroll calls with requestAnimationFrame', () => {
      const rafSpy = vi.spyOn(window, 'requestAnimationFrame');
      Object.defineProperty(mockViewport, 'scrollTop', { value: 500, writable: true });

      const { result } = renderHook(() => useAutoScroll({ isStreaming: true, viewportRef }));

      // Run RAF to trigger initial position check (this is the first RAF call)
      act(() => {
        vi.runAllTimers();
      });

      // Call scrollToBottom multiple times rapidly
      act(() => {
        result.current.scrollToBottom();
        result.current.scrollToBottom();
        result.current.scrollToBottom();
      });

      // Should only schedule one additional RAF (total 2: init + scroll)
      expect(rafSpy).toHaveBeenCalledTimes(2);

      act(() => {
        vi.runAllTimers();
      });

      // After RAF completes, can schedule another
      act(() => {
        result.current.scrollToBottom();
      });

      expect(rafSpy).toHaveBeenCalledTimes(3);
    });
  });

  describe('when streaming ends', () => {
    it('resets isAutoScrollEnabled to false', () => {
      Object.defineProperty(mockViewport, 'scrollTop', { value: 500, writable: true });

      const { result, rerender } = renderHook(
        ({ isStreaming }) => useAutoScroll({ isStreaming, viewportRef }),
        { initialProps: { isStreaming: true } }
      );

      // Run RAF to trigger initial position check
      act(() => {
        vi.runAllTimers();
      });

      expect(result.current.isAutoScrollEnabled).toBe(true);

      rerender({ isStreaming: false });

      expect(result.current.isAutoScrollEnabled).toBe(false);
    });
  });

  describe('when not streaming', () => {
    it('handleScroll does nothing', () => {
      Object.defineProperty(mockViewport, 'scrollTop', { value: 500, writable: true });

      const { result } = renderHook(() => useAutoScroll({ isStreaming: false, viewportRef }));

      expect(result.current.isAutoScrollEnabled).toBe(false);

      // Calling handleScroll when not streaming should do nothing
      act(() => {
        result.current.handleScroll();
      });

      expect(result.current.isAutoScrollEnabled).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('cancels pending requestAnimationFrame on unmount', () => {
      const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
      Object.defineProperty(mockViewport, 'scrollTop', { value: 500, writable: true });

      const { result, unmount } = renderHook(() =>
        useAutoScroll({ isStreaming: true, viewportRef })
      );

      // Schedule a scroll
      act(() => {
        result.current.scrollToBottom();
      });

      unmount();

      expect(cancelSpy).toHaveBeenCalled();
    });
  });
});
