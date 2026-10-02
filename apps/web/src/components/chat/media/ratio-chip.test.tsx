import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { createModelStoreStub, type ModelStoreStub } from '@/test-utils/model-store-mock';

const modelStoreStubRef: { current: ModelStoreStub } = { current: createModelStoreStub() };

vi.mock('@/stores/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/stores/model')>();
  const store = vi.fn((selector?: (s: ModelStoreStub) => unknown) =>
    selector ? selector(modelStoreStubRef.current) : modelStoreStubRef.current
  );
  return { ...actual, useModelStore: store };
});

import { RatioChip, RatioShape, ratioLabel } from '@/components/chat/media/ratio-chip';

function chooseImageRatio(aspectRatio: string): void {
  modelStoreStubRef.current = createModelStoreStub({ imageConfig: { aspectRatio } });
}

/** The rendered shape's width and height in rem, read from its own style. */
function shapeSize(element: Element | null): { width: number; height: number } {
  if (!(element instanceof SVGElement)) throw new Error('no shape rendered');
  const style = element.style;
  return { width: Number.parseFloat(style.width), height: Number.parseFloat(style.height) };
}

describe('ratioLabel', () => {
  it('reads a ratio as written', () => {
    expect(ratioLabel('19.5:9')).toBe('19.5:9');
  });

  it('names the automatic ratio Auto', () => {
    expect(ratioLabel('auto')).toBe('Auto');
  });
});

describe('RatioShape', () => {
  it('draws a landscape ratio wider than it is tall', () => {
    const { container } = render(<RatioShape ratio="16:9" size="tile" />);
    const { width, height } = shapeSize(container.firstElementChild);
    expect(width / height).toBeCloseTo(16 / 9, 2);
  });

  it('draws a portrait ratio taller than it is wide', () => {
    const { container } = render(<RatioShape ratio="9:16" size="tile" />);
    const { width, height } = shapeSize(container.firstElementChild);
    expect(height / width).toBeCloseTo(16 / 9, 2);
  });

  it('draws a fractional ratio in proportion', () => {
    const { container } = render(<RatioShape ratio="9:19.5" size="tile" />);
    const { width, height } = shapeSize(container.firstElementChild);
    expect(height / width).toBeCloseTo(19.5 / 9, 2);
  });

  it('keeps a tile shape inside its box, however long the ratio', () => {
    const { container } = render(<RatioShape ratio="21:9" size="tile" />);
    const { width, height } = shapeSize(container.firstElementChild);
    expect(width).toBeLessThanOrEqual(1.75);
    expect(height).toBeLessThanOrEqual(1.5);
  });

  it('draws the chip shape smaller than the tile shape', () => {
    const tile = render(<RatioShape ratio="1:1" size="tile" />);
    const tileWidth = shapeSize(tile.container.firstElementChild).width;
    tile.unmount();
    const { container } = render(<RatioShape ratio="1:1" size="chip" />);
    expect(shapeSize(container.firstElementChild).width).toBeLessThan(tileWidth);
  });

  it('draws the automatic ratio as a dashed square', () => {
    const { container } = render(<RatioShape ratio="auto" size="tile" />);
    const { width, height } = shapeSize(container.firstElementChild);
    expect(width).toBe(height);
    expect(container.querySelector('rect')).toHaveAttribute('stroke-dasharray');
  });

  it('draws a stated ratio with a solid outline', () => {
    const { container } = render(<RatioShape ratio="4:3" size="tile" />);
    expect(container.querySelector('rect')).not.toHaveAttribute('stroke-dasharray');
  });

  it('is hidden from assistive technology', () => {
    render(<RatioShape ratio="4:3" size="tile" />);
    expect(screen.getByTestId(TEST_IDS.aspectRatioShape)).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('RatioChip', () => {
  it('names itself by the chosen ratio', () => {
    chooseImageRatio('16:9');
    render(<RatioChip />);
    expect(screen.getByRole('button', { name: 'Aspect ratio: 16:9' })).toBeInTheDocument();
  });

  it('shows the chosen ratio as its label', () => {
    chooseImageRatio('4:5');
    render(<RatioChip />);
    expect(screen.getByRole('button')).toHaveTextContent('4:5');
  });

  it('calls the automatic ratio Auto', () => {
    chooseImageRatio('auto');
    render(<RatioChip />);
    expect(screen.getByRole('button', { name: 'Aspect ratio: Auto' })).toHaveTextContent('Auto');
  });

  it('carries the chosen ratio as its shape', () => {
    chooseImageRatio('9:16');
    render(<RatioChip />);
    const { width, height } = shapeSize(screen.getByTestId(TEST_IDS.aspectRatioShape));
    expect(height).toBeGreaterThan(width);
  });

  it('draws its shape outside a span, so a chip squared to its icon keeps the shape', () => {
    chooseImageRatio('1:1');
    render(<RatioChip />);
    const shape = screen.getByTestId(TEST_IDS.aspectRatioShape);
    expect(shape.tagName.toLowerCase()).toBe('svg');
    expect(shape.parentElement).toBe(screen.getByRole('button'));
  });

  it('says whether its popover is open', () => {
    chooseImageRatio('1:1');
    render(<RatioChip expanded />);
    expect(screen.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  });
});
