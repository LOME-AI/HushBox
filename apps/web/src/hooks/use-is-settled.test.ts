import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import * as React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/stores/streaming-activity', () => ({
  useStreamingActivityStore: vi.fn(),
}));

vi.mock('@/stores/decryption-activity', () => ({
  useDecryptionActivityStore: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
  useAuthStore: vi.fn(),
}));

import { useStreamingActivityStore } from '@/stores/streaming-activity';
import { useDecryptionActivityStore } from '@/stores/decryption-activity';
import { useAuthStore } from '@/lib/auth';
import { useIsSettled } from './use-is-settled.js';

const mockedUseStreamingActivityStore = vi.mocked(useStreamingActivityStore);
const mockedUseDecryptionActivityStore = vi.mocked(useDecryptionActivityStore);
const mockedUseAuthStore = vi.mocked(useAuthStore);

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
    mockedUseDecryptionActivityStore.mockReturnValue(0);
    mockedUseAuthStore.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns false initially even when idle (debounce has not fired)', () => {
    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    expect(result.current).toBe(false);
  });

  it('returns true after debounce period when idle', () => {
    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(result.current).toBe(true);
  });

  it('returns false when auth is loading', () => {
    mockedUseAuthStore.mockReturnValue(true);

    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe(false);
  });

  it('returns false when streams are active', () => {
    mockedUseStreamingActivityStore.mockReturnValue(1);

    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe(false);
  });

  it('transitions from false to true when streams end', () => {
    mockedUseStreamingActivityStore.mockReturnValue(1);

    const { result, rerender } = renderHook(() => useIsSettled(), {
      wrapper: createWrapper(),
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);

    mockedUseStreamingActivityStore.mockReturnValue(0);
    rerender();

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(result.current).toBe(true);
  });

  it('transitions from false to true when auth finishes loading', () => {
    mockedUseAuthStore.mockReturnValue(true);

    const { result, rerender } = renderHook(() => useIsSettled(), {
      wrapper: createWrapper(),
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);

    mockedUseAuthStore.mockReturnValue(false);
    rerender();

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(result.current).toBe(true);
  });

  it('resets to false when activity starts during debounce', () => {
    const { result, rerender } = renderHook(() => useIsSettled(), {
      wrapper: createWrapper(),
    });

    // Advance partway through debounce
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(result.current).toBe(false);

    // Start a stream before debounce completes
    mockedUseStreamingActivityStore.mockReturnValue(1);
    rerender();

    // Complete original debounce window
    act(() => {
      vi.advanceTimersByTime(200);
    });

    expect(result.current).toBe(false);
  });

  it('returns false when decryptions are pending', () => {
    mockedUseDecryptionActivityStore.mockReturnValue(1);

    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe(false);
  });

  it('transitions from false to true when decryptions complete', () => {
    mockedUseDecryptionActivityStore.mockReturnValue(1);

    const { result, rerender } = renderHook(() => useIsSettled(), {
      wrapper: createWrapper(),
    });

    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current).toBe(false);

    mockedUseDecryptionActivityStore.mockReturnValue(0);
    rerender();

    act(() => {
      vi.advanceTimersByTime(600);
    });

    expect(result.current).toBe(true);
  });

  it('returns false when both auth loading and streams active', () => {
    mockedUseAuthStore.mockReturnValue(true);
    mockedUseStreamingActivityStore.mockReturnValue(1);

    const { result } = renderHook(() => useIsSettled(), { wrapper: createWrapper() });

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe(false);
  });
});
