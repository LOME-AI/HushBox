export { applyFees, formatContextLength, formatPricePer1k } from '@lome-chat/shared';

export function formatBalance(balance: string | number): string {
  const numericBalance = typeof balance === 'string' ? parseFloat(balance) : balance;

  if (isNaN(numericBalance)) {
    return '$0.0000';
  }

  return `$${numericBalance.toFixed(4)}`;
}
