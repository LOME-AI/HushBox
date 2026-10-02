import { render, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useA11yStore } from '../accessibility/store';
import { Spinner } from './spinner';

function spinnerIn(container: HTMLElement): HTMLElement {
  const spinner = container.querySelector<HTMLElement>('[data-slot="spinner"]');
  if (spinner === null) throw new Error('no spinner rendered');
  return spinner;
}

describe('Spinner', () => {
  beforeEach(() => {
    useA11yStore.getState().reset();
    vi.stubEnv('VITE_E2E', '');
  });

  afterEach(() => {
    act(() => {
      useA11yStore.getState().reset();
    });
    vi.unstubAllEnvs();
  });

  it('is hidden from assistive technology', () => {
    const { container } = render(<Spinner />);

    expect(spinnerIn(container)).toHaveAttribute('aria-hidden', 'true');
  });

  it('draws a 1rem ring open on one side in the current colour', () => {
    const { container } = render(<Spinner />);

    expect(spinnerIn(container)).toHaveClass(
      'size-4',
      'rounded-full',
      'border-2',
      'border-current',
      'border-r-transparent'
    );
  });

  it('rotates when motion is not reduced', () => {
    const { container } = render(<Spinner />);

    expect(spinnerIn(container)).toHaveClass('animate-spin');
  });

  it('stops rotating when reduced motion is on', () => {
    act(() => {
      useA11yStore.getState().update({ stopAnimations: true });
    });
    const { container } = render(<Spinner />);

    expect(spinnerIn(container)).not.toHaveClass('animate-spin');
  });

  it('applies a caller class', () => {
    const { container } = render(<Spinner className="size-5" />);

    expect(spinnerIn(container)).toHaveClass('size-5');
  });
});
