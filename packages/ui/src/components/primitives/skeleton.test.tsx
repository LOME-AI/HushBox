import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useA11yStore } from '../accessibility/store';
import { Skeleton } from './skeleton';

describe('Skeleton', () => {
  beforeEach(() => {
    useA11yStore.getState().reset();
    // Keep the merged reduced-motion signal derived from OS/store only — a
    // contaminated VITE_E2E from a prior e2e run would otherwise force reduced.
    vi.stubEnv('VITE_E2E', '');
  });

  afterEach(() => {
    useA11yStore.getState().reset();
    vi.unstubAllEnvs();
  });

  it('has data-slot attribute', () => {
    render(<Skeleton data-testid="skeleton" />);

    expect(screen.getByTestId('skeleton')).toHaveAttribute('data-slot', 'skeleton');
  });

  it('applies custom className', () => {
    render(<Skeleton className="h-4 w-20" data-testid="skeleton" />);

    expect(screen.getByTestId('skeleton')).toHaveClass('h-4', 'w-20');
  });

  it('hides the placeholder from assistive technology', () => {
    render(<Skeleton data-testid="skeleton" />);

    expect(screen.getByTestId('skeleton')).toHaveAttribute('aria-hidden', 'true');
  });

  it('pulses when motion is not reduced', () => {
    render(<Skeleton data-testid="skeleton" />);

    const skeleton = screen.getByTestId('skeleton');
    expect(skeleton).toHaveAttribute('data-animated', 'true');
    expect(skeleton).toHaveClass('animate-pulse');
  });

  it('drops the pulse when reduced motion is requested', () => {
    act(() => {
      useA11yStore.getState().update({ stopAnimations: true });
    });
    render(<Skeleton data-testid="skeleton" />);

    const skeleton = screen.getByTestId('skeleton');
    expect(skeleton).toHaveAttribute('data-animated', 'false');
    expect(skeleton).not.toHaveClass('animate-pulse');
  });

  it('renders children so a caller can shape a placeholder', () => {
    render(
      <Skeleton>
        <span>inner</span>
      </Skeleton>
    );

    expect(screen.getByText('inner')).toBeInTheDocument();
  });
});
