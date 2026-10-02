import { PROMPT_PREDICTION_STUB_STORAGE_KEY } from '@hushbox/shared';
import type { Page } from '@playwright/test';

/**
 * Turns the composer's sentence-completion hint on for this page.
 *
 * The predictor an end-to-end build carries answers nothing until a page arms
 * it, so every spec that does not call this drives the composer exactly as
 * production ships it — no hint, no candidate list, no extra handlers. That is
 * what keeps this feature out of the other chat specs' way.
 *
 * Runs as an init script, so it lands before the app's own scripts on this
 * navigation and every later one. Call it before the first `goto`.
 */
export async function armPromptPrediction(page: Page): Promise<void> {
  await page.addInitScript((key: string) => {
    // A context opens on a blank page whose opaque origin has no storage to
    // write to, and an init script runs there too.
    if (!location.protocol.startsWith('http')) return;
    globalThis.localStorage.setItem(key, '');
  }, PROMPT_PREDICTION_STUB_STORAGE_KEY);
}
