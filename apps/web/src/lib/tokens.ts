import { formatNumber } from '@lome-chat/shared';

// Re-export from shared - single source of truth

/**
 * Format token count for display.
 * Uses K suffix for thousands, M suffix for millions.
 */
export function formatTokenCount(tokens: number): string {
  return formatNumber(tokens);
}

export { formatContextLength, estimateTokenCount } from '@lome-chat/shared';
