import { defineConfig, devices } from '@playwright/test';

import { firefoxLaunchOptions } from './e2e/firefox-launch-options';

const isCI = !!process.env['CI'];
const previewPort = process.env['HB_PREVIEW_PORT']!;
const apiPort = process.env['HB_API_PORT']!;
const previewUrl = `http://localhost:${previewPort}`;
const apiUrl = `http://localhost:${apiPort}`;

export default defineConfig({
  globalTeardown: './e2e/global-teardown.ts',
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 1,
  workers: isCI ? 3 : '45%',
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: isCI
    ? [['list'], ['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'on-failure' }], ['./scripts/e2e-reporter.ts']],
  use: {
    baseURL: previewUrl,
    trace: 'retain-on-first-failure',
    screenshot: isCI ? 'only-on-failure' : 'on',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      // Cross-platform orchestrator: kill-ports + generate:env in parallel,
      // then marketing build + web build + db:reset in parallel, then merge,
      // then `vite preview`. The merged dist is exactly what Cloudflare Pages
      // serves in production (/chat, /roadmap, /welcome, /blog reachable from
      // one origin), so E2E covers the same routing as users see.
      command: 'tsx scripts/e2e-preview-up.ts',
      url: previewUrl,
      reuseExistingServer: false,
      timeout: 180_000,
      name: 'Preview',
      stdout: 'pipe',
    },
    {
      command: `tsx scripts/kill-ports.ts HB_API_PORT && pnpm --filter @hushbox/api dev --log-level error`,
      url: `${apiUrl}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      name: 'API',
      stdout: 'pipe',
    },
  ],
  projects: [
    // One setup project per test project; each authenticates that project's
    // personas (suffixed with the project name) to e2e/.auth/<project>/*.json.
    // Naturally gated: setup runs only when its dependent project is in the
    // run, so CI matrix jobs touch a single user pool.
    {
      name: 'setup-chromium',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'setup-firefox',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Firefox'], launchOptions: firefoxLaunchOptions },
    },
    {
      name: 'setup-webkit',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Safari'] },
    },
    {
      name: 'setup-iphone-15',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['iPhone 15'] },
    },
    {
      name: 'setup-pixel-7',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Pixel 7'] },
    },
    {
      name: 'setup-ipad-pro',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['iPad Pro 11'] },
    },
    {
      name: 'setup-auth-tests',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'auth-tests',
      testDir: './e2e/auth',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/auth-tests/test-alice.json',
      },
      dependencies: ['setup-auth-tests'],
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/chromium/test-alice.json',
      },
      testDir: './e2e',
      testIgnore: ['**/mobile/**', '**/patches/**'],
      dependencies: ['setup-chromium'],
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        storageState: 'e2e/.auth/firefox/test-alice.json',
        launchOptions: firefoxLaunchOptions,
      },
      testDir: './e2e',
      testIgnore: ['**/mobile/**', '**/patches/**'],
      dependencies: ['setup-firefox'],
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        storageState: 'e2e/.auth/webkit/test-alice.json',
      },
      testDir: './e2e',
      testIgnore: ['**/mobile/**', '**/patches/**'],
      dependencies: ['setup-webkit'],
    },
    {
      name: 'iphone-15',
      use: {
        ...devices['iPhone 15'],
        storageState: 'e2e/.auth/iphone-15/test-alice.json',
      },
      testIgnore: ['**/patches/**'],
      dependencies: ['setup-iphone-15'],
    },
    {
      name: 'pixel-7',
      use: {
        ...devices['Pixel 7'],
        storageState: 'e2e/.auth/pixel-7/test-alice.json',
      },
      testIgnore: ['**/patches/**'],
      dependencies: ['setup-pixel-7'],
    },
    {
      name: 'ipad-pro',
      use: {
        ...devices['iPad Pro 11'],
        storageState: 'e2e/.auth/ipad-pro/test-alice.json',
      },
      testIgnore: ['**/patches/**'],
      dependencies: ['setup-ipad-pro'],
    },
    // Note: tests that guard local playwright-core patches live in
    // `e2e/patches/` and run via a separate config (`playwright.patches.config.ts`,
    // invoked by `pnpm e2e:patches`). They are deliberately excluded from
    // every project here via `testIgnore: ['**/patches/**']` so that
    // `pnpm e2e` never picks them up.
  ],
});
