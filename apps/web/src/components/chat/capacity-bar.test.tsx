import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { CapacityBar } from './capacity-bar';

describe('CapacityBar', () => {
  describe('rendering', () => {
    it('renders with correct testid', () => {
      render(<CapacityBar currentUsage={1000} maxCapacity={10_000} />);
      expect(screen.getByTestId('capacity-bar')).toBeInTheDocument();
    });

    it('displays capacity percentage label', () => {
      render(<CapacityBar currentUsage={5000} maxCapacity={10_000} />);
      expect(screen.getByText('Model 50% filled')).toBeInTheDocument();
    });

    it('rounds percentage to whole number', () => {
      render(<CapacityBar currentUsage={3333} maxCapacity={10_000} />);
      // 3333/10000 = 33.33% -> rounds to 33%
      expect(screen.getByText('Model 33% filled')).toBeInTheDocument();
    });

    it('accepts custom className', () => {
      render(<CapacityBar currentUsage={1000} maxCapacity={10_000} className="custom-class" />);
      expect(screen.getByTestId('capacity-bar')).toHaveClass('custom-class');
    });
  });

  describe('color zones', () => {
    it('shows green fill when below 33%', () => {
      render(<CapacityBar currentUsage={3200} maxCapacity={10_000} />);
      // 32% should be green
      const fill = screen.getByTestId('capacity-bar-fill');
      expect(fill).toHaveClass('bg-green-500');
    });

    it('shows yellow fill when between 33-66%', () => {
      render(<CapacityBar currentUsage={5000} maxCapacity={10_000} />);
      // 50% should be yellow
      const fill = screen.getByTestId('capacity-bar-fill');
      expect(fill).toHaveClass('bg-yellow-500');
    });

    it('shows yellow fill at exactly 33%', () => {
      render(<CapacityBar currentUsage={3300} maxCapacity={10_000} />);
      const fill = screen.getByTestId('capacity-bar-fill');
      expect(fill).toHaveClass('bg-yellow-500');
    });

    it('shows red fill when at or above 67%', () => {
      render(<CapacityBar currentUsage={6700} maxCapacity={10_000} />);
      // 67% should be red
      const fill = screen.getByTestId('capacity-bar-fill');
      expect(fill).toHaveClass('bg-red-500');
    });

    it('shows red fill when over 100%', () => {
      render(<CapacityBar currentUsage={15_000} maxCapacity={10_000} />);
      // 150% should be red
      const fill = screen.getByTestId('capacity-bar-fill');
      expect(fill).toHaveClass('bg-red-500');
    });
  });

  describe('fill width', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sets fill width based on percentage after animation', async () => {
      render(<CapacityBar currentUsage={5000} maxCapacity={10_000} />);
      const fill = screen.getByTestId('capacity-bar-fill');

      await act(async () => {
        await vi.advanceTimersToNextTimerAsync();
      });

      expect(fill).toHaveStyle({ width: '50%' });
    });

    it('caps fill width at 100% when over capacity', async () => {
      render(<CapacityBar currentUsage={15_000} maxCapacity={10_000} />);
      const fill = screen.getByTestId('capacity-bar-fill');

      await act(async () => {
        await vi.advanceTimersToNextTimerAsync();
      });

      // Should not exceed 100%
      expect(fill).toHaveStyle({ width: '100%' });
    });

    it('shows 0% width when currentUsage is 0', async () => {
      render(<CapacityBar currentUsage={0} maxCapacity={10_000} />);
      const fill = screen.getByTestId('capacity-bar-fill');

      await act(async () => {
        await vi.advanceTimersToNextTimerAsync();
      });

      expect(fill).toHaveStyle({ width: '0%' });
    });
  });

  describe('edge cases', () => {
    it('handles very small percentages', () => {
      render(<CapacityBar currentUsage={1} maxCapacity={10_000} />);
      expect(screen.getByText('Model 0% filled')).toBeInTheDocument();
    });

    it('handles large capacity values', () => {
      render(<CapacityBar currentUsage={128_000} maxCapacity={1_000_000} />);
      // 12.8% rounds to 13%
      expect(screen.getByText('Model 13% filled')).toBeInTheDocument();
    });

    it('displays 100% at full capacity', () => {
      render(<CapacityBar currentUsage={10_000} maxCapacity={10_000} />);
      expect(screen.getByText('Model 100% filled')).toBeInTheDocument();
    });

    it('displays over 100% when exceeded', () => {
      render(<CapacityBar currentUsage={15_000} maxCapacity={10_000} />);
      expect(screen.getByText('Model 150% filled')).toBeInTheDocument();
    });
  });

  describe('animation', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts at target width on mount (no animation)', () => {
      render(<CapacityBar currentUsage={5000} maxCapacity={10_000} />);
      const fill = screen.getByTestId('capacity-bar-fill');

      // Should immediately show target value on mount - no animation from 0
      expect(fill).toHaveStyle({ width: '50%' });
    });

    it('animates when capacity changes', async () => {
      const { rerender } = render(<CapacityBar currentUsage={3000} maxCapacity={10_000} />);
      const fill = screen.getByTestId('capacity-bar-fill');

      // Immediately at target value (no mount animation)
      expect(fill).toHaveStyle({ width: '30%' });

      // Update capacity
      rerender(<CapacityBar currentUsage={7000} maxCapacity={10_000} />);

      // After animation frame, should animate to new target
      await act(async () => {
        await vi.advanceTimersToNextTimerAsync();
      });
      expect(fill).toHaveStyle({ width: '70%' });
    });
  });

  describe('styling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('has correct bar structure', async () => {
      render(<CapacityBar currentUsage={5000} maxCapacity={10_000} />);

      // Advance timers for animation
      await act(async () => {
        await vi.advanceTimersToNextTimerAsync();
      });

      // Background track
      const track = screen.getByTestId('capacity-bar-track');
      expect(track).toHaveClass('bg-muted');
      expect(track).toHaveClass('h-2'); // 8px height
      expect(track).toHaveClass('rounded');

      // Fill
      const fill = screen.getByTestId('capacity-bar-fill');
      expect(fill).toHaveClass('h-full');
      expect(fill).toHaveClass('rounded');
      expect(fill).toHaveClass('transition-all');
      expect(fill).toHaveClass('duration-300');
    });

    it('label has correct styling', () => {
      render(<CapacityBar currentUsage={5000} maxCapacity={10_000} />);

      const label = screen.getByText('Model 50% filled');
      expect(label).toHaveClass('text-sm');
      expect(label).toHaveClass('text-muted-foreground');
    });
  });
});
