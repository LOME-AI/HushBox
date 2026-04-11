import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env['CI'];
const previewPort = process.env['HB_PREVIEW_PORT']!;
const apiPort = process.env['HB_API_PORT']!;
const previewUrl = `http://localhost:${previewPort}`;
const apiUrl = `http://localhost:${apiPort}`;
const dbReset = isCI ? '' : 'pnpm db:reset && ';
const envGen = isCI ? '' : 'pnpm generate:env --mode=e2e && ';

export default defineConfig({
  globalTeardown: './e2e/global-teardown.ts',
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 1,
  workers: isCI ? 3 : 3,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: isCI
    ? [['list'], ['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'on-failure' }], ['./scripts/e2e-reporter.ts']],
  use: {
    baseURL: previewUrl,
    trace: 'retain-on-failure',
    screenshot: isCI ? 'only-on-failure' : 'on',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: `lsof -ti:${previewPort} | xargs -r kill -9 2>/dev/null || true; ${envGen}${dbReset}pnpm --filter @hushbox/web build --mode development && pnpm --filter @hushbox/web preview --port ${previewPort}`,
      url: previewUrl,
      reuseExistingServer: false,
      timeout: 120_000,
      name: 'Preview',
      stdout: 'pipe',
    },
    {
      command: `lsof -ti:${apiPort} | xargs -r kill -9 2>/dev/null || true; pnpm --filter @hushbox/api dev --log-level error`,
      url: `${apiUrl}/api/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      name: 'API',
      stdout: 'pipe',
    },
  ],
  projects: [
    // In CI, each matrix job installs one browser engine, so setup must match.
    // Locally, all browsers are installed — use a single chromium setup to save time
    // (iron-session cookies are engine-agnostic).
    ...(isCI
      ? [
          {
            name: 'setup-chromium',
            testMatch: /auth\.setup\.ts/,
            use: { ...devices['Desktop Chrome'] },
          },
          {
            name: 'setup-firefox',
            testMatch: /auth\.setup\.ts/,
            use: { ...devices['Desktop Firefox'] },
          },
          {
            name: 'setup-webkit',
            testMatch: /auth\.setup\.ts/,
            use: { ...devices['Desktop Safari'] },
          },
        ]
      : [
          {
            name: 'setup',
            testMatch: /auth\.setup\.ts/,
            use: { ...devices['Desktop Chrome'] },
          },
        ]),
    // Auth tests create their own users — no dependency on setup project
    {
      name: 'auth-tests',
      testDir: './e2e/auth',
      use: { ...devices['Desktop Chrome'] },
    },
    // Desktop browser projects run web/ and api/ tests only
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        storageState: 'e2e/.auth/test-alice.json',
      },
      testDir: './e2e',
      testIgnore: ['**/mobile/**'],
      dependencies: [isCI ? 'setup-chromium' : 'setup'],
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], storageState: 'e2e/.auth/test-alice.json' },
      testDir: './e2e',
      testIgnore: ['**/mobile/**', '**/smoke.spec.ts'],
      dependencies: [isCI ? 'setup-firefox' : 'setup'],
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], storageState: 'e2e/.auth/test-alice.json' },
      testDir: './e2e',
      testIgnore: ['**/mobile/**', '**/smoke.spec.ts'],
      dependencies: [isCI ? 'setup-webkit' : 'setup'],
    },
    // Mobile device projects run all tests (including mobile-specific)
    {
      name: 'iphone-15',
      use: { ...devices['iPhone 15'], storageState: 'e2e/.auth/test-alice.json' },
      testIgnore: ['**/smoke.spec.ts'],
      dependencies: [isCI ? 'setup-webkit' : 'setup'],
    },
    {
      name: 'pixel-7',
      use: { ...devices['Pixel 7'], storageState: 'e2e/.auth/test-alice.json' },
      testIgnore: ['**/smoke.spec.ts'],
      dependencies: [isCI ? 'setup-chromium' : 'setup'],
    },
    {
      name: 'ipad-pro',
      use: { ...devices['iPad Pro 11'], storageState: 'e2e/.auth/test-alice.json' },
      testIgnore: ['**/smoke.spec.ts'],
      dependencies: [isCI ? 'setup-webkit' : 'setup'],
    },
  ],
});
