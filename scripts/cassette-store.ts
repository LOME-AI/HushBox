/**
 * CI entry point for the shared cassette store.
 *
 *   pnpm tsx scripts/cassette-store.ts download   # before the suite
 *   pnpm tsx scripts/cassette-store.ts upload     # after it, even on failure
 *
 * Both are best-effort by design: an unreachable store leaves the run with a
 * cold cache, which the record-on-miss harness handles by recording live.
 * Mechanics: docs/CI-CASSETTES.md.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CASSETTE_DIRECTORY } from '@hushbox/shared/cassettes';
import { runCassetteSync } from './lib/test-run/cassette-store.js';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* v8 ignore start -- real-IO wiring; logic lives in tested pure helpers */
async function main(): Promise<number> {
  return runCassetteSync(process.argv[2] ?? '', {
    env: process.env,
    rootDir: path.join(REPO_ROOT, CASSETTE_DIRECTORY),
    fetch: globalThis.fetch,
    log: (message: string) => {
      console.log(message);
    },
  });
}

if (isMainModule(import.meta.url)) {
  await runMain(main);
}
/* v8 ignore stop */
