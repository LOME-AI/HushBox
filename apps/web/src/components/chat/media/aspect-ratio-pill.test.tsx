import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { AspectRatioPill } from '@/components/chat/media/aspect-ratio-pill';

describe('AspectRatioPill', () => {
  it('uses the ratio as the accessible name', () => {
    render(<AspectRatioPill ratio="1:1" isActive={false} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: '1:1' })).toBeInTheDocument();
  });

  it('renders a shape with aspect-ratio CSS matching the input', () => {
    render(<AspectRatioPill ratio="16:9" isActive={false} onClick={() => {}} />);
    const shape = screen.getByTestId('aspect-ratio-shape');
    expect(shape.style.aspectRatio).toBe('16 / 9');
  });

  it('sizes landscape shapes by width (height auto via aspect-ratio)', () => {
    render(<AspectRatioPill ratio="16:9" isActive={false} onClick={() => {}} />);
    const shape = screen.getByTestId('aspect-ratio-shape');
    expect(shape.style.width).toBe('22px');
    expect(shape.style.height).toBe('');
  });

  it('sizes portrait shapes by height (width auto via aspect-ratio)', () => {
    render(<AspectRatioPill ratio="9:16" isActive={false} onClick={() => {}} />);
    const shape = screen.getByTestId('aspect-ratio-shape');
    expect(shape.style.height).toBe('22px');
    expect(shape.style.width).toBe('');
  });

  it('sizes square shapes equally on both sides', () => {
    render(<AspectRatioPill ratio="1:1" isActive={false} onClick={() => {}} />);
    const shape = screen.getByTestId('aspect-ratio-shape');
    expect(shape.style.aspectRatio).toBe('1 / 1');
    expect(shape.style.width).toBe('22px');
  });

  it('uses a larger shape (40px) when size=lg for touch surfaces', () => {
    render(<AspectRatioPill ratio="1:1" isActive={false} onClick={() => {}} size="lg" />);
    const shape = screen.getByTestId('aspect-ratio-shape');
    expect(shape.style.width).toBe('40px');
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
    const shape = screen.getByTestId('aspect-ratio-shape');
    expect(shape).toHaveAttribute('aria-hidden', 'true');
  });

  it('hides the textual ratio from screen readers when the button label already conveys it', () => {
    render(<AspectRatioPill ratio="4:3" isActive={false} onClick={() => {}} />);
    expect(screen.getByRole('button', { name: '4:3' })).toBeInTheDocument();
  });
});
