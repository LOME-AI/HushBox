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
    timeout: 15_000,
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
      command: 'pnpm --filter @lome-chat/web dev',
      url: 'http://localhost:5173',
      reuseExistingServer: !process.env['CI'],
    },
    {
      command: 'pnpm --filter @lome-chat/api dev',
      url: 'http://localhost:8787/health',
      reuseExistingServer: !process.env['CI'],
    },
  ],
  projects: [
    // Setup project authenticates as each persona and saves storage state
    {
      name: 'setup',
      testMatch: /auth\.setup\.ts/,
    },
    // Browser projects use test-alice's auth state by default
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'e2e/.auth/test-alice.json' },
      dependencies: ['setup'],
    },
    {
      name: 'firefox',
      use: { ...devices['Desktop Firefox'], storageState: 'e2e/.auth/test-alice.json' },
      dependencies: ['setup'],
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], storageState: 'e2e/.auth/test-alice.json' },
      dependencies: ['setup'],
    },
    // Mobile devices
    {
      name: 'iphone-15',
      use: { ...devices['iPhone 15'], storageState: 'e2e/.auth/test-alice.json' },
      dependencies: ['setup'],
    },
    {
      name: 'pixel-7',
      use: { ...devices['Pixel 7'], storageState: 'e2e/.auth/test-alice.json' },
      dependencies: ['setup'],
    },
  ],
});
