import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CipherWall } from './cipher-wall';

vi.mock('./use-cipher-wall', () => ({
  useCipherWall: () => ({ current: null }),
  RESIZE_DEBOUNCE_MS: 500,
}));

describe('CipherWall', () => {
  it('renders a canvas element', () => {
    render(<CipherWall />);
    expect(screen.getByTestId('cipher-wall')).toBeInstanceOf(HTMLCanvasElement);
  });

  it('has role="img" for accessibility', () => {
    render(<CipherWall />);
    expect(screen.getByRole('img')).toBeInTheDocument();
  });

  it('has an aria-label describing the animation', () => {
    render(<CipherWall />);
    const canvas = screen.getByRole('img');
    expect(canvas).toHaveAttribute('aria-label');
    expect(canvas.getAttribute('aria-label')).toMatch(/encrypt/i);
  });

  it('has CSS mask-image fading the left edge by default', () => {
    render(<CipherWall />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas.style.maskImage).toContain('transparent');
    expect(canvas.style.maskImage).toContain('black');
  });

  it('does not apply mask-image when frozen is true', () => {
    render(<CipherWall frozen />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas.style.maskImage).toBe('');
  });

  it('has full-size classes by default', () => {
    render(<CipherWall />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas).toHaveClass('h-full', 'w-full');
  });

  it('applies custom className when provided', () => {
    render(<CipherWall className="custom-class" />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas).toHaveClass('custom-class');
  });

  it('applies custom style when provided', () => {
    render(<CipherWall frozen style={{ opacity: 0.5 }} />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas.style.opacity).toBe('0.5');
  });

  it('accepts cipherOpacity prop without error', () => {
    render(<CipherWall frozen cipherOpacity={0.5} />);
    expect(screen.getByTestId('cipher-wall')).toBeInstanceOf(HTMLCanvasElement);
  });

  it('throws when fadeMask is radial but fadeMaskTarget is missing', () => {
    expect(() => render(<CipherWall fadeMask="radial" />)).toThrow(
      'CipherWall: fadeMask="radial" requires fadeMaskTarget selector'
    );
  });

  it('computes pixel-based radial mask from fadeMaskTarget element', () => {
    const target = document.createElement('div');
    target.dataset['target'] = '';
    document.body.append(target);

    vi.spyOn(target, 'getBoundingClientRect').mockReturnValue({
      width: 576,
      height: 400,
      top: 0,
      left: 0,
      right: 576,
      bottom: 400,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const mockDisconnect = vi.fn();
    class MockResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        callback([] as unknown as ResizeObserverEntry[], this as unknown as ResizeObserver);
      }
      observe = vi.fn();
      unobserve = vi.fn();
      disconnect = mockDisconnect;
    }
    vi.stubGlobal('ResizeObserver', MockResizeObserver);

    render(<CipherWall fadeMask="radial" fadeMaskTarget="[data-target]" />);
    const canvas = screen.getByTestId('cipher-wall');

    // rx = 576/2 + 12 = 300, ry = 400/2 + 24 = 224
    expect(canvas.style.maskImage).toContain('300px');
    expect(canvas.style.maskImage).toContain('224px');
    expect(canvas.style.maskImage).toContain('radial-gradient');

    target.remove();
    vi.unstubAllGlobals();
  });

  it('throws when fadeMaskTarget element is not found in DOM', () => {
    vi.stubGlobal(
      'ResizeObserver',
      vi.fn(() => ({ observe: vi.fn(), unobserve: vi.fn(), disconnect: vi.fn() }))
    );

    expect(() =>
      render(<CipherWall fadeMask="radial" fadeMaskTarget="[data-nonexistent]" />)
    ).toThrow('CipherWall: fadeMaskTarget "[data-nonexistent]" not found in DOM');

    vi.unstubAllGlobals();
  });

  it('applies no mask when fadeMask is none', () => {
    render(<CipherWall fadeMask="none" />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas.style.maskImage).toBe('');
  });

  it('applies no mask when frozen regardless of fadeMask', () => {
    render(<CipherWall frozen fadeMask="radial" fadeMaskTarget="[data-target]" />);
    const canvas = screen.getByTestId('cipher-wall');
    expect(canvas.style.maskImage).toBe('');
  });
});
