import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useInteractionTracker } from './use-interaction-tracker';

describe('useInteractionTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('resetOnSubmit', () => {
    it('resets hasInteractedRef to false', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: true }));

      // Simulate interaction
      act(() => {
        document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(result.current.hasInteractedRef.current).toBe(true);

      // Reset
      act(() => {
        result.current.resetOnSubmit();
      });

      expect(result.current.hasInteractedRef.current).toBe(false);
    });
  });

  describe('when isTracking is true', () => {
    it('sets hasInteractedRef to true after click event', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: true }));

      expect(result.current.hasInteractedRef.current).toBe(false);

      act(() => {
        document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(result.current.hasInteractedRef.current).toBe(true);
    });

    it('sets hasInteractedRef to true after keydown event', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: true }));

      expect(result.current.hasInteractedRef.current).toBe(false);

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      });

      expect(result.current.hasInteractedRef.current).toBe(true);
    });

    it('sets hasInteractedRef to true after touchstart event', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: true }));

      expect(result.current.hasInteractedRef.current).toBe(false);

      act(() => {
        document.dispatchEvent(new TouchEvent('touchstart'));
      });

      expect(result.current.hasInteractedRef.current).toBe(true);
    });
  });

  describe('when isTracking is false', () => {
    it('does not track click events', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: false }));

      expect(result.current.hasInteractedRef.current).toBe(false);

      act(() => {
        document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(result.current.hasInteractedRef.current).toBe(false);
    });

    it('does not track keydown events', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: false }));

      expect(result.current.hasInteractedRef.current).toBe(false);

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      });

      expect(result.current.hasInteractedRef.current).toBe(false);
    });

    it('does not track touchstart events', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: false }));

      expect(result.current.hasInteractedRef.current).toBe(false);

      act(() => {
        document.dispatchEvent(new TouchEvent('touchstart'));
      });

      expect(result.current.hasInteractedRef.current).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('removes event listeners on unmount', () => {
      const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

      const { unmount } = renderHook(() => useInteractionTracker({ isTracking: true }));

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith('click', expect.any(Function), {
        capture: true,
      });
      expect(removeEventListenerSpy).toHaveBeenCalledWith('keydown', expect.any(Function), {
        capture: true,
      });
      expect(removeEventListenerSpy).toHaveBeenCalledWith('touchstart', expect.any(Function), {
        capture: true,
      });
    });

    it('removes event listeners when isTracking changes to false', () => {
      const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');

      const { rerender } = renderHook(({ isTracking }) => useInteractionTracker({ isTracking }), {
        initialProps: { isTracking: true },
      });

      rerender({ isTracking: false });

      expect(removeEventListenerSpy).toHaveBeenCalledWith('click', expect.any(Function), {
        capture: true,
      });
    });
  });

  describe('state persistence', () => {
    it('preserves hasInteractedRef state when isTracking toggles', () => {
      const { result, rerender } = renderHook(
        ({ isTracking }) => useInteractionTracker({ isTracking }),
        { initialProps: { isTracking: true } }
      );

      // Interact
      act(() => {
        document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(result.current.hasInteractedRef.current).toBe(true);

      // Stop tracking
      rerender({ isTracking: false });

      // State should still be true
      expect(result.current.hasInteractedRef.current).toBe(true);
    });
  });
});
