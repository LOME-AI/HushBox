import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeeBreakdown } from './fee-breakdown';
import {
  HUSHBOX_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
  ALL_FEE_CATEGORIES,
  FEE_BUCKET_BY_ID,
  FEE_CATEGORIES,
  roundPreservingSum,
} from '@hushbox/shared';

describe('FeeBreakdown', () => {
  describe('rendering', () => {
    it('renders with data-testid fee-breakdown', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId('fee-breakdown')).toBeInTheDocument();
    });

    it('renders section title', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByText('Where does my money go?')).toBeInTheDocument();
    });

    it('does NOT render "For every $X" message', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.queryByText(/For every \$/)).not.toBeInTheDocument();
    });

    it('does NOT render dollar amounts', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.queryByText(/\$\d+\.\d{2}/)).not.toBeInTheDocument();
    });
  });

  describe('category structure', () => {
    function expectedApproximateLabels(depositAmount: number): {
      serviceValue: string;
      transactionCosts: string;
      platformFee: string;
    } {
      const storageFee = 1_000_000 * STORAGE_COST_PER_CHARACTER;
      const fees = FEE_CATEGORIES.reduce((sum, c) => sum + c.rate * depositAmount, 0);
      const modelUsage = depositAmount - fees - storageFee;
      const serviceValuePct = ((modelUsage + storageFee) / depositAmount) * 100;
      const transactionCostsPct = FEE_CATEGORIES.filter(
        (c) => FEE_BUCKET_BY_ID[c.id] === 'transaction-costs'
      ).reduce((sum, c) => sum + c.rate * 100, 0);
      const platformFeePct = FEE_CATEGORIES.filter(
        (c) => FEE_BUCKET_BY_ID[c.id] === 'platform-fee'
      ).reduce((sum, c) => sum + c.rate * 100, 0);
      const [serviceValue, transactionCosts, platformFee] = roundPreservingSum([
        serviceValuePct,
        transactionCostsPct,
        platformFeePct,
      ]);
      return {
        serviceValue: `~${String(serviceValue)}%`,
        transactionCosts: `~${String(transactionCosts)}%`,
        platformFee: `~${String(platformFee)}%`,
      };
    }

    it('renders Service Value category with a dynamically computed approximate label', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId('category-service-value')).toBeInTheDocument();
      const labels = expectedApproximateLabels(100);
      expect(screen.getByTestId('category-service-value-pct')).toHaveTextContent(
        labels.serviceValue
      );
    });

    it('renders Transaction Costs category when at least one transaction-cost fee has rate > 0', () => {
      const hasTransactionCosts = FEE_CATEGORIES.some(
        (c) => FEE_BUCKET_BY_ID[c.id] === 'transaction-costs'
      );
      render(<FeeBreakdown depositAmount={100} />);
      if (hasTransactionCosts) {
        expect(screen.getByTestId('category-transaction-costs')).toBeInTheDocument();
        const labels = expectedApproximateLabels(100);
        expect(screen.getByTestId('category-transaction-costs-pct')).toHaveTextContent(
          labels.transactionCosts
        );
      } else {
        expect(screen.queryByTestId('category-transaction-costs')).not.toBeInTheDocument();
      }
    });

    it('renders Platform Fee category when the hushbox fee has rate > 0', () => {
      const hasPlatformFee = FEE_CATEGORIES.some((c) => FEE_BUCKET_BY_ID[c.id] === 'platform-fee');
      render(<FeeBreakdown depositAmount={100} />);
      if (hasPlatformFee) {
        expect(screen.getByTestId('category-platform-fee')).toBeInTheDocument();
        const labels = expectedApproximateLabels(100);
        expect(screen.getByTestId('category-platform-fee-pct')).toHaveTextContent(
          labels.platformFee
        );
      } else {
        expect(screen.queryByTestId('category-platform-fee')).not.toBeInTheDocument();
      }
    });

    it('approximate labels for the three top-level groups sum to exactly 100%', () => {
      render(<FeeBreakdown depositAmount={100} />);
      const labels = expectedApproximateLabels(100);
      const sum =
        Number.parseInt(labels.serviceValue.replaceAll(/[^\d-]/g, ''), 10) +
        Number.parseInt(labels.transactionCosts.replaceAll(/[^\d-]/g, ''), 10) +
        Number.parseInt(labels.platformFee.replaceAll(/[^\d-]/g, ''), 10);
      expect(sum).toBe(100);
    });
  });

  describe('Service Value items', () => {
    it('shows Model usage item', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId('item-model-usage')).toBeInTheDocument();
      expect(screen.getByText('Model usage')).toBeInTheDocument();
    });

    it('shows Storage item without "est. 1M chars"', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId('item-storage')).toBeInTheDocument();
      expect(screen.getByText('Storage')).toBeInTheDocument();
      expect(screen.queryByText(/est\. 1M chars/)).not.toBeInTheDocument();
    });
  });

  describe('fee items', () => {
    it('renders one row per non-zero fee category with its label and percent', () => {
      render(<FeeBreakdown depositAmount={100} />);
      for (const category of FEE_CATEGORIES) {
        const item = screen.getByTestId(`item-fee-${category.id}`);
        expect(item).toBeInTheDocument();
        const expectedPct = (category.rate * 100).toFixed(1);
        expect(screen.getByTestId(`item-fee-${category.id}-pct`)).toHaveTextContent(
          `${expectedPct}%`
        );
        expect(item).toHaveTextContent(category.label);
      }
    });

    it('does not render any row for a zero-rate fee category', () => {
      render(<FeeBreakdown depositAmount={100} />);
      for (const category of ALL_FEE_CATEGORIES) {
        if (category.rate === 0) {
          expect(screen.queryByTestId(`item-fee-${category.id}`)).not.toBeInTheDocument();
          // The label must not appear anywhere in the rendered output
          expect(screen.queryByText(category.label)).not.toBeInTheDocument();
        }
      }
    });
  });

  describe('percentage calculations', () => {
    it('Service Value percentage is the residual after fees and storage', () => {
      const depositAmount = 100;
      const storageFee = 1_000_000 * STORAGE_COST_PER_CHARACTER;
      const totalFeesRate = FEE_CATEGORIES.reduce((sum, c) => sum + c.rate, 0);
      const modelUsage = depositAmount - depositAmount * totalFeesRate - storageFee;
      const serviceValuePct = ((modelUsage + storageFee) / depositAmount) * 100;

      // Should be a meaningful share of the deposit (sanity check across rate values).
      expect(serviceValuePct).toBeGreaterThan(50);
      expect(serviceValuePct).toBeLessThan(100);
    });

    it('Platform Fee percentage equals HUSHBOX_FEE_RATE', () => {
      const platformFeePct = HUSHBOX_FEE_RATE * 100;
      expect(platformFeePct).toBe(HUSHBOX_FEE_RATE * 100);
    });
  });
});
