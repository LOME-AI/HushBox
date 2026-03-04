import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CipherWall } from './cipher-wall';

vi.mock('@/hooks/use-cipher-wall', () => ({
  useCipherWall: () => ({ current: null }),
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
});
