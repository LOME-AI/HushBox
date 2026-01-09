import * as React from 'react';

interface MessageCostProps {
  /** Cost in USD as a string (e.g., "0.00136000") */
  cost: string;
}

/**
 * Formats a cost string for display.
 * - Shows 4 decimal places for costs >= $0.0001
 * - Shows 6 decimal places for very small costs
 * - Prepends $ sign
 */
function formatCost(cost: string): string {
  const numericCost = parseFloat(cost);

  if (isNaN(numericCost) || numericCost === 0) {
    return '$0.00';
  }

  // For very small costs (< $0.0001), show more precision
  if (numericCost < 0.0001) {
    return `$${numericCost.toFixed(6)}`;
  }

  // For normal costs, show 4 decimal places
  return `$${numericCost.toFixed(4)}`;
}

/**
 * Displays the cost of an AI message in the bottom-left corner.
 */
export function MessageCost({ cost }: MessageCostProps): React.JSX.Element {
  const formattedCost = formatCost(cost);

  return (
    <span
      className="text-muted-foreground cursor-default text-xs opacity-60 transition-opacity hover:opacity-100"
      data-testid="message-cost"
    >
      {formattedCost}
    </span>
  );
}
