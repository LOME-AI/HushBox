import { useState, useEffect, useCallback, useRef } from 'react';

interface KeyboardPosition {
  /** Bottom offset in pixels to position above keyboard */
  bottom: number;
  /** Whether the keyboard is currently visible */
  isKeyboardVisible: boolean;
  /** Current viewport height (visual viewport if available, otherwise window) */
  viewportHeight: number;
}

/**
 * Hook to calculate keyboard offset using the Visual Viewport API.
 *
 * On mobile devices (especially iOS Safari), the virtual keyboard doesn't resize
 * the layout viewport - it overlays it from outside. This hook calculates the
 * offset needed to position fixed elements above the keyboard.
 *
 * Uses Visual Viewport API (94%+ browser support) with fallback.
 *
 * @returns { bottom, isKeyboardVisible } - offset in pixels and visibility flag
 */
export function useKeyboardOffset(): KeyboardPosition {
  const [position, setPosition] = useState<KeyboardPosition>({
    bottom: 0,
    isKeyboardVisible: false,
    viewportHeight: 'window' in globalThis ? window.innerHeight : 0,
  });

  const rafId = useRef<number | undefined>(undefined);

  const updatePosition = useCallback(() => {
    if (rafId.current) {
      cancelAnimationFrame(rafId.current);
    }

    rafId.current = requestAnimationFrame(() => {
      const vv = window.visualViewport;
      if (!vv) {
        setPosition({
          bottom: 0,
          isKeyboardVisible: false,
          viewportHeight: window.innerHeight,
        });
        return;
      }

      // Calculate keyboard height from visual viewport
      // window.innerHeight = layout viewport (doesn't change on iOS when keyboard opens)
      // vv.height = visual viewport (shrinks when keyboard opens)
      // vv.offsetTop = scroll offset of visual viewport
      const keyboardHeight = window.innerHeight - vv.height - vv.offsetTop;

      // Threshold of 150px to distinguish keyboard from address bar changes
      const isKeyboardVisible = keyboardHeight > 150;

      setPosition({
        bottom: Math.max(0, keyboardHeight),
        isKeyboardVisible,
        viewportHeight: vv.height,
      });
    });
  }, []);

  useEffect(() => {
    updatePosition();

    const vv = window.visualViewport;
    if (vv) {
      vv.addEventListener('resize', updatePosition);
      vv.addEventListener('scroll', updatePosition);
    }

    // Fallback for browsers without visualViewport
    window.addEventListener('resize', updatePosition);

    return () => {
      if (vv) {
        vv.removeEventListener('resize', updatePosition);
        vv.removeEventListener('scroll', updatePosition);
      }
      window.removeEventListener('resize', updatePosition);
      if (rafId.current) {
        cancelAnimationFrame(rafId.current);
      }
    };
  }, [updatePosition]);

  return position;
}
