import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TEST_IDS } from '@hushbox/shared';
import { CostBreakdown } from './cost-breakdown';

const TITLE = 'Where does my money go?';

describe('CostBreakdown', () => {
  it('titles itself as a level-2 heading when asked', () => {
    render(<CostBreakdown depositAmount={100} headingLevel={2} />);
    expect(screen.getByRole('heading', { level: 2, name: TITLE })).toBeInTheDocument();
  });

  it('titles itself as a level-3 heading when asked', () => {
    render(<CostBreakdown depositAmount={10} headingLevel={3} />);
    expect(screen.getByRole('heading', { level: 3, name: TITLE })).toBeInTheDocument();
  });

  it('renders one title', () => {
    render(<CostBreakdown depositAmount={100} headingLevel={2} />);
    expect(screen.getAllByRole('heading')).toHaveLength(1);
  });

  it('renders the fee list and the ring', () => {
    render(<CostBreakdown depositAmount={100} headingLevel={2} />);
    expect(screen.getByTestId(TEST_IDS.feeBreakdown)).toBeInTheDocument();
    expect(screen.getByTestId(TEST_IDS.costPieChart)).toBeInTheDocument();
  });

  it('draws the list and the ring for the deposit it is given', () => {
    render(<CostBreakdown depositAmount={10} headingLevel={3} />);
    expect(screen.getByTestId(TEST_IDS.itemStoragePct)).toHaveTextContent('3.0%');
    expect(
      screen.getByRole('img', {
        name: 'Service Value about 85%, Transaction Costs about 10%, Platform Fee about 5%',
      })
    ).toBeInTheDocument();
  });

  it('prices storage for the characters it is given', () => {
    render(<CostBreakdown depositAmount={1} estimatedCharacters={35_000} headingLevel={2} />);
    expect(screen.getByTestId(TEST_IDS.itemStoragePct)).toHaveTextContent('1.1%');
  });

  it('sets the list beside the ring once the cost-split container is wide enough', () => {
    const { container } = render(<CostBreakdown depositAmount={100} headingLevel={2} />);
    const root = container.firstElementChild;
    expect(root).toHaveClass('@container');
    const grid = root?.firstElementChild;
    expect(grid).toHaveClass('grid', '@cost-split:grid-cols-2');
    expect(grid?.children).toHaveLength(2);
  });
});
