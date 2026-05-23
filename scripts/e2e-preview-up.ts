/**
 * Orchestrates the Playwright Preview webServer with maximum parallelism.
 *
 * Replaces a long sequential shell chain in playwright.config.ts. Cross-platform:
 * no shell `&&`, no POSIX-only signals — `concurrently` handles process spawning
 * uniformly on macOS, Linux, and Windows, matching the pattern already used by
 * `scripts/preview.ts`.
 *
 * Pipeline:
 *   1. kill-ports + generate:env       (parallel, ~1s)   — env-gen skipped in CI
 *   2. marketing build + web build + db:reset
 *                                       (parallel, gated by longest leg)
 *                                       — db:reset skipped in CI
 *   3. merge-marketing-into-web         (sequential, ~1s)
 *   4. vite preview                     (long-lived, replaces this process)
 *
 * Both builds and db:reset are mutually independent and finish in ~max(60s, 120s,
 * 35s) ≈ 120s in parallel instead of ~215s sequentially.
 */
import { execa } from 'execa';
import concurrently from 'concurrently';
import { isMainModule } from './lib/is-main.js';
import { runMain } from './lib/run-main.js';

export interface Step {
  name: string;
  command: string;
}

function isCI(): boolean {
  return !!process.env['CI'];
}

export async function runPrep(): Promise<void> {
  const steps: Step[] = [
    { name: 'kill-ports', command: 'tsx scripts/kill-ports.ts HB_PREVIEW_PORT' },
  ];
  if (!isCI()) {
    steps.push({ name: 'gen-env', command: 'pnpm generate:env --mode=e2e' });
  }
  const { result } = concurrently(steps, { killOthers: ['failure'], prefix: 'name' });
  await result;
}

export async function runParallelBuilds(): Promise<void> {
  const steps: Step[] = [
    {
      name: 'marketing',
      command: 'pnpm --filter @hushbox/marketing build --mode development',
    },
    {
      name: 'web',
      command: 'pnpm --filter @hushbox/web build --mode development',
    },
  ];
  if (!isCI()) {
    steps.push({ name: 'db', command: 'pnpm db:reset' });
  }
  const { result } = concurrently(steps, { killOthers: ['failure'], prefix: 'name' });
  await result;
}

export async function runMerge(): Promise<void> {
  await execa('tsx', ['scripts/merge-marketing-into-web.ts'], { stdio: 'inherit' });
}

export async function startPreview(): Promise<void> {
  const port = process.env['HB_PREVIEW_PORT'];
  if (!port) {
    throw new Error('HB_PREVIEW_PORT is not set — run pnpm generate:env first');
  }
  await execa('pnpm', ['--filter', '@hushbox/web', 'preview', '--port', port], {
    stdio: 'inherit',
  });
}

export async function main(): Promise<void> {
  await runPrep();
  await runParallelBuilds();
  await runMerge();
  await startPreview();
}

/* v8 ignore start -- CLI entry point exercised via playwright.config.ts */
if (isMainModule(import.meta.url)) {
  await runMain(main);
}
/* v8 ignore stop */
