import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DevOnly } from './dev-only';

vi.mock('@/lib/env', () => ({
  env: {
    isDev: true,
    isLocalDev: true,
    isProduction: false,
    isCI: false,
    requiresRealServices: false,
  },
}));

describe('DevOnly', () => {
  describe('in development mode', () => {
    beforeEach(async () => {
      const envModule = await import('@/lib/env');
      vi.mocked(envModule).env = {
        isDev: true,
        isLocalDev: true,
        isProduction: false,
        isCI: false,
        isE2E: false,
        requiresRealServices: false,
      };
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
    beforeEach(async () => {
      const envModule = await import('@/lib/env');
      vi.mocked(envModule).env = {
        isDev: false,
        isLocalDev: false,
        isProduction: true,
        isCI: false,
        isE2E: false,
        requiresRealServices: true,
      };
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
