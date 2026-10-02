import { beforeEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useSegmentOpen, useSegmentViewState } from '@/components/chat/segments/segment-view-state';

beforeEach(() => {
  useSegmentViewState.setState({ open: new Set() });
});

describe('useSegmentOpen', () => {
  it('starts closed', () => {
    const { result } = renderHook(() => useSegmentOpen('m-1', 'reasoning:0'));
    expect(result.current[0]).toBe(false);
  });

  it('opens on the first toggle and closes on the second', () => {
    const { result } = renderHook(() => useSegmentOpen('m-1', 'reasoning:0'));
    act(() => {
      result.current[1]();
    });
    expect(result.current[0]).toBe(true);
    act(() => {
      result.current[1]();
    });
    expect(result.current[0]).toBe(false);
  });

  it('keeps a block open across an unmount and a remount under the same message', () => {
    const first = renderHook(() => useSegmentOpen('m-1', 'webSearch:0'));
    act(() => {
      first.result.current[1]();
    });
    first.unmount();
    const second = renderHook(() => useSegmentOpen('m-1', 'webSearch:0'));
    expect(second.result.current[0]).toBe(true);
  });

  it('keeps the same key in another message independent', () => {
    const one = renderHook(() => useSegmentOpen('m-1', 'webSearch:0'));
    const other = renderHook(() => useSegmentOpen('m-2', 'webSearch:0'));
    act(() => {
      one.result.current[1]();
    });
    expect(other.result.current[0]).toBe(false);
  });
});
