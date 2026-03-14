import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/stores/streaming-activity', () => ({
  useStreamingActivityStore: vi.fn(),
}));

import { useStreamingActivityStore } from '@/stores/streaming-activity';
import { useIsSettled } from './use-is-settled.js';

const mockedUseStreamingActivityStore = vi.mocked(useStreamingActivityStore);

function createWrapper(): React.FC<{ children: React.ReactNode }> {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  function Wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
    return React.createElement(QueryClientProvider, { client: queryClient }, children);
  }
  return Wrapper;
}

describe('useIsSettled', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedUseStreamingActivityStore.mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns false initially even when idle (debounce has not fired)', () => {
    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    expect(result.current).toBe(false);
  });

  it('returns true after debounce period when idle', async () => {
    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current).toBe(true);
  });

  it('returns false when streams are active', async () => {
    mockedUseStreamingActivityStore.mockReturnValue(1);

    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe(false);
  });

  it('transitions from false to true when streams end', async () => {
    mockedUseStreamingActivityStore.mockReturnValue(1);

    const { result, rerender } = renderHook(() => useIsSettled(), {
      wrapper: createWrapper(),
    });

    await act(async () => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);

    mockedUseStreamingActivityStore.mockReturnValue(0);
    rerender();

    await act(async () => {
      vi.advanceTimersByTime(300);
    });

    expect(result.current).toBe(true);
  });

  it('resets to false when activity starts during debounce', async () => {
    const { result, rerender } = renderHook(() => useIsSettled(), {
      wrapper: createWrapper(),
    });

    // Advance partway through debounce
    await act(async () => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe(false);

    // Start a stream before debounce completes
    mockedUseStreamingActivityStore.mockReturnValue(1);
    rerender();

    // Complete original debounce window
    await act(async () => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current).toBe(false);
  });
});
