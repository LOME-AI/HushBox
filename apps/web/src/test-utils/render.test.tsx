import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import { useQueryClient } from '@tanstack/react-query';
import { useTheme } from '@/providers/theme-provider';
import { renderWithProviders } from './render';

function ReadsQueryClient(): React.JSX.Element {
  // useQueryClient throws when no QueryClientProvider is in the tree, so reaching
  // this render at all proves the harness supplied one. Surface a client method
  // to confirm it is a real QueryClient rather than asserting truthiness.
  const client = useQueryClient();
  return (
    <div data-testid="probe">
      {typeof client.getQueryData === 'function' ? 'has-client' : 'no-client'}
    </div>
  );
}

function ReadsTheme(): React.JSX.Element {
  const { mode } = useTheme();
  return <div data-testid="theme">{mode}</div>;
}

describe('renderWithProviders', () => {
  it('renders the given UI', () => {
    renderWithProviders(<div data-testid="child">hello</div>);
    expect(screen.getByTestId('child')).toHaveTextContent('hello');
  });

  it('provides a real QueryClient via context', () => {
    renderWithProviders(<ReadsQueryClient />);
    expect(screen.getByTestId('probe')).toHaveTextContent('has-client');
  });

  it('provides the real ThemeProvider context', () => {
    renderWithProviders(<ReadsTheme />);
    expect(screen.getByTestId('theme')).toHaveTextContent('light');
  });

  it('gives each render an isolated QueryClient', () => {
    let firstClient: ReturnType<typeof useQueryClient> | undefined;
    let secondClient: ReturnType<typeof useQueryClient> | undefined;

    function Capture({ sink }: { sink: (c: ReturnType<typeof useQueryClient>) => void }): null {
      sink(useQueryClient());
      return null;
    }

    const first = renderWithProviders(
      <Capture
        sink={(c) => {
          firstClient = c;
        }}
      />
    );
    first.unmount();
    renderWithProviders(
      <Capture
        sink={(c) => {
          secondClient = c;
        }}
      />
    );

    expect(firstClient).toBeDefined();
    expect(secondClient).toBeDefined();
    expect(firstClient).not.toBe(secondClient);
  });

  it('returns a QueryClient handle for cache assertions', () => {
    const { queryClient } = renderWithProviders(<div />);
    queryClient.setQueryData(['probe'], 'value');
    expect(queryClient.getQueryData(['probe'])).toBe('value');
  });
});
