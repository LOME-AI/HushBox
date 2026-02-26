import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import { QueryProvider, shouldRetryQuery } from './query-provider';
import { ApiError } from '@/lib/api';

// Test component that uses useQuery to verify context is available
// eslint-disable-next-line sonarjs/function-return-type -- test component
function TestQueryConsumer(): React.ReactNode {
  const { isLoading } = useQuery({
    queryKey: ['test'],
    queryFn: () => Promise.resolve('test'),
    enabled: false,
  });
  return <div data-testid="consumer">Loading: {String(isLoading)}</div>;
}

describe('QueryProvider', () => {
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
