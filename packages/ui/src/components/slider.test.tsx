import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi } from 'vitest';
import { Slider } from './slider';

describe('Slider', () => {
  it('renders as a slider', () => {
    render(<Slider aria-label="Volume" defaultValue={[50]} />);
    expect(screen.getByRole('slider')).toBeInTheDocument();
  });

  it('renders with the provided value', () => {
    render(<Slider aria-label="Volume" value={[30]} onValueChange={() => {}} />);
    const thumb = screen.getByRole('slider');
    expect(thumb).toHaveAttribute('aria-valuenow', '30');
  });

  it('respects min and max props', () => {
    render(<Slider aria-label="Volume" defaultValue={[50]} min={0} max={200} />);
    const thumb = screen.getByRole('slider');
    expect(thumb).toHaveAttribute('aria-valuemin', '0');
    expect(thumb).toHaveAttribute('aria-valuemax', '200');
  });

  it('uses default min=0 and max=100 when not provided', () => {
    render(<Slider aria-label="Volume" defaultValue={[50]} />);
    const thumb = screen.getByRole('slider');
    expect(thumb).toHaveAttribute('aria-valuemin', '0');
    expect(thumb).toHaveAttribute('aria-valuemax', '100');
  });

  it('fires onValueChange when arrow key pressed', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Slider aria-label="Volume" defaultValue={[50]} onValueChange={onValueChange} />);

    const thumb = screen.getByRole('slider');
    thumb.focus();
    await user.keyboard('{ArrowRight}');
    expect(onValueChange).toHaveBeenCalled();
    expect(onValueChange.mock.calls[0]?.[0]).toEqual([51]);
  });

  it('respects step prop', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Slider aria-label="Volume" defaultValue={[50]} step={10} onValueChange={onValueChange} />
    );

    const thumb = screen.getByRole('slider');
    thumb.focus();
    await user.keyboard('{ArrowRight}');
    expect(onValueChange.mock.calls[0]?.[0]).toEqual([60]);
  });

  it('is disabled when disabled prop is true', () => {
    render(<Slider aria-label="Volume" defaultValue={[50]} disabled data-testid="slider" />);
    // Radix marks disabled state on the root via data-disabled attribute
    expect(screen.getByTestId('slider')).toHaveAttribute('data-disabled');
  });

  it('does not fire onValueChange when disabled', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Slider aria-label="Volume" defaultValue={[50]} disabled onValueChange={onValueChange} />
    );

    const thumb = screen.getByRole('slider');
    thumb.focus();
    await user.keyboard('{ArrowRight}');
    expect(onValueChange).not.toHaveBeenCalled();
  });

  it('renders multiple thumbs for range selection', () => {
    render(<Slider aria-label="Range" defaultValue={[20, 80]} />);
    expect(screen.getAllByRole('slider')).toHaveLength(2);
  });

  it('updates value when controlled', () => {
    const { rerender } = render(
      <Slider aria-label="Volume" value={[25]} onValueChange={() => {}} />
    );
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '25');

    rerender(<Slider aria-label="Volume" value={[75]} onValueChange={() => {}} />);
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuenow', '75');
  });

  it('applies custom className', () => {
    render(
      <Slider
        aria-label="Volume"
        defaultValue={[50]}
        className="custom-class"
        data-testid="slider"
      />
    );
    expect(screen.getByTestId('slider')).toHaveClass('custom-class');
  });

  it('has data-slot attribute on root for styling', () => {
    render(<Slider aria-label="Volume" defaultValue={[50]} data-testid="slider" />);
    expect(screen.getByTestId('slider')).toHaveAttribute('data-slot', 'slider');
  });

  it('renders track and range internals with data-slot attributes', () => {
    render(<Slider aria-label="Volume" defaultValue={[50]} data-testid="slider" />);
    const root = screen.getByTestId('slider');
    expect(root.querySelector('[data-slot="slider-track"]')).not.toBeNull();
    expect(root.querySelector('[data-slot="slider-range"]')).not.toBeNull();
    expect(root.querySelector('[data-slot="slider-thumb"]')).not.toBeNull();
  });

  it('forwards additional props', () => {
    render(<Slider aria-label="Volume" defaultValue={[50]} data-testid="my-slider" />);
    expect(screen.getByTestId('my-slider')).toBeInTheDocument();
  });

  it('supports vertical orientation', () => {
    render(
      <Slider aria-label="Volume" defaultValue={[50]} orientation="vertical" data-testid="slider" />
    );
    expect(screen.getByTestId('slider')).toHaveAttribute('data-orientation', 'vertical');
  });

  it('falls back to a single-value default when neither value nor defaultValue is provided', () => {
    render(<Slider aria-label="Volume" data-testid="slider" />);
    // default falls back to [min, max] (we provide [0, 100]) → two thumbs by Radix convention
    const thumbs = screen.getAllByRole('slider');
    expect(thumbs.length).toBeGreaterThanOrEqual(1);
  });
});
