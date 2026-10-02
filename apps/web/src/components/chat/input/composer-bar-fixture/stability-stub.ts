import type { useStability as realUseStability } from '@/providers/stability-provider';

/**
 * Stands in for the app's stability provider inside `composer-bar.browser.test.ts`'s fixture.
 * @toolContract
 */
export function useStability(): ReturnType<typeof realUseStability> {
  return { isAuthStable: true, isBalanceStable: true, isAppStable: true };
}
