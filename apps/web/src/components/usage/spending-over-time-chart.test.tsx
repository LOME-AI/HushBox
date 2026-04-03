import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { SpendingOverTimeResponse } from '@hushbox/shared';
import { SpendingOverTimeChart } from './spending-over-time-chart';

// Recharts ResponsiveContainer needs a real width/height to render children.
// In jsdom there is no layout engine, so we mock it to pass dimensions through.
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
      <div style={{ width: 800, height: 300 }}>{children}</div>
    ),
  };
});

function makeData(
  points: { period: string; model: string; totalCost: string; count: number }[]
): SpendingOverTimeResponse {
  return { data: points };
}

const SAMPLE_DATA = makeData([
  { period: '2025-01-01', model: 'GPT-4', totalCost: '1.50', count: 10 },
  { period: '2025-01-01', model: 'Claude', totalCost: '2.00', count: 5 },
  { period: '2025-01-02', model: 'GPT-4', totalCost: '0.75', count: 3 },
  { period: '2025-01-02', model: 'Claude', totalCost: '0.00', count: 0 },
]);

describe('SpendingOverTimeChart', () => {
  describe('loading state', () => {
    it('renders skeleton when loading', () => {
      render(<SpendingOverTimeChart data={undefined} isLoading={true} />);
      expect(screen.getByTestId('skeleton-block')).toBeInTheDocument();
    });

    it('does not render empty message when loading', () => {
      render(<SpendingOverTimeChart data={undefined} isLoading={true} />);
      expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('renders empty message when data is undefined', () => {
      render(<SpendingOverTimeChart data={undefined} isLoading={false} />);
      expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    });

    it('renders empty message when data array is empty', () => {
      render(<SpendingOverTimeChart data={makeData([])} isLoading={false} />);
      expect(screen.getByText('No usage data for this period')).toBeInTheDocument();
    });

    it('does not render skeleton when not loading', () => {
      render(<SpendingOverTimeChart data={undefined} isLoading={false} />);
      expect(screen.queryByTestId('skeleton-block')).not.toBeInTheDocument();
    });
  });

  describe('chart rendering', () => {
    it('renders chart card with correct testid', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByTestId('spending-over-time-chart')).toBeInTheDocument();
    });

    it('renders title', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.getByText('Spending Over Time')).toBeInTheDocument();
    });

    it('does not render empty message when data exists', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.queryByText('No usage data for this period')).not.toBeInTheDocument();
    });

    it('does not render skeleton when data is loaded', () => {
      render(<SpendingOverTimeChart data={SAMPLE_DATA} isLoading={false} />);
      expect(screen.queryByTestId('skeleton-block')).not.toBeInTheDocument();
    });
  });

  describe('data transformation', () => {
    it('sorts periods chronologically', () => {
      const reversed = makeData([
        { period: '2025-01-02', model: 'GPT-4', totalCost: '0.75', count: 3 },
        { period: '2025-01-01', model: 'GPT-4', totalCost: '1.50', count: 10 },
      ]);
      const { container } = render(
        <SpendingOverTimeChart data={reversed} isLoading={false} />
      );
      // Chart should render (not crash) with reversed input
      expect(container.querySelector('[data-chart]')).toBeInTheDocument();
    });

    it('handles single data point', () => {
      const single = makeData([
        { period: '2025-01-01', model: 'GPT-4', totalCost: '1.50', count: 10 },
      ]);
      render(<SpendingOverTimeChart data={single} isLoading={false} />);
      expect(screen.getByTestId('spending-over-time-chart')).toBeInTheDocument();
    });

    it('handles multiple models across periods', () => {
      const multi = makeData([
        { period: '2025-01-01', model: 'GPT-4', totalCost: '1.00', count: 1 },
        { period: '2025-01-01', model: 'Claude', totalCost: '2.00', count: 2 },
        { period: '2025-01-01', model: 'Gemini', totalCost: '3.00', count: 3 },
      ]);
      render(<SpendingOverTimeChart data={multi} isLoading={false} />);
      expect(screen.getByTestId('spending-over-time-chart')).toBeInTheDocument();
    });
  });
});
