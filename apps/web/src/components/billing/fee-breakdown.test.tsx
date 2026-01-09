import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { FeeBreakdown } from './fee-breakdown';
import {
  LOME_FEE_RATE,
  CREDIT_CARD_FEE_RATE,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_CHARACTER,
} from '@lome-chat/shared';

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
      // Should not find any $X.XX patterns in fee items
      expect(screen.queryByText(/\$\d+\.\d{2}/)).not.toBeInTheDocument();
    });
  });

  describe('category structure', () => {
    it('renders Service Value category header with ~85%', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId('category-service-value')).toBeInTheDocument();
      expect(screen.getByTestId('category-service-value-pct')).toHaveTextContent(/~85%/);
    });

    it('renders Transaction Costs category header with ~10%', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId('category-transaction-costs')).toBeInTheDocument();
      expect(screen.getByTestId('category-transaction-costs-pct')).toHaveTextContent(/~10%/);
    });

    it('renders Platform Fee category header with ~5%', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId('category-platform-fee')).toBeInTheDocument();
      expect(screen.getByTestId('category-platform-fee-pct')).toHaveTextContent(/~5%/);
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

  describe('Transaction Costs items', () => {
    it('shows Payment processing with percentage', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId('item-payment-processing')).toBeInTheDocument();
      const expectedPct = (CREDIT_CARD_FEE_RATE * 100).toFixed(1);
      expect(screen.getByTestId('item-payment-processing-pct')).toHaveTextContent(
        `${expectedPct}%`
      );
    });

    it('shows AI Provider fees with percentage', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId('item-provider-fees')).toBeInTheDocument();
      const expectedPct = (PROVIDER_FEE_RATE * 100).toFixed(1);
      expect(screen.getByTestId('item-provider-fees-pct')).toHaveTextContent(`${expectedPct}%`);
    });
  });

  describe('Platform Fee items', () => {
    it('shows LOME margin with percentage', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId('item-lome-margin')).toBeInTheDocument();
      const expectedPct = (LOME_FEE_RATE * 100).toFixed(1);
      expect(screen.getByTestId('item-lome-margin-pct')).toHaveTextContent(`${expectedPct}%`);
    });
  });

  describe('percentage calculations', () => {
    it('calculates Service Value percentage correctly', () => {
      const depositAmount = 100;
      const storageFee = 1000000 * STORAGE_COST_PER_CHARACTER;
      const lomeFee = depositAmount * LOME_FEE_RATE;
      const ccFee = depositAmount * CREDIT_CARD_FEE_RATE;
      const providerFee = depositAmount * PROVIDER_FEE_RATE;
      const modelUsage = depositAmount - lomeFee - ccFee - providerFee - storageFee;
      const serviceValuePct = ((modelUsage + storageFee) / depositAmount) * 100;

      render(<FeeBreakdown depositAmount={depositAmount} />);
      // Should be approximately 85%
      expect(serviceValuePct).toBeGreaterThan(80);
      expect(serviceValuePct).toBeLessThan(90);
    });

    it('calculates Transaction Costs percentage correctly', () => {
      const transactionCostsPct = (CREDIT_CARD_FEE_RATE + PROVIDER_FEE_RATE) * 100;
      // Should be 10%
      expect(transactionCostsPct).toBe(10);
    });

    it('calculates Platform Fee percentage correctly', () => {
      const platformFeePct = LOME_FEE_RATE * 100;
      // Should be 5%
      expect(platformFeePct).toBe(5);
    });
  });
});
