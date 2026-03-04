import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useQuery } from '@tanstack/react-query';
import { QueryProvider } from './query-provider';

vi.mock('@tanstack/react-query-devtools', () => ({
  ReactQueryDevtools: () => <div data-testid="react-query-devtools" />,
}));

vi.mock('@/lib/env', () => ({
  env: { isLocalDev: true },
}));

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
