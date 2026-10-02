import { type Locator, type Page } from '@playwright/test';
import { expect } from './expect.js';
import { TIMEOUTS } from '../config/timeouts.js';

/**
 * Playwright's bundled WebKit on Linux cannot decode video bytes.
 *
 * The headless WebKit binary ships with the WPE backend, which was built
 * without a functioning media-source pipeline. `<video>` elements receive
 * a blob/HTTP URL, fire `loadstart`, the internal GStreamer pipeline emits
 * `stalled`, and the element never reaches `readyState >= 1`. The behaviour
 * is independent of codec (H.264, VP8, VP9 all fail the same way) and
 * independent of container (MP4 and WebM both fail). `canPlayType` and
 * `MediaSource.isTypeSupported` both return `'probably'`/`true` for these
 * formats — the lie is in the runtime decode path, not the capability
 * report. The MiniBrowser binary is linked against the system GStreamer
 * libraries but the in-process media pipeline doesn't reach them.
 *
 * References:
 *   - https://github.com/microsoft/playwright/issues/13059
 *   - Empirically reproduced 2026-05-20: same blob URL gives Chromium
 *     `duration=5.758`, Linux WebKit `duration=null, readyState=0`.
 *
 * Affects every Playwright project whose engine is WebKit:
 *   - `webkit` (Desktop Safari emulation)
 *   - `iphone-15` (device descriptor only changes viewport/UA — engine is
 *     the same Playwright WebKit binary)
 *   - `ipad-pro` (same)
 *
 * --- Production is not affected ---
 *
 * Real Safari on macOS / iOS / iPadOS ships with the full AVFoundation /
 * VideoToolbox media stack — H.264 MP4 in a `<video>` element decodes
 * natively. The production code path (`apps/web/src/components/chat/media-
 * preview.tsx`) is engine-agnostic; the only browser-specific behaviour
 * lives inside the browser itself. The mock fixture (`apps/api/src/
 * services/ai/mock-fixtures/test-video.ts`) is loaded only by the mock
 * AI client used in local dev and E2E; production traffic flows through
 * the real AI gateway (Veo / Gemini / etc.) returning real MP4 bytes that
 * real Safari decodes. Skipping the decode assertion on Linux WebKit is a
 * test-infrastructure trade-off, not a coverage gap for real users.
 *
 * Coverage for the WebKit engine still comes from:
 *   - The UI-flow assertions in these same tests (element rendered, src
 *     bound, cost/nametag/download-link present) which DO run on WebKit.
 *   - The remaining `webkit` / `iphone-15` / `ipad-pro` non-video tests.
 *   - Any real-Safari coverage that runs separately (macOS smoke job /
 *     device-farm pass) — out of scope for this helper.
 */

/** Returns true when the running engine cannot decode `<video>` bytes. */
export function lacksMediaDecode(browserName: string): boolean {
  return browserName === 'webkit';
}

/**
 * Resolve the browser engine name from a `Page`. Equivalent to the
 * `browserName` test fixture but usable inside page objects, which don't
 * have direct access to fixtures.
 */
export function getBrowserName(page: Page): string {
  return page.context().browser()?.browserType().name() ?? 'chromium';
}

/**
 * Assert a `<video>` element has progressed far enough to expose a
 * positive finite `duration` — the canonical proof that the bytes parsed
 * and the moov atom / EBML header was understood.
 *
 * On engines that cannot decode (see file header), the assertion degrades
 * to "element has a non-empty `src`" so the surrounding UI flow still
 * runs end-to-end. This keeps the test useful on Linux WebKit (rendering,
 * controls, cost-badge, download-link assertions still execute) without
 * waiting for a `loadedmetadata` event that will never fire.
 */
export async function expectVideoDecoded(
  videoLocator: Locator,
  browserName: string,
  options: { timeout?: number } = {}
): Promise<void> {
  const timeout = options.timeout ?? TIMEOUTS.MEDIA_DECODE;
  if (lacksMediaDecode(browserName)) {
    await expect(videoLocator).toHaveAttribute('src', /\S/, { timeout });
    return;
  }
  await expect
    .poll(
      async () =>
        videoLocator.evaluate((el) => {
          const v = el as HTMLVideoElement;
          return Number.isFinite(v.duration) ? v.duration : 0;
        }),
      { timeout }
    )
    .toBeGreaterThan(0);
}
