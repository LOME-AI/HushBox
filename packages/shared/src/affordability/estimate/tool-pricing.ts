/**
 * The one fee seam for tool calls. Each tool's published per-call provider price
 * is private to this module, and its only reader bakes the fee in once,
 * ceil-rounded against the user, by the same method catalog ingestion bakes token
 * rates. Every hold and every charge reads the after-fee figure; nothing outside
 * this module can read the raw price.
 */

import { applyMarkupCeil, usdToNanoUsd } from '../money/money.ts';
import type { ToolName } from '../tool-loop.ts';

/**
 * Each tool's published provider price per call, in USD, before the fee. The
 * search provider's published per-request price.
 */
const PROVIDER_USD_PER_CALL: Readonly<Record<ToolName, number>> = {
  webSearch: 0.005,
};

/** One call of `tool`, billable: the provider price with the fee baked in. */
export function toolCallBillableNano(tool: ToolName): bigint {
  return applyMarkupCeil(usdToNanoUsd(PROVIDER_USD_PER_CALL[tool]));
}
