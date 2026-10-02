import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouteErrorScreen } from './route-error-screen';

describe('RouteErrorScreen', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows the app error screen', () => {
    render(<RouteErrorScreen error={new Error('chunk failed to load')} reset={vi.fn()} />);

    expect(screen.getByRole('alert')).toHaveAttribute('data-slot', 'error-boundary-fallback');
  });

  it('retries through the reset the router hands it', async () => {
    const reset = vi.fn();
    render(<RouteErrorScreen error={new Error('chunk failed to load')} reset={reset} />);

    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('centres the error screen in a container that fills the route', () => {
    render(<RouteErrorScreen error={new Error('chunk failed to load')} reset={vi.fn()} />);

    const container = screen.getByRole('alert').parentElement;
    expect(container).toHaveClass('flex', 'min-h-full', 'items-center', 'justify-center');
  });
});
