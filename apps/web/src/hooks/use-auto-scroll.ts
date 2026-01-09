import { useState, useCallback, useEffect, useRef } from 'react';

const SCROLL_THRESHOLD = 50;

function isAtBottom(element: HTMLElement): boolean {
  const { scrollTop, scrollHeight, clientHeight } = element;
  return scrollHeight - scrollTop - clientHeight <= SCROLL_THRESHOLD;
}

interface UseAutoScrollOptions {
  isStreaming: boolean;
  viewportRef: React.RefObject<HTMLDivElement | null>;
}

interface UseAutoScrollResult {
  handleScroll: () => void;
  scrollToBottom: () => void;
  isAutoScrollEnabled: boolean;
  isAutoScrollEnabledRef: React.RefObject<boolean>;
}

export function useAutoScroll({
  isStreaming,
  viewportRef,
}: UseAutoScrollOptions): UseAutoScrollResult {
  const [isAutoScrollEnabled, setIsAutoScrollEnabled] = useState(false);
  // Synchronous ref that gets updated immediately (bypasses React's async state updates)
  // This is needed because onToken callbacks fire faster than React can re-render
  const isAutoScrollEnabledRef = useRef(false);
  const wasAtBottomWhenStreamingStartedRef = useRef(false);
  const rafIdRef = useRef<number | null>(null);

  // Ref to track RAF for initial position check
  const initRafIdRef = useRef<number | null>(null);

  // Track whether we're performing a programmatic scroll (to distinguish from user scrolls)
  // When this is true, scroll events that result in "at bottom" should be ignored
  // because they came from our RAF, not from user scrolling back to bottom
  const isAutoScrollingRef = useRef(false);

  // Track last scroll position to detect scroll direction
  const lastScrollTopRef = useRef(0);

  // When streaming starts/ends, check position and update state
  useEffect(() => {
    if (isStreaming) {
      // Cancel any pending RAF from previous stream
      if (initRafIdRef.current !== null) {
        cancelAnimationFrame(initRafIdRef.current);
      }

      // Use RAF to ensure DOM has updated before checking position
      initRafIdRef.current = requestAnimationFrame(() => {
        initRafIdRef.current = null;
        const viewport = viewportRef.current;
        if (viewport) {
          const atBottom = isAtBottom(viewport);
          wasAtBottomWhenStreamingStartedRef.current = atBottom;
          setIsAutoScrollEnabled(atBottom);
          isAutoScrollEnabledRef.current = atBottom;
          // Initialize lastScrollTop to current position for scroll direction detection
          lastScrollTopRef.current = viewport.scrollTop;
        } else {
          wasAtBottomWhenStreamingStartedRef.current = false;
          setIsAutoScrollEnabled(false);
          isAutoScrollEnabledRef.current = false;
        }
      });
    } else {
      // Cancel any pending RAF
      if (initRafIdRef.current !== null) {
        cancelAnimationFrame(initRafIdRef.current);
        initRafIdRef.current = null;
      }
      // Reset when streaming ends
      setIsAutoScrollEnabled(false);
      isAutoScrollEnabledRef.current = false;
      wasAtBottomWhenStreamingStartedRef.current = false;
    }
  }, [isStreaming, viewportRef]);

  const handleScroll = useCallback(() => {
    if (!isStreaming || !viewportRef.current) return;

    const viewport = viewportRef.current;
    const currentScrollTop = viewport.scrollTop;
    const prevScrollTop = lastScrollTopRef.current;
    lastScrollTopRef.current = currentScrollTop;

    // CRITICAL: Detect scroll-UP FIRST, even during programmatic scrolls
    // This ensures user can ALWAYS break away by scrolling up
    const scrolledUp = currentScrollTop < prevScrollTop - 5; // 5px tolerance

    if (scrolledUp) {
      // User explicitly scrolled up - disable auto-scroll immediately
      isAutoScrollEnabledRef.current = false;
      setIsAutoScrollEnabled(false);

      // Cancel any pending scroll RAF to prevent "pulling" user back down
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      return;
    }

    // For non-upward scrolls, ignore programmatic scroll events
    // (only for re-enable logic - we don't want our own scrolls to trigger re-enable)
    if (isAutoScrollingRef.current) return;

    // Check if user scrolled back to bottom (for re-enabling auto-scroll)
    const atBottom = isAtBottom(viewport);

    if (atBottom && wasAtBottomWhenStreamingStartedRef.current) {
      // User scrolled back to bottom - re-enable auto-scroll
      setIsAutoScrollEnabled(true);
      isAutoScrollEnabledRef.current = true;
    }
  }, [isStreaming, viewportRef]);

  const scrollToBottom = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    // Cancel any pending RAF and schedule a new one
    // This ensures we scroll to the LATEST height, not stale height from when RAF was first scheduled
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current);
    }

    // Mark as programmatic scroll BEFORE scheduling RAF
    // This flag persists until we explicitly clear it, ensuring all scroll events
    // from our programmatic scrolls are ignored
    isAutoScrollingRef.current = true;

    rafIdRef.current = requestAnimationFrame(() => {
      if (viewportRef.current) {
        viewportRef.current.scrollTop = viewportRef.current.scrollHeight;
        // Update lastScrollTop so scroll direction detection works correctly
        lastScrollTopRef.current = viewportRef.current.scrollTop;
      }
      rafIdRef.current = null;
      // Clear flag after RAF completes and scroll event has fired
      // Using double RAF ensures scroll event has definitely been processed
      requestAnimationFrame(() => {
        isAutoScrollingRef.current = false;
      });
    });
  }, [viewportRef]);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
      }
      if (initRafIdRef.current !== null) {
        cancelAnimationFrame(initRafIdRef.current);
      }
    };
  }, []);

  return { handleScroll, scrollToBottom, isAutoScrollEnabled, isAutoScrollEnabledRef };
}
