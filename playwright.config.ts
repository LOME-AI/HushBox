import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env['CI'];
const previewPort = process.env['HB_PREVIEW_PORT']!;
const apiPort = process.env['HB_API_PORT']!;
const previewUrl = `http://localhost:${previewPort}`;
const apiUrl = `http://localhost:${apiPort}`;

// Chromium-only launch flag, scoped to chromium-based projects (WebKit rejects
// unknown flags and fails to launch). --disable-dev-shm-usage keeps Chromium
// off the small /dev/shm tmpfs; the DevBox entrypoint also grows /dev/shm. GPU
// acceleration is intentionally left enabled so the iGPU offloads rendering —
// the renderer each engine resolves to is printed once per run by
// e2e/global-setup.ts.
const chromiumLaunchOptions = { args: ['--disable-dev-shm-usage'] };

export default defineConfig({
  globalSetup: './e2e/global-setup.ts',
  globalTeardown: './e2e/global-teardown.ts',
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 1,
  workers: isCI ? 3 : '45%',
  timeout: 45_000,
  // Backstop so a wedged run can't hang forever. Playwright aborts via its
  // normal shutdown, which group-kills each webServer — so it won't leak orphan
  // dev servers the way a hard Ctrl+C of a stuck run does. Sized above the
  // observed full local matrix (~46m); raise if that grows.
  globalTimeout: 75 * 60_000,
  expect: {
    timeout: 10_000,
  },
  reporter: isCI
    ? [['list'], ['github'], ['html', { open: 'never' }]]
    : [['dot'], ['html', { open: 'on-failure' }], ['./scripts/e2e-reporter.ts']],
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
      timeout: 300_000,
      name: 'Preview',
      stdout: 'ignore',
    },
    {
      command: `tsx scripts/kill-ports.ts HB_API_PORT && pnpm --filter @hushbox/api dev`,
      url: `${apiUrl}/api/health`,
      reuseExistingServer: false,
      timeout: 180_000,
      name: 'API',
      stdout: 'ignore',
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
      use: { ...devices['Desktop Chrome'], launchOptions: chromiumLaunchOptions },
    },
    {
      name: 'setup-firefox',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Firefox'] },
      // Per-project worker cap. Firefox content-process inits are race-prone
      // on lower-spec CPUs (Ryzen 5 5500 without iGPU SIGSEGV'd at workers=5
      // / 45% of cores in the firefox project specifically). Capping just
      // the firefox projects keeps other projects at the full global pool.
      workers: isCI ? 2 : '30%',
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
      use: { ...devices['Pixel 7'], launchOptions: chromiumLaunchOptions },
    },
    {
      name: 'setup-ipad-pro',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['iPad Pro 11'] },
    },
    {
      name: 'setup-auth-tests',
      testMatch: /auth\.setup\.ts/,
      use: { ...devices['Desktop Chrome'], launchOptions: chromiumLaunchOptions },
    },
    {
      name: 'auth-tests',
      testDir: './e2e/auth',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/auth-tests/test-alice.json',
        launchOptions: chromiumLaunchOptions,
      },
      dependencies: ['setup-auth-tests'],
    },
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/chromium/test-alice.json',
        launchOptions: chromiumLaunchOptions,
      },
      testDir: './e2e',
      testIgnore: ['**/mobile/**'],
      dependencies: ['setup-chromium'],
    },
    {
      name: 'firefox',
      use: {
        ...devices['Desktop Firefox'],
        storageState: 'e2e/.auth/firefox/test-alice.json',
      },
      testDir: './e2e',
      testIgnore: ['**/mobile/**'],
      dependencies: ['setup-firefox'],
      // See setup-firefox above for why firefox is capped below the global
      // worker count. Other projects are unconstrained and can use the
      // remaining slots while firefox tests are throttled.
      workers: isCI ? 2 : '30%',
    },
    {
      name: 'webkit',
      use: {
        ...devices['Desktop Safari'],
        storageState: 'e2e/.auth/webkit/test-alice.json',
      },
      testDir: './e2e',
      testIgnore: ['**/mobile/**'],
      dependencies: ['setup-webkit'],
    },
    {
      name: 'iphone-15',
      use: {
        ...devices['iPhone 15'],
        storageState: 'e2e/.auth/iphone-15/test-alice.json',
      },
      dependencies: ['setup-iphone-15'],
    },
    {
      name: 'pixel-7',
      use: {
        ...devices['Pixel 7'],
        storageState: 'e2e/.auth/pixel-7/test-alice.json',
        launchOptions: chromiumLaunchOptions,
      },
      dependencies: ['setup-pixel-7'],
    },
    {
      name: 'ipad-pro',
      use: {
        ...devices['iPad Pro 11'],
        storageState: 'e2e/.auth/ipad-pro/test-alice.json',
      },
      dependencies: ['setup-ipad-pro'],
    },
  ],
});
