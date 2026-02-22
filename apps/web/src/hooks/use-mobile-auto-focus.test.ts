import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

const { mockUseIsMobile } = vi.hoisted(() => ({
  mockUseIsMobile: vi.fn(),
}));

vi.mock('@/hooks/use-is-mobile', () => ({
  useIsMobile: mockUseIsMobile,
}));

import { useMobileAutoFocus } from './use-mobile-auto-focus';

describe('useMobileAutoFocus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns a function', () => {
    mockUseIsMobile.mockReturnValue(false);
    const { result } = renderHook(() => useMobileAutoFocus());
    expect(typeof result.current).toBe('function');
  });

  it('prevents default on mobile', () => {
    mockUseIsMobile.mockReturnValue(true);
    const { result } = renderHook(() => useMobileAutoFocus());

    const event = { preventDefault: vi.fn() } as unknown as Event;
    result.current(event);

    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('does not prevent default on desktop', () => {
    mockUseIsMobile.mockReturnValue(false);
    const { result } = renderHook(() => useMobileAutoFocus());

    const event = { preventDefault: vi.fn() } as unknown as Event;
    result.current(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('returns a stable reference when isMobile does not change', () => {
    mockUseIsMobile.mockReturnValue(false);
    const { result, rerender } = renderHook(() => useMobileAutoFocus());

    const first = result.current;
    rerender();

    expect(result.current).toBe(first);
  });
});
