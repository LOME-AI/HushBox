import { execFileSync } from 'node:child_process';

/**
 * Playwright loads this file from the `globalTeardown` path in
 * `playwright.config.ts` and calls its default export, so no module imports it.
 * @toolContract
 */
export default function globalTeardown(): void {
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- dev tooling, pnpm resolved via PATH is expected
  execFileSync('pnpm', ['generate:env'], { stdio: 'inherit' });
}
