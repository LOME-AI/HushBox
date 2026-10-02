import type { usePromptBudget as realUsePromptBudget } from '@/hooks/billing/use-prompt-budget';

/**
 * Stands in for the composer's budget hook inside `composer-bar.browser.test.ts`'s
 * fixture: a funded, settled text turn with content, so Send is enabled and no notice
 * draws. The real hook's module graph (the catalog, the funding reads, the session) is
 * left out of a page that measures layout.
 * @toolContract
 */
export function usePromptBudget(): ReturnType<typeof realUsePromptBudget> {
  return {
    fundingSource: 'personal_balance',
    notifications: [],
    notices: [],
    payerSwitch: undefined,
    capacityPercent: 12,
    capacityBand: 'room_to_spare',
    capacityCurrentUsage: 12_000,
    capacityMaxCapacity: 100_000,
    estimatedCostNanoUsd: undefined,
    isOverCapacity: false,
    hasBlockingError: false,
    hasPersistentBlockingError: false,
    sendRefusal: undefined,
    isBillingLoading: false,
    hasContent: true,
    isAffordabilitySettled: true,
    maxOutputTokens: 8000,
    estimatedInputTokens: 40,
    mediaOptions: undefined,
    effortDimension: undefined,
  };
}
