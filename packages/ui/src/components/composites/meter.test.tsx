import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { Meter } from './meter';
import type { MeterLevel } from './meter';

const CRITICAL: MeterLevel = { state: 'critical', className: 'bg-error' };

function fill(container: HTMLElement): HTMLElement {
  const node = container.querySelector('[data-slot="meter-fill"]');
  if (!(node instanceof HTMLElement)) throw new Error('meter fill not rendered');
  return node;
}

function track(container: HTMLElement): HTMLElement {
  const node = container.querySelector('[data-slot="meter-track"]');
  if (!(node instanceof HTMLElement)) throw new Error('meter track not rendered');
  return node;
}

describe('Meter', () => {
  describe('label', () => {
    it('labels the fill with the rounded percentage by default', () => {
      render(<Meter value={3333} max={10_000} />);

      expect(screen.getByText('33%')).toBeInTheDocument();
    });

    it('formats the label with the caller-supplied formatter', () => {
      render(<Meter value={5000} max={10_000} formatLabel={(p) => `Model ${String(p)}% filled`} />);

      expect(screen.getByText('Model 50% filled')).toBeInTheDocument();
    });

    it('reports past 100% when the value exceeds the maximum', () => {
      render(<Meter value={15_000} max={10_000} />);

      expect(screen.getByText('150%')).toBeInTheDocument();
    });
  });

  describe('fill', () => {
    it('scales the fill to the share of the maximum', () => {
      const { container } = render(<Meter value={5000} max={10_000} />);

      expect(fill(container)).toHaveStyle({ transform: 'scaleX(0.5)' });
    });

    it('caps the fill scale at 1 when the value exceeds the maximum', () => {
      const { container } = render(<Meter value={15_000} max={10_000} />);

      expect(fill(container)).toHaveStyle({ transform: 'scaleX(1)' });
    });

    it('collapses the fill to nothing at zero', () => {
      const { container } = render(<Meter value={0} max={10_000} />);

      expect(fill(container)).toHaveStyle({ transform: 'scaleX(0)' });
    });

    it('grows from the left edge', () => {
      const { container } = render(<Meter value={5000} max={10_000} />);

      expect(fill(container)).toHaveStyle({ transformOrigin: 'left' });
    });

    it('rescales when the value changes', () => {
      const { container, rerender } = render(<Meter value={3000} max={10_000} />);
      expect(fill(container)).toHaveStyle({ transform: 'scaleX(0.3)' });

      rerender(<Meter value={7000} max={10_000} />);
      expect(fill(container)).toHaveStyle({ transform: 'scaleX(0.7)' });
    });

    it('animates the fill by transform so the browser composites it', () => {
      const { container } = render(<Meter value={5000} max={10_000} />);

      expect(fill(container)).toHaveClass('transition-transform', 'duration-300');
    });
  });

  describe('level', () => {
    it('takes the base fill when no level is given', () => {
      const { container } = render(<Meter value={5000} max={10_000} />);

      expect(fill(container)).toHaveClass('bg-primary');
    });

    it('takes the fill of the level it is handed', () => {
      const { container } = render(<Meter value={3200} max={10_000} level={CRITICAL} />);

      expect(fill(container)).toHaveClass('bg-error');
    });

    it('exposes the level as a data attribute', () => {
      render(<Meter value={7000} max={10_000} level={CRITICAL} data-testid="meter" />);

      expect(screen.getByTestId('meter')).toHaveAttribute('data-state', 'critical');
    });

    it('carries no level attribute when no level is given', () => {
      render(<Meter value={5000} max={10_000} data-testid="meter" />);

      expect(screen.getByTestId('meter')).not.toHaveAttribute('data-state');
    });

    it('names the level in text so it is not conveyed by color alone', () => {
      render(<Meter value={7000} max={10_000} level={CRITICAL} />);

      const state = screen.getByText(', critical');
      expect(state).toHaveClass('sr-only');
    });
  });

  describe('structure', () => {
    it('hides the decorative bar from assistive technology', () => {
      const { container } = render(<Meter value={5000} max={10_000} />);

      expect(track(container)).toHaveAttribute('aria-hidden', 'true');
    });

    it('has a data-slot attribute', () => {
      render(<Meter value={5000} max={10_000} data-testid="meter" />);

      expect(screen.getByTestId('meter')).toHaveAttribute('data-slot', 'meter');
    });

    it('applies a custom className to the root', () => {
      render(<Meter value={5000} max={10_000} className="min-w-40 flex-1" data-testid="meter" />);

      expect(screen.getByTestId('meter')).toHaveClass('min-w-40', 'flex-1', 'items-center');
    });
  });
});
