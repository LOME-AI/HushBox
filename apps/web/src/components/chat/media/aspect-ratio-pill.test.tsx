import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { AspectRatioPill } from '@/components/chat/media/aspect-ratio-pill';

/** The rendered shape's width and height in rem, read from its own style. */
function shapeSize(): { width: number; height: number } {
  const shape = screen.getByTestId(TEST_IDS.aspectRatioShape);
  return {
    width: Number.parseFloat(shape.style.width),
    height: Number.parseFloat(shape.style.height),
  };
}

describe('AspectRatioPill', () => {
  it('uses the ratio as the accessible name', () => {
    render(<AspectRatioPill ratio="1:1" isActive={false} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
  });

  it('draws the ratio with the outline shape the ratio grid draws', () => {
    render(<AspectRatioPill ratio="16:9" isActive={false} onClick={() => {}} />);
    expect(screen.getByTestId(TEST_IDS.aspectRatioShape).tagName.toLowerCase()).toBe('svg');
  });

  it('draws a landscape ratio wider than it is tall', () => {
    render(<AspectRatioPill ratio="16:9" isActive={false} onClick={() => {}} />);
    const { width, height } = shapeSize();
    expect(width / height).toBeCloseTo(16 / 9, 2);
  });

  it('draws a portrait ratio taller than it is wide', () => {
    render(<AspectRatioPill ratio="9:16" isActive={false} onClick={() => {}} />);
    const { width, height } = shapeSize();
    expect(height / width).toBeCloseTo(16 / 9, 2);
  });

  it('draws the automatic ratio as a square', () => {
    render(<AspectRatioPill ratio="auto" isActive={false} onClick={() => {}} />);
    const { width, height } = shapeSize();
    expect(width).toBe(height);
  });

  it('sets aria-pressed=true when active', () => {
    render(<AspectRatioPill ratio="1:1" isActive={true} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: '1:1' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('sets aria-pressed=false when inactive', () => {
    render(<AspectRatioPill ratio="1:1" isActive={false} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: '1:1' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('calls onClick when clicked', () => {
    const handleClick = vi.fn();
    render(<AspectRatioPill ratio="16:9" isActive={false} onClick={handleClick} />);
    fireEvent.click(screen.getByRole('button', { name: '16:9' }));
    expect(handleClick).toHaveBeenCalledTimes(1);
  });

  it('renders the shape with aria-hidden so screen readers skip it', () => {
    render(<AspectRatioPill ratio="4:3" isActive={false} onClick={() => {}} />);
    const shape = screen.getByTestId(TEST_IDS.aspectRatioShape);
    expect(shape).toHaveAttribute('aria-hidden', 'true');
  });

  it('stays focusable and says why when the ratio is refused', () => {
    render(
      <AspectRatioPill
        ratio="4:3"
        isActive={false}
        onClick={() => {}}
        unavailable={{ reasonId: 'why' }}
      />
    );
    const pill = screen.getByRole('button', { name: '4:3' });
    expect(pill).toHaveAttribute('aria-disabled', 'true');
    expect(pill).toHaveAttribute('aria-describedby', 'why');
  });
});
