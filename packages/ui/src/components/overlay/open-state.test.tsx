import { act, renderHook } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useOpenedValue, useOpenState } from './open-state';

interface LatchProps {
  open: boolean;
  current: string;
}

function renderLatch(initial: LatchProps): {
  result: { current: string };
  rerender: (props: LatchProps) => void;
} {
  return renderHook(({ open, current }: LatchProps) => useOpenedValue(open, current), {
    initialProps: initial,
  });
}

describe('useOpenedValue', () => {
  it('keeps the value it was open with as it closes', () => {
    const { result, rerender } = renderLatch({ open: true, current: 'sheet' });

    rerender({ open: false, current: 'dialog' });

    expect(result.current).toBe('sheet');
  });

  it('takes the current value as it opens', () => {
    const { result, rerender } = renderLatch({ open: false, current: 'sheet' });

    rerender({ open: true, current: 'dialog' });

    expect(result.current).toBe('dialog');
  });

  it('holds the value it opened with while it stays open', () => {
    const { result, rerender } = renderLatch({ open: true, current: 'sheet' });

    rerender({ open: true, current: 'dialog' });

    expect(result.current).toBe('sheet');
  });

  it('reads the current value again at the next open', () => {
    const { result, rerender } = renderLatch({ open: true, current: 'sheet' });
    rerender({ open: true, current: 'dialog' });
    rerender({ open: false, current: 'dialog' });

    rerender({ open: true, current: 'dialog' });

    expect(result.current).toBe('dialog');
  });
});

describe('useOpenState', () => {
  it('starts closed when uncontrolled', () => {
    const { result } = renderHook(() => useOpenState());

    expect(result.current[0]).toBe(false);
  });

  it('holds its own state when uncontrolled', () => {
    const { result } = renderHook(() => useOpenState());

    act(() => {
      result.current[1](true);
    });

    expect(result.current[0]).toBe(true);
  });

  it('reports each change when uncontrolled', () => {
    const onOpenChange = vi.fn();
    const { result } = renderHook(() => useOpenState(undefined, onOpenChange));

    act(() => {
      result.current[1](true);
    });

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it('keeps the controlled value over a requested change', () => {
    const { result } = renderHook(() => useOpenState(false, vi.fn()));

    act(() => {
      result.current[1](true);
    });

    expect(result.current[0]).toBe(false);
  });

  it('reports a requested change when controlled', () => {
    const onOpenChange = vi.fn();
    const { result } = renderHook(() => useOpenState(false, onOpenChange));

    act(() => {
      result.current[1](true);
    });

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });
});
