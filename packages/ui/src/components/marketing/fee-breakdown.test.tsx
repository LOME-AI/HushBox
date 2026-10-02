import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import {
  HUSHBOX_FEE_RATE,
  ALL_FEE_CATEGORIES,
  FEE_BUCKET_BY_ID,
  FEE_CATEGORIES,
  TEST_IDS,
  TEST_ID_BUILDERS,
} from '@hushbox/shared';
import { costCategoryShares } from './cost-category-shares';
import { FeeBreakdown } from './fee-breakdown';

// Fee-category labels are authored in sentence-flow casing for the legal copy;
// the breakdown list renders each with an initial capital.
const capitalized = (label: string): string => label.charAt(0).toUpperCase() + label.slice(1);

describe('FeeBreakdown', () => {
  describe('rendering', () => {
    it('renders with data-testid fee-breakdown', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId(TEST_IDS.feeBreakdown)).toBeInTheDocument();
    });

    it('renders section title', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByText('Where does my money go?')).toBeInTheDocument();
    });

    it('titles itself as a level-3 heading by default', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(
        screen.getByRole('heading', { level: 3, name: 'Where does my money go?' })
      ).toBeInTheDocument();
    });

    it('titles itself at the heading level it is given', () => {
      render(<FeeBreakdown depositAmount={100} headingLevel={2} />);
      expect(
        screen.getByRole('heading', { level: 2, name: 'Where does my money go?' })
      ).toBeInTheDocument();
    });

    it('sets its title in the title-2 type role', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByRole('heading', { name: 'Where does my money go?' })).toHaveClass(
        'text-title-2'
      );
    });

    it('keeps the category swatches in their colours under forced colours', () => {
      render(<FeeBreakdown depositAmount={100} />);
      const swatches = screen
        .getByTestId(TEST_IDS.feeBreakdown)
        .querySelectorAll('[aria-hidden="true"]');
      expect(swatches.length).toBeGreaterThan(0);
      for (const swatch of swatches) {
        expect(swatch).toHaveClass('forced-color-adjust-none');
      }
    });

    it('lets a long word break before the list overflows its column', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId(TEST_IDS.feeBreakdown)).toHaveClass('min-w-0', 'wrap-anywhere');
    });

    it('keeps every percentage whole on one line', () => {
      render(<FeeBreakdown depositAmount={100} />);
      const percentages = [
        TEST_IDS.categoryServiceValuePct,
        TEST_IDS.itemModelUsagePct,
        TEST_ID_BUILDERS.feeItemPct('hushbox'),
      ];
      for (const testId of percentages) {
        expect(screen.getByTestId(testId)).toHaveClass('shrink-0', 'whitespace-nowrap');
      }
    });

    it('hides the category swatches from assistive technology', () => {
      render(<FeeBreakdown depositAmount={100} />);
      const categories = [
        TEST_IDS.categoryServiceValue,
        TEST_IDS.categoryTransactionCosts,
        TEST_IDS.categoryPlatformFee,
      ];
      for (const testId of categories) {
        const swatch = screen.getByTestId(testId).querySelector('[aria-hidden="true"]');
        expect(swatch).toBeInTheDocument();
        expect(swatch).toBeEmptyDOMElement();
      }
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
      const [serviceValue, transactionCosts, platformFee] = costCategoryShares(
        depositAmount
      ).categories.map((category) => category.approximateLabel);
      return {
        serviceValue: serviceValue ?? '',
        transactionCosts: transactionCosts ?? '',
        platformFee: platformFee ?? '',
      };
    }

    it('renders Service Value category with a dynamically computed approximate label', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId(TEST_IDS.categoryServiceValue)).toBeInTheDocument();
      const labels = expectedApproximateLabels(100);
      expect(screen.getByTestId(TEST_IDS.categoryServiceValuePct)).toHaveTextContent(
        labels.serviceValue
      );
    });

    it('renders Transaction Costs category when at least one transaction-cost fee has rate > 0', () => {
      const hasTransactionCosts = FEE_CATEGORIES.some(
        (c) => FEE_BUCKET_BY_ID[c.id] === 'transaction-costs'
      );
      render(<FeeBreakdown depositAmount={100} />);
      if (hasTransactionCosts) {
        expect(screen.getByTestId(TEST_IDS.categoryTransactionCosts)).toBeInTheDocument();
        const labels = expectedApproximateLabels(100);
        expect(screen.getByTestId(TEST_IDS.categoryTransactionCostsPct)).toHaveTextContent(
          labels.transactionCosts
        );
      } else {
        expect(screen.queryByTestId(TEST_IDS.categoryTransactionCosts)).not.toBeInTheDocument();
      }
    });

    it('renders Platform Fee category when the hushbox fee has rate > 0', () => {
      const hasPlatformFee = FEE_CATEGORIES.some((c) => FEE_BUCKET_BY_ID[c.id] === 'platform-fee');
      render(<FeeBreakdown depositAmount={100} />);
      if (hasPlatformFee) {
        expect(screen.getByTestId(TEST_IDS.categoryPlatformFee)).toBeInTheDocument();
        const labels = expectedApproximateLabels(100);
        expect(screen.getByTestId(TEST_IDS.categoryPlatformFeePct)).toHaveTextContent(
          labels.platformFee
        );
      } else {
        expect(screen.queryByTestId(TEST_IDS.categoryPlatformFee)).not.toBeInTheDocument();
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
    it('renders the storage share rounded from the exact storage cost', () => {
      // 35,000 characters cost exactly $0.0105 — 1.05% of a $1 deposit, which
      // rounds to 1.1%. Multiplying the float dollar rate instead lands one ULP
      // below and renders 1.0%.
      render(<FeeBreakdown depositAmount={1} estimatedCharacters={35_000} />);
      expect(screen.getByTestId(TEST_IDS.itemStoragePct)).toHaveTextContent('1.1%');
    });

    it('shows Model usage item', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId(TEST_IDS.itemModelUsage)).toBeInTheDocument();
      expect(screen.getByText('Model usage')).toBeInTheDocument();
    });

    it('shows Storage item without "est. 1M chars"', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId(TEST_IDS.itemStorage)).toBeInTheDocument();
      expect(screen.getByText('Storage')).toBeInTheDocument();
      expect(screen.queryByText(/est\. 1M chars/)).not.toBeInTheDocument();
    });
  });

  describe('fee items', () => {
    it('renders one row per non-zero fee category with its label and percent', () => {
      render(<FeeBreakdown depositAmount={100} />);
      for (const category of FEE_CATEGORIES) {
        const item = screen.getByTestId(TEST_ID_BUILDERS.feeItem(category.id));
        expect(item).toBeInTheDocument();
        const expectedPct = (category.rate * 100).toFixed(1);
        expect(screen.getByTestId(TEST_ID_BUILDERS.feeItemPct(category.id))).toHaveTextContent(
          `${expectedPct}%`
        );
        expect(item).toHaveTextContent(capitalized(category.label));
      }
    });

    it('does not render any row for a zero-rate fee category', () => {
      render(<FeeBreakdown depositAmount={100} />);
      for (const category of ALL_FEE_CATEGORIES) {
        if (category.rate === 0) {
          expect(
            screen.queryByTestId(TEST_ID_BUILDERS.feeItem(category.id))
          ).not.toBeInTheDocument();
          // The label must not appear anywhere in the rendered output
          expect(screen.queryByText(capitalized(category.label))).not.toBeInTheDocument();
        }
      }
    });
  });

  describe('percentages', () => {
    it('renders the Service Value items from the shares', () => {
      render(<FeeBreakdown depositAmount={10} />);
      const items = costCategoryShares(10).serviceValue.items;
      const [modelUsage, storage] = items;
      expect(screen.getByTestId(TEST_IDS.itemModelUsagePct)).toHaveTextContent(
        `${(modelUsage?.percentage ?? Number.NaN).toFixed(1)}%`
      );
      expect(screen.getByTestId(TEST_IDS.itemStoragePct)).toHaveTextContent(
        `${(storage?.percentage ?? Number.NaN).toFixed(1)}%`
      );
    });

    it('renders the Platform Fee item at HUSHBOX_FEE_RATE', () => {
      render(<FeeBreakdown depositAmount={100} />);
      expect(screen.getByTestId(TEST_ID_BUILDERS.feeItemPct('hushbox'))).toHaveTextContent(
        `${(HUSHBOX_FEE_RATE * 100).toFixed(1)}%`
      );
    });
  });
});
