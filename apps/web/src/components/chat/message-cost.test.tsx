import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageCost } from './message-cost';

describe('MessageCost', () => {
  it('renders cost with full precision, trailing zeros stripped', () => {
    render(<MessageCost cost="0.00136000" />);

    expect(screen.getByTestId('message-cost')).toHaveTextContent('$0.00136');
  });

  it('renders zero cost as $0.00', () => {
    render(<MessageCost cost="0.00000000" />);

    expect(screen.getByTestId('message-cost')).toHaveTextContent('$0.00');
  });

  it('renders very small cost with 6 decimal places', () => {
    render(<MessageCost cost="0.00002100" />);

    expect(screen.getByTestId('message-cost')).toHaveTextContent('$0.000021');
  });

  it('strips trailing zeros from cost', () => {
    render(<MessageCost cost="0.01500000" />);

    expect(screen.getByTestId('message-cost')).toHaveTextContent('$0.015');
  });

  it('handles invalid cost string gracefully', () => {
    render(<MessageCost cost="invalid" />);

    expect(screen.getByTestId('message-cost')).toHaveTextContent('$0.00');
  });
});
