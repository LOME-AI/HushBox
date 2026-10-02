import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ConsoleErrorFallback } from './console-error-fallback';
import { TEST_IDS } from './test-ids';

describe('ConsoleErrorFallback', () => {
  it('shows what went wrong', () => {
    render(<ConsoleErrorFallback error={new Error('audit.md is unreadable')} reset={() => {}} />);

    expect(screen.getByTestId(TEST_IDS.consoleErrorFallback)).toBeInTheDocument();
    expect(screen.getByText('audit.md is unreadable')).toBeInTheDocument();
  });

  it('says something even when the boundary caught no error object', () => {
    render(<ConsoleErrorFallback error={null} reset={() => {}} />);

    expect(screen.getByText('Unknown failure')).toBeInTheDocument();
  });

  /**
   * The only control on the screen a reader reaches after the console has
   * stopped, so it takes the console's full control size rather than the
   * compact one. Nothing here measures anything; the size the button asks for
   * is what is reachable.
   */
  it('offers the retry at the console’s full control size', () => {
    render(<ConsoleErrorFallback error={null} reset={() => {}} />);

    expect(screen.getByRole('button', { name: 'Try again' })).toHaveClass('h-9');
  });

  it('retries through the boundary reset', () => {
    const reset = vi.fn();
    render(<ConsoleErrorFallback error={null} reset={reset} />);

    screen.getByRole('button', { name: 'Try again' }).click();

    expect(reset).toHaveBeenCalledTimes(1);
  });
});
