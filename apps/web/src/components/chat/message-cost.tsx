import * as React from 'react';
import { formatCost } from '@lome-chat/shared';

interface MessageCostProps {
  /** Cost in USD as a string (e.g., "0.00136000") */
  cost: string;
}

/**
 * Displays the cost of an AI message in the bottom-left corner.
 */
export function MessageCost({ cost }: Readonly<MessageCostProps>): React.JSX.Element {
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
