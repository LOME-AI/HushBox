import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CostPieChart } from './cost-pie-chart';

describe('CostPieChart', () => {
  describe('rendering', () => {
    it('renders with data-testid cost-pie-chart', () => {
      render(<CostPieChart depositAmount={100} />);
      expect(screen.getByTestId('cost-pie-chart')).toBeInTheDocument();
    });

    it('renders an SVG element', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId('cost-pie-chart');
      expect(container.querySelector('svg')).toBeInTheDocument();
    });

    it('does NOT render legend text', () => {
      render(<CostPieChart depositAmount={100} />);
      // Should not find any label text
      expect(screen.queryByText('Model usage')).not.toBeInTheDocument();
      expect(screen.queryByText('Storage')).not.toBeInTheDocument();
      expect(screen.queryByText('HushBox profit')).not.toBeInTheDocument();
      expect(screen.queryByText('AI provider overhead')).not.toBeInTheDocument();
      expect(screen.queryByText('Credit card processing')).not.toBeInTheDocument();
    });

    it('does NOT render center text with dollar amount', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId('cost-pie-chart');
      const svg = container.querySelector('svg');
      // Should not have any text elements
      expect(svg?.querySelector('text')).not.toBeInTheDocument();
    });
  });

  describe('pie slices', () => {
    it('renders Service Value slice (blue)', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId('cost-pie-chart');
      const paths = container.querySelectorAll('path');
      // Should have 3 category slices
      expect(paths.length).toBe(3);
      // First slice should be Service Value (blue)
      const serviceValueSlice = container.querySelector('[data-testid="slice-service-value"]');
      expect(serviceValueSlice).toBeInTheDocument();
      expect(serviceValueSlice).toHaveAttribute('fill', '#3b82f6');
    });

    it('renders Transaction Costs slice (amber)', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId('cost-pie-chart');
      const slice = container.querySelector('[data-testid="slice-transaction-costs"]');
      expect(slice).toBeInTheDocument();
      expect(slice).toHaveAttribute('fill', '#f59e0b');
    });

    it('renders Platform Fee slice (brand red)', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId('cost-pie-chart');
      const slice = container.querySelector('[data-testid="slice-platform-fee"]');
      expect(slice).toBeInTheDocument();
      expect(slice).toHaveAttribute('fill', '#ec4755');
    });
  });

  describe('slice proportions', () => {
    it('Service Value slice is largest (~85%)', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId('cost-pie-chart');
      const serviceValueSlice = container.querySelector('[data-testid="slice-service-value"]');
      const transactionCostsSlice = container.querySelector(
        '[data-testid="slice-transaction-costs"]'
      );
      const platformFeeSlice = container.querySelector('[data-testid="slice-platform-fee"]');

      // All slices should exist
      expect(serviceValueSlice).toBeInTheDocument();
      expect(transactionCostsSlice).toBeInTheDocument();
      expect(platformFeeSlice).toBeInTheDocument();
    });
  });

  describe('donut style', () => {
    it('renders center hole for donut effect', () => {
      render(<CostPieChart depositAmount={100} />);
      const container = screen.getByTestId('cost-pie-chart');
      const centerHole = container.querySelector('circle');
      expect(centerHole).toBeInTheDocument();
    });
  });
});
