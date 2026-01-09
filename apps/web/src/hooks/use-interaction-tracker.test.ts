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
    it('resets hasInteractedSinceSubmit to false', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: true }));

      // Simulate interaction
      act(() => {
        document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(result.current.hasInteractedSinceSubmit).toBe(true);

      // Reset
      act(() => {
        result.current.resetOnSubmit();
      });

      expect(result.current.hasInteractedSinceSubmit).toBe(false);
    });
  });

  describe('when isTracking is true', () => {
    it('sets hasInteractedSinceSubmit to true after click event', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: true }));

      expect(result.current.hasInteractedSinceSubmit).toBe(false);

      act(() => {
        document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(result.current.hasInteractedSinceSubmit).toBe(true);
    });

    it('sets hasInteractedSinceSubmit to true after keydown event', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: true }));

      expect(result.current.hasInteractedSinceSubmit).toBe(false);

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      });

      expect(result.current.hasInteractedSinceSubmit).toBe(true);
    });

    it('sets hasInteractedSinceSubmit to true after touchstart event', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: true }));

      expect(result.current.hasInteractedSinceSubmit).toBe(false);

      act(() => {
        document.dispatchEvent(new TouchEvent('touchstart'));
      });

      expect(result.current.hasInteractedSinceSubmit).toBe(true);
    });
  });

  describe('when isTracking is false', () => {
    it('does not track click events', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: false }));

      expect(result.current.hasInteractedSinceSubmit).toBe(false);

      act(() => {
        document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(result.current.hasInteractedSinceSubmit).toBe(false);
    });

    it('does not track keydown events', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: false }));

      expect(result.current.hasInteractedSinceSubmit).toBe(false);

      act(() => {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
      });

      expect(result.current.hasInteractedSinceSubmit).toBe(false);
    });

    it('does not track touchstart events', () => {
      const { result } = renderHook(() => useInteractionTracker({ isTracking: false }));

      expect(result.current.hasInteractedSinceSubmit).toBe(false);

      act(() => {
        document.dispatchEvent(new TouchEvent('touchstart'));
      });

      expect(result.current.hasInteractedSinceSubmit).toBe(false);
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
    it('preserves hasInteractedSinceSubmit state when isTracking toggles', () => {
      const { result, rerender } = renderHook(
        ({ isTracking }) => useInteractionTracker({ isTracking }),
        { initialProps: { isTracking: true } }
      );

      // Interact
      act(() => {
        document.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });

      expect(result.current.hasInteractedSinceSubmit).toBe(true);

      // Stop tracking
      rerender({ isTracking: false });

      // State should still be true
      expect(result.current.hasInteractedSinceSubmit).toBe(true);
    });
  });
});
