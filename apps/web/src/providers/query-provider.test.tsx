import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import { QueryProvider, shouldRetryQuery } from './query-provider';
import { ApiError } from '@/lib/api';

vi.mock('@tanstack/react-query-devtools', () => ({
  ReactQueryDevtools: () => <div data-testid="react-query-devtools" />,
}));

vi.mock('@/lib/env', () => ({
  env: { isLocalDev: true },
}));

// Test component that uses useQuery to verify context is available

function TestQueryConsumer(): React.ReactNode {
  const { isLoading } = useQuery({
    queryKey: ['test'],
    queryFn: () => Promise.resolve('test'),
    enabled: false,
  });
  return <div data-testid="consumer">Loading: {String(isLoading)}</div>;
}

describe('QueryProvider', () => {
  let originalWebdriver: boolean;

  beforeEach(() => {
    originalWebdriver = navigator.webdriver;
  });

  afterEach(() => {
    Object.defineProperty(navigator, 'webdriver', {
      value: originalWebdriver,
      configurable: true,
    });
  });

  it('renders children', () => {
    render(
      <QueryProvider>
        <div data-testid="child">Hello</div>
      </QueryProvider>
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('provides QueryClient context to children', () => {
    render(
      <QueryProvider>
        <TestQueryConsumer />
      </QueryProvider>
    );

    // If context wasn't provided, useQuery would throw
    expect(screen.getByTestId('consumer')).toBeInTheDocument();
  });

  it('does not render devtools when navigator.webdriver is true', () => {
    Object.defineProperty(navigator, 'webdriver', {
      value: true,
      configurable: true,
    });

    render(
      <QueryProvider>
        <div>child</div>
      </QueryProvider>
    );

    expect(screen.queryByTestId('react-query-devtools')).not.toBeInTheDocument();
  });

  it('renders devtools in local dev when not automated', () => {
    Object.defineProperty(navigator, 'webdriver', {
      value: false,
      configurable: true,
    });

    render(
      <QueryProvider>
        <div>child</div>
      </QueryProvider>
    );

    expect(screen.getByTestId('react-query-devtools')).toBeInTheDocument();
  });
});

describe('shouldRetryQuery', () => {
  it('does not retry 404 errors', () => {
    const error = new ApiError('CONVERSATION_NOT_FOUND', 404);
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it('does not retry 401 errors', () => {
    const error = new ApiError('UNAUTHORIZED', 401);
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it('does not retry 403 errors', () => {
    const error = new ApiError('FORBIDDEN', 403);
    expect(shouldRetryQuery(0, error)).toBe(false);
  });

  it('retries non-ApiError once', () => {
    const error = new Error('Network error');
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(1, error)).toBe(false);
  });

  it('retries 500 errors once', () => {
    const error = new ApiError('INTERNAL', 500);
    expect(shouldRetryQuery(0, error)).toBe(true);
    expect(shouldRetryQuery(1, error)).toBe(false);
  });
});
