import { describe, it, expect, expectTypeOf } from 'vitest';
import { render } from '@testing-library/react';
import { Swatch } from './swatch';
import type { ModelSwatch } from '@hushbox/shared/design-tokens';

const SWATCHES: readonly ModelSwatch[] = [1, 2, 3, 4, 5, 6, 7, 8];

function swatchElement(container: HTMLElement): Element {
  const element = container.firstElementChild;
  if (element === null) throw new Error('Swatch rendered nothing');
  return element;
}

describe('Swatch', () => {
  it.each(SWATCHES)('fills swatch %i with its model colour', (swatch) => {
    const { container } = render(<Swatch swatch={swatch} />);

    expect(swatchElement(container)).toHaveClass(`bg-model-${String(swatch)}`);
  });

  it('draws an 8px square with a 2px corner by default', () => {
    const { container } = render(<Swatch swatch={1} />);

    expect(swatchElement(container)).toHaveClass('size-2', 'rounded-xs');
  });

  it('draws a 10px square at the large size', () => {
    const { container } = render(<Swatch swatch={1} size="lg" />);

    expect(swatchElement(container)).toHaveClass('size-2.5');
  });

  it('keeps its size in a row that shrinks', () => {
    const { container } = render(<Swatch swatch={1} />);

    expect(swatchElement(container)).toHaveClass('shrink-0');
  });

  it('is hidden from assistive technology', () => {
    const { container } = render(<Swatch swatch={3} />);

    expect(swatchElement(container)).toHaveAttribute('aria-hidden', 'true');
  });

  it('accepts only a model swatch number', () => {
    expectTypeOf(Swatch).parameter(0).toHaveProperty('swatch').toEqualTypeOf<ModelSwatch>();
  });
});
