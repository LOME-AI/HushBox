import type { usePayerPremiumAccess as realUsePayerPremiumAccess } from '@/hooks/models/use-payer-premium-access';

/**
 * Stands in for the payer's premium reach inside `composer-bar.browser.test.ts`'s
 * fixture: a payer who may enter every modality, so each mode control draws enabled.
 * @toolContract
 */
export function usePayerPremiumAccess(): ReturnType<typeof realUsePayerPremiumAccess> {
  return { status: 'known', canAccessPremium: true };
}
