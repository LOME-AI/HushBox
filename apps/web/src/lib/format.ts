export { applyFees, formatContextLength, formatPricePer1k } from '@hushbox/shared';

export function formatBalance(balance: string | number): string {
  const numericBalance = typeof balance === 'string' ? Number.parseFloat(balance) : balance;

  if (Number.isNaN(numericBalance)) {
    return '$0.0000';
  }

  return `$${numericBalance.toFixed(4)}`;
}
