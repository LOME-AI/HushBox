export { applyFees } from '@lome-chat/shared';

export function formatContextLength(length: number): string {
  if (length >= 1000000) {
    return `${String(Math.round(length / 1000000))}M`;
  }
  return `${String(Math.round(length / 1000))}k`;
}

export function formatPricePer1k(pricePerToken: number): string {
  const pricePer1k = pricePerToken * 1000;
  const fixed = pricePer1k.toFixed(10);
  const stripped = fixed.replace(/\.?0+$/, '');
  return `$${stripped}`;
}
