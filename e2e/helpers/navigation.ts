import type { Page } from '@playwright/test';

/**
 * Engine-agnostic match for "this navigation was interrupted because another
 * navigation started." A user who just left or lost access to a conversation is
 * client-redirected to /chat; that redirect can fire before a `goto` back into
 * the conversation commits and abort it. Each engine phrases the abort
 * differently — Chromium "interrupted by another navigation", WebKit/mobile
 * Safari "Frame load interrupted", Firefox "NS_BINDING_ABORTED" — so this keys
 * on the bounce *fact*, mirroring the abort-correlation in fixtures.ts rather
 * than matching one engine's prose.
 */
const NAVIGATION_BOUNCE =
  /interrupted by another navigation|Frame load interrupted|NS_BINDING_ABORTED/i;

/**
 * `page.goto(url, { waitUntil: 'commit' })` that tolerates the access-guard
 * bounce. The interruption IS the proof the navigation was redirected; callers
 * assert the resulting URL afterwards. Any non-bounce error rethrows.
 */
export async function gotoToleratingBounce(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'commit' }).catch((error: unknown) => {
    if (!(error instanceof Error) || !NAVIGATION_BOUNCE.test(error.message)) {
      throw error;
    }
  });
}
