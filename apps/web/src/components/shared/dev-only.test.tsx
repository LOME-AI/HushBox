import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DevOnly } from './dev-only';

describe('DevOnly', () => {
  const originalDev = import.meta.env.DEV;

  afterEach(() => {
    // Restore original DEV value
    vi.stubEnv('DEV', originalDev);
  });

  describe('in development mode', () => {
    beforeEach(() => {
      vi.stubEnv('DEV', true);
    });

    it('renders children in development', () => {
      render(
        <DevOnly>
          <span data-testid="child">Dev Content</span>
        </DevOnly>
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.getByText('Dev Content')).toBeInTheDocument();
    });

    it('shows development border by default', () => {
      render(
        <DevOnly>
          <span>Content</span>
        </DevOnly>
      );

      expect(screen.getByText('Development Only')).toBeInTheDocument();
    });

    it('hides border when showBorder is false', () => {
      render(
        <DevOnly showBorder={false}>
          <span data-testid="child">Content</span>
        </DevOnly>
      );

      expect(screen.getByTestId('child')).toBeInTheDocument();
      expect(screen.queryByText('Development Only')).not.toBeInTheDocument();
    });
  });

  describe('in production mode', () => {
    beforeEach(() => {
      vi.stubEnv('DEV', false);
    });

    it('does not render children in production', () => {
      render(
        <DevOnly>
          <span data-testid="child">Dev Content</span>
        </DevOnly>
      );

      expect(screen.queryByTestId('child')).not.toBeInTheDocument();
    });

    it('does not render border in production', () => {
      render(
        <DevOnly>
          <span>Content</span>
        </DevOnly>
      );

      expect(screen.queryByText('Development Only')).not.toBeInTheDocument();
    });

    it('returns null in production regardless of showBorder prop', () => {
      const { container } = render(
        <DevOnly showBorder={true}>
          <span data-testid="child">Content</span>
        </DevOnly>
      );

      expect(container.firstChild).toBeNull();
    });
  });
});
