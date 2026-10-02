import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Lock } from 'lucide-react';
import { Icon, type IconGlyphProps, type IconSize } from './icon';

/** A glyph that, unlike lucide's, sets no ARIA of its own, as the product's own marks do. */
function PlainGlyph({
  className,
  'aria-hidden': ariaHidden,
}: Readonly<IconGlyphProps>): React.JSX.Element {
  return <svg className={className} aria-hidden={ariaHidden} />;
}

function onlySvg(container: HTMLElement): SVGSVGElement {
  const svg = container.querySelector('svg');
  if (svg === null) throw new Error('no svg rendered');
  return svg;
}

describe('Icon', () => {
  it.each<[IconSize, string]>([
    ['xs', 'size-3'],
    ['sm', 'size-3.5'],
    ['md', 'size-4'],
    ['md-lg', 'size-4.5'],
    ['lg', 'size-5'],
    ['xl', 'size-6'],
    ['display', 'size-16'],
  ])('draws the %s size with %s', (size, sizeClass) => {
    const { container } = render(<Icon icon={Lock} size={size} />);

    expect(onlySvg(container)).toHaveClass(sizeClass);
  });

  it('draws the md size when no size is given', () => {
    const { container } = render(<Icon icon={Lock} />);

    expect(onlySvg(container)).toHaveClass('size-4');
  });

  it('is hidden from assistive technology when it has no label', () => {
    const { container } = render(<Icon icon={PlainGlyph} />);

    expect(onlySvg(container)).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('img')).toBeNull();
  });

  it('merges a caller class onto the decorative icon', () => {
    const { container } = render(<Icon icon={Lock} size="lg" className="text-primary" />);

    expect(onlySvg(container)).toHaveClass('size-5', 'text-primary');
  });

  it('is an image named by its label when given one', () => {
    render(<Icon icon={Lock} label="Encrypted" />);

    expect(screen.getByRole('img', { name: 'Encrypted' })).toBeInTheDocument();
  });

  it('keeps the glyph inside a labelled icon hidden, so the name is announced once', () => {
    const { container } = render(<Icon icon={PlainGlyph} label="Encrypted" />);

    expect(onlySvg(container)).toHaveAttribute('aria-hidden', 'true');
  });

  it('sizes a labelled icon by its size token', () => {
    render(<Icon icon={Lock} size="xl" label="Encrypted" />);

    expect(screen.getByRole('img', { name: 'Encrypted' })).toHaveClass('size-6');
  });

  it('merges a caller class onto a labelled icon', () => {
    render(<Icon icon={Lock} label="Encrypted" className="text-primary" />);

    expect(screen.getByRole('img', { name: 'Encrypted' })).toHaveClass('text-primary');
  });

  it('lays a labelled icon out as a block, the box the base layer gives a bare svg', () => {
    render(<Icon icon={Lock} label="Encrypted" />);

    expect(screen.getByRole('img', { name: 'Encrypted' })).toHaveClass('block');
  });
});
