import type { useReasoningEffort as realUseReasoningEffort } from '@/hooks/chat/use-reasoning-effort';

let effortShown = true;

/**
 * Whether the turn carries an effort selection, so the effort chip draws. Set by the
 * fixture before it mounts a composer.
 */
export function showEffort(shown: boolean): void {
  effortShown = shown;
}

/**
 * Stands in for the effort hook inside `composer-bar.browser.test.ts`'s fixture: the
 * chip draws "Auto" for one model when effort is shown, and nothing otherwise.
 * @toolContract
 */
export function useReasoningEffort(): ReturnType<typeof realUseReasoningEffort> {
  return {
    preferred: 'auto',
    effective: effortShown ? 'auto' : undefined,
    models: effortShown ? [] : undefined,
    setSelection: () => undefined,
  };
}

/** @toolContract */
export function useEffortAvailabilityPublisher(): void {
  // The real hook publishes the graded set to the effort store; the fixture has no store.
}
