import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Logo, resolveImageSrc as resolveImageSource } from './logo';

describe('Logo', () => {
  it('renders the HushBox logo image', () => {
    render(<Logo />);
    const img = screen.getByAltText('HushBox Logo');
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src');
  });

  it('renders HushBox text with branded Box', () => {
    render(<Logo />);
    expect(screen.getByText(/Hush/)).toBeInTheDocument();
    expect(screen.getByText('Box')).toBeInTheDocument();
  });

  it('applies custom className', () => {
    render(<Logo className="custom-class" />);
    const container = screen.getByTestId('logo');
    expect(container).toHaveClass('custom-class');
  });

  it('preserves default flex layout classes', () => {
    render(<Logo />);
    const container = screen.getByTestId('logo');
    expect(container).toHaveClass('flex', 'items-center', 'gap-2');
  });

  it('has correct image dimensions', () => {
    render(<Logo />);
    const img = screen.getByAltText('HushBox Logo');
    expect(img).toHaveClass('h-6', 'w-6');
  });

  it('has correct text styling', () => {
    render(<Logo />);
    const text = screen.getByText(/Hush/);
    expect(text).toHaveClass('text-lg', 'font-bold');
  });

  it('has tight line-height on text for vertical alignment', () => {
    render(<Logo />);
    const text = screen.getByText(/Hush/);
    expect(text).toHaveClass('leading-none');
  });

  it('has branded red color on Box text', () => {
    render(<Logo />);
    const box = screen.getByText('Box');
    expect(box).toHaveClass('text-brand-red');
  });
});

describe('resolveImageSrc', () => {
  it('returns string imports directly (Vite)', () => {
    expect(resolveImageSource('/assets/logo.png')).toBe('/assets/logo.png');
  });

  it('extracts .src from object imports (Astro SSR)', () => {
    const astroImport = {
      src: '/_astro/HushBoxLogo.abc123.png',
      width: 64,
      height: 64,
      format: 'png',
    };
    expect(resolveImageSource(astroImport)).toBe('/_astro/HushBoxLogo.abc123.png');
  });

  it('returns empty string and warns for unexpected types', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveImageSource(42)).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unexpected logo import type'));
    warnSpy.mockRestore();
  });

  it('returns empty string and warns for objects without src', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(resolveImageSource({ width: 64 })).toBe('');
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unexpected logo import type'));
    warnSpy.mockRestore();
  });
});
