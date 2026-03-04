import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { mockLogoImport } from '@/test-utils/mocks.js';
import { SplashScreen } from './splash-screen';

mockLogoImport();

const mockUseCipherWall = vi.fn((_options?: Record<string, unknown>) => ({ current: null }));

vi.mock('@/hooks/use-cipher-wall', () => ({
  useCipherWall: (options?: Record<string, unknown>) => mockUseCipherWall(options),
}));

const VARIANT_CONFIG = {
  dark: { background: '#0a0a0a', foreground: '#fafafa' },
  light: { background: '#ffffff', foreground: '#0a0a0a' },
} as const;

describe('SplashScreen', () => {
  it.each(['dark', 'light'] as const)(
    'renders container with data-testid for %s variant',
    (variant) => {
      render(<SplashScreen variant={variant} />);
      expect(screen.getByTestId(`splash-${variant}`)).toBeInTheDocument();
    }
  );

  it.each(['dark', 'light'] as const)('fills the viewport for %s variant', (variant) => {
    render(<SplashScreen variant={variant} />);
    const container = screen.getByTestId(`splash-${variant}`);
    expect(container).toHaveStyle({ width: '100vw', height: '100vh' });
  });

  it.each(['dark', 'light'] as const)('uses correct background color for %s variant', (variant) => {
    render(<SplashScreen variant={variant} />);
    const container = screen.getByTestId(`splash-${variant}`);
    expect(container).toHaveStyle({ backgroundColor: VARIANT_CONFIG[variant].background });
  });

  it.each(['dark', 'light'] as const)('uses relative positioning for %s variant', (variant) => {
    render(<SplashScreen variant={variant} />);
    const container = screen.getByTestId(`splash-${variant}`);
    expect(container).toHaveStyle({ position: 'relative' });
  });

  it.each(['dark', 'light'] as const)('renders a CipherWall canvas for %s variant', (variant) => {
    render(<SplashScreen variant={variant} />);
    expect(screen.getByTestId('cipher-wall')).toBeInTheDocument();
  });

  it.each(['dark', 'light'] as const)(
    'wraps CipherWall with scale but no opacity for %s variant',
    (variant) => {
      render(<SplashScreen variant={variant} />);
      const canvas = screen.getByTestId('cipher-wall');
      const wrapper = canvas.parentElement!;
      expect(wrapper).toHaveStyle({ transform: 'scale(1.5)' });
      expect(wrapper.style.opacity).toBe('');
    }
  );

  it.each(['dark', 'light'] as const)('renders the logo image for %s variant', (variant) => {
    render(<SplashScreen variant={variant} />);
    const img = screen.getByAltText('HushBox Logo');
    expect(img).toBeInTheDocument();
  });

  it.each(['dark', 'light'] as const)(
    'renders the HushBox brand text for %s variant',
    (variant) => {
      render(<SplashScreen variant={variant} />);
      expect(screen.getByText('Hush')).toBeInTheDocument();
      expect(screen.getByText('Box')).toBeInTheDocument();
    }
  );

  it.each(['dark', 'light'] as const)(
    'renders Hush in correct foreground color for %s variant',
    (variant) => {
      render(<SplashScreen variant={variant} />);
      expect(screen.getByText('Hush')).toHaveStyle({ color: VARIANT_CONFIG[variant].foreground });
    }
  );

  it.each(['dark', 'light'] as const)('renders Box in brand-red for %s variant', (variant) => {
    render(<SplashScreen variant={variant} />);
    expect(screen.getByText('Box')).toHaveStyle({ color: '#ec4755' });
  });

  it('passes cipherOpacity 0.5 to useCipherWall', () => {
    mockUseCipherWall.mockClear();
    render(<SplashScreen variant="dark" />);
    expect(mockUseCipherWall).toHaveBeenCalledWith(expect.objectContaining({ cipherOpacity: 0.5 }));
  });

  it('passes frozen and frozenMessageCount to useCipherWall', () => {
    mockUseCipherWall.mockClear();
    render(<SplashScreen variant="light" />);
    expect(mockUseCipherWall).toHaveBeenCalledWith(
      expect.objectContaining({ frozen: true, frozenMessageCount: 4 })
    );
  });
});
