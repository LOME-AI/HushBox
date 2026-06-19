import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { DurationSnapSlider } from '@/components/chat/media/duration-snap-slider';

describe('DurationSnapSlider', () => {
  it('renders a slider element with min, max, and current value', () => {
    render(
      <DurationSnapSlider value={4} min={1} max={8} onChange={() => {}} ariaLabel="Duration" />
    );
    const slider = screen.getByRole('slider');
    expect(slider).toHaveAttribute('min', '1');
    expect(slider).toHaveAttribute('max', '8');
    expect(slider).toHaveValue('4');
  });

  it('uses ariaLabel as the accessible name', () => {
    render(
      <DurationSnapSlider
        value={4}
        min={1}
        max={8}
        onChange={() => {}}
        ariaLabel="Video duration in seconds"
      />
    );
    expect(screen.getByRole('slider', { name: /video duration in seconds/i })).toBeInTheDocument();
  });

  it('renders a humanized aria-valuetext for screen readers', () => {
    render(
      <DurationSnapSlider value={4} min={1} max={8} onChange={() => {}} ariaLabel="Duration" />
    );
    expect(screen.getByRole('slider')).toHaveAttribute('aria-valuetext', '4 seconds');
  });

  it('calls onChange with the parsed number when the slider value changes', () => {
    const handleChange = vi.fn();
    render(
      <DurationSnapSlider value={4} min={1} max={8} onChange={handleChange} ariaLabel="Duration" />
    );
    fireEvent.change(screen.getByRole('slider'), { target: { value: '6' } });
    expect(handleChange).toHaveBeenCalledWith(6);
  });

  it('renders one clickable tick button per snap point', () => {
    render(
      <DurationSnapSlider
        value={4}
        min={1}
        max={8}
        snapPoints={[2, 4, 6, 8]}
        onChange={() => {}}
        ariaLabel="Duration"
      />
    );
    expect(screen.getByRole('button', { name: /set duration to 2 seconds/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set duration to 4 seconds/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set duration to 6 seconds/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /set duration to 8 seconds/i })).toBeInTheDocument();
  });

  it('renders no tick buttons when snapPoints is undefined', () => {
    render(
      <DurationSnapSlider value={4} min={1} max={8} onChange={() => {}} ariaLabel="Duration" />
    );
    expect(screen.queryByRole('button', { name: /set duration/i })).not.toBeInTheDocument();
  });

  it('fires onChange with the tick value when a tick is clicked', () => {
    const handleChange = vi.fn();
    render(
      <DurationSnapSlider
        value={4}
        min={1}
        max={8}
        snapPoints={[2, 4, 6, 8]}
        onChange={handleChange}
        ariaLabel="Duration"
      />
    );
    fireEvent.click(screen.getByRole('button', { name: /set duration to 6 seconds/i }));
    expect(handleChange).toHaveBeenCalledWith(6);
  });

  it('marks the tick matching the current value with aria-pressed=true', () => {
    render(
      <DurationSnapSlider
        value={4}
        min={1}
        max={8}
        snapPoints={[2, 4, 6, 8]}
        onChange={() => {}}
        ariaLabel="Duration"
      />
    );
    expect(screen.getByRole('button', { name: /set duration to 4 seconds/i })).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(screen.getByRole('button', { name: /set duration to 6 seconds/i })).toHaveAttribute(
      'aria-pressed',
      'false'
    );
  });

  it('positions each tick at the correct percent across the range', () => {
    render(
      <DurationSnapSlider
        value={5}
        min={0}
        max={10}
        snapPoints={[0, 5, 10]}
        onChange={() => {}}
        ariaLabel="Duration"
      />
    );
    expect(screen.getByRole('button', { name: /set duration to 0 seconds/i }).style.left).toBe(
      '0%'
    );
    expect(screen.getByRole('button', { name: /set duration to 5 seconds/i }).style.left).toBe(
      '50%'
    );
    expect(screen.getByRole('button', { name: /set duration to 10 seconds/i }).style.left).toBe(
      '100%'
    );
  });

  it('handles a zero-width range (min === max) without dividing by zero', () => {
    render(
      <DurationSnapSlider
        value={5}
        min={5}
        max={5}
        snapPoints={[5]}
        onChange={() => {}}
        ariaLabel="Duration"
      />
    );
    expect(screen.getByRole('button', { name: /set duration to 5 seconds/i }).style.left).toBe(
      '0%'
    );
  });
});
