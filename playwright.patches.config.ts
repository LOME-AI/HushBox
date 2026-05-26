// Dedicated Playwright config for tests under `e2e/patches/` that guard
// our local `playwright-core` patches in `patches/`.
//
// Why a separate config?
// ----------------------
// The main `playwright.config.ts` runs every project listed under its
// `projects:` array by default — there's no way to mark a project as
// "skip unless explicitly selected." If we declared a `patch-tests`
// project in the main config, `pnpm e2e` would always run it.
// A separate config + the `**/patches/**` testIgnore on every main-config
// project guarantees these tests are only ever invoked via:
//
//   pnpm e2e:patches
//
// Why no webServer / setup-firefox dependency / custom reporter?
// --------------------------------------------------------------
// The reproducer spec under `e2e/patches/` creates fresh browser contexts
// and calls `newPage` in tight loops, but never navigates anywhere. It
// doesn't need the preview server, auth state, or the REPORT.md reporter.
// Stripping those out keeps `pnpm e2e:patches` fast (~30s) so it's
// painless to run by hand.

import { defineConfig, devices } from '@playwright/test';

import { firefoxLaunchOptions } from './e2e/firefox-launch-options';

export default defineConfig({
  testDir: './e2e/patches',
  fullyParallel: true,
  reporter: [['list']],
  // 45s default is enough for the longest patch test (~25s) plus padding.
  timeout: 60_000,
  // Cap workers to avoid a separate Firefox bug: spawning multiple firefox
  // processes simultaneously on the same host SIGSEGVs the browser during
  // its own startup (before any of our test code runs). That crash is
  // unrelated to the doCreateNewPage race the patch fixes. 2 workers still
  // gives the cross-worker IPC contention that exercises the race, without
  // overloading the launcher.
  workers: 2,
  use: {
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    {
      name: 'patch-tests',
      use: { ...devices['Desktop Firefox'], launchOptions: firefoxLaunchOptions },
    },
  ],
});
