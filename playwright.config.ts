import { defineConfig, devices } from '@playwright/test';

const isCI = !!process.env['CI'];

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 1,
  workers: isCI ? 2 : 4,
  timeout: 45_000,
  expect: {
    timeout: 10_000,
  },
  reporter: isCI ? [['github'], ['html', { open: 'never' }]] : [['html', { open: 'on-failure' }]],
  use: {
    baseURL: 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  webServer: [
    {
      command: 'pnpm --filter @hushbox/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env['CI'],
    },
    {
      command: 'pnpm --filter @hushbox/api dev',
      url: 'http://localhost:8787/api/health',
      reuseExistingServer: !process.env['CI'],
    },
  ],
  projects: [
    // Per-browser setup projects — each authenticates personas using its own engine,
    // so CI jobs only need to install one browser (no chromium dependency on all jobs)
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
      dependencies: ['setup-chromium'],
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], storageState: 'e2e/.auth/test-alice.json' },
      testDir: './e2e',
      testIgnore: ['**/mobile/**', '**/smoke.spec.ts'],
      dependencies: ['setup-firefox'],
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], storageState: 'e2e/.auth/test-alice.json' },
      testDir: './e2e',
      testIgnore: ['**/mobile/**', '**/smoke.spec.ts'],
      dependencies: ['setup-webkit'],
    },
    // Mobile device projects run all tests (including mobile-specific)
    {
      name: 'iphone-15',
      use: { ...devices['iPhone 15'], storageState: 'e2e/.auth/test-alice.json' },
      testIgnore: ['**/smoke.spec.ts'],
      dependencies: ['setup-webkit'],
    },
    {
      name: 'pixel-7',
      use: { ...devices['Pixel 7'], storageState: 'e2e/.auth/test-alice.json' },
      testIgnore: ['**/smoke.spec.ts'],
      dependencies: ['setup-chromium'],
    },
    {
      name: 'ipad-pro',
      use: { ...devices['iPad Pro 11'], storageState: 'e2e/.auth/test-alice.json' },
      testIgnore: ['**/smoke.spec.ts'],
      dependencies: ['setup-webkit'],
    },
  ],
});
