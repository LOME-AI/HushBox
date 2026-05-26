// Regression guard for the Firefox `newPage` race condition that the
// `patches/playwright-core@1.58.2.patch` patch fixes.
//
// How to run
// ----------
// This file is intentionally excluded from `pnpm e2e` and every normal
// project's test discovery. It lives under `e2e/patches/` and runs via:
//
//   pnpm e2e:patches
//
// which invokes the dedicated `playwright.patches.config.ts` (no webServer,
// no auth-setup dependency), so the run is fast (~30s total wall clock) and
// does not touch the rest of the suite. There is no automation around it —
// run it by hand when you want to confirm the firefox newPage patch is
// still working, or before bumping playwright-core to a new version.
//
// Background
// ----------
// Without the patch, `FFBrowserContext.doCreateNewPage` in playwright-core's
// Firefox driver assumes that the `Browser.attachedToTarget` event has been
// processed before the `Browser.newPage` protocol response resolves. When the
// response wins the race, `_ffPages.get(targetId)` returns undefined and the
// next dereference (`._page`) throws:
//
//   TypeError: browserContext.newPage: Cannot read properties of undefined
//              (reading '_page')
//
// Upstream issues: microsoft/playwright #35125, #36594 (closed without fix).
//
// What this spec does
// -------------------
// Stress-creates contexts in tight loops, mirroring the `createPageFixture`
// + `groupConversation` pattern in `e2e/fixtures.ts` that triggers the race
// in production (~5% flake rate over the last 3 full-suite runs before the
// patch landed).
//
// Each iteration creates TWO contexts back-to-back (Alice + Bob pattern)
// because that's the production shape: the second `newPage` in a tight pair
// is the one that historically fails.
//
// What counts as a failure
// ------------------------
// The test fails ONLY if the specific upstream TypeError surfaces:
//
//   Cannot read properties of undefined (reading '_page')
//
// That string in an error message means the patch is missing or broken —
// the race that the patch fixes is firing through into user code.
//
// Other Firefox errors are tolerated:
//
// * Errors thrown by our own patched code (`Firefox doCreateNewPage: target X
//   did not attach within 30s` or `target X was detached before initialization
//   completed`) mean the race fired AND the patch caught it cleanly. That's
//   the patch working as designed. We log them and move on.
//
// * Generic `Target page, context or browser has been closed` from `newPage`
//   is the separate Firefox-process-instability issue (upstream #3939, #36551)
//   that this patch was never going to fix. Also logged and tolerated.
//
// Honesty note
// ------------
// This is a probabilistic reproducer, not a deterministic one. The race
// depends on host scheduling between two event-loop ticks; tighter
// reproduction would require monkey-patching playwright-core internals,
// which is fragile. The patch's deterministic correctness is established by
// reading the upstream source (see the comment block above the patched
// `doCreateNewPage` in node_modules); this spec is the load-test that
// proves the patched code still works under heavy parallel contention.

import { test, expect } from '@playwright/test';

const ITERATIONS_PER_TEST = 25;
const NUM_TESTS = 6;

// The exact error string the patch exists to prevent. If this surfaces, the
// patch is missing or broken.
const REGRESSION_MARKER = "Cannot read properties of undefined (reading '_page')";

// Mirrors `buildStorageInitScript` output shape in scripts/storage-state-init-script.ts.
// The race triggers regardless of script content; we keep the shape realistic.
const INIT_SCRIPT = `
  if (location.origin === 'http://localhost:4301' &&
      window.localStorage.getItem('hb-race-probe') === null) {
    window.localStorage.setItem('hb-race-probe', '1');
  }
`;

test.describe('Firefox newPage race regression guard', () => {
  // Parallel mode — multiple workers contending for the firefox session is
  // what amplifies the race window. Serial hides it.
  test.describe.configure({ mode: 'parallel' });

  for (let index = 0; index < NUM_TESTS; index++) {
    test(`paired context+newPage cycles do not throw (run ${String(index + 1)})`, async ({
      browser,
    }) => {
      test.setTimeout(180_000);

      // Track regressions (specific TypeError) separately from tolerated
      // errors (patch-detected race + unrelated Firefox instability).
      const regressions: string[] = [];
      const tolerated: string[] = [];

      const recordIfRegression = (label: string, error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        const where = `${label} (iter ${String(n)} run ${String(index + 1)})`;
        if (message.includes(REGRESSION_MARKER)) {
          regressions.push(`${where}: ${message}`);
        } else {
          tolerated.push(`${where}: ${message}`);
        }
      };

      // `n` is referenced inside recordIfRegression's closure, so declare
      // before the loop.
      let n = 0;
      for (n = 0; n < ITERATIONS_PER_TEST; n++) {
        // Paired contexts mirror the `authenticatedPage` + `testBobPage`
        // pattern in fixtures.ts. The second newPage is historically the one
        // that fails when the race fires.
        const ctxA = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        const ctxB = await browser.newContext({ storageState: { cookies: [], origins: [] } });
        try {
          await ctxA.addInitScript({ content: INIT_SCRIPT });
          await ctxB.addInitScript({ content: INIT_SCRIPT });

          await ctxA.newPage().catch((error: unknown) => {
            recordIfRegression('ctxA.newPage', error);
          });
          await ctxB.newPage().catch((error: unknown) => {
            recordIfRegression('ctxB.newPage', error);
          });
        } finally {
          await ctxA.close().catch(() => {});
          await ctxB.close().catch(() => {});
        }
      }

      if (tolerated.length > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[patch-tests] run ${String(index + 1)}: tolerated ${String(tolerated.length)} ` +
            `non-regression errors (patch-detected or unrelated Firefox instability):\n  ` +
            tolerated.join('\n  ')
        );
      }

      // The actual regression assertion. Empty array = patch is doing its job.
      expect(
        regressions,
        `unpatched-style TypeError reappeared:\n${regressions.join('\n')}`
      ).toEqual([]);
    });
  }
});
