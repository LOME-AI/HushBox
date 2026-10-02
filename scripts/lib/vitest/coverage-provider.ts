import { createRequire } from 'node:module';

// Resolved through Node's native loader, not this realm's import graph:
// `takeCoverage` runs inside the fork right after each test file, and several
// suites here replace `node:fs` (and could replace `node:os`/`node:path`) with
// `vi.mock` factories — under isolation this module evaluates inside that
// mocked registry, so even an eval-time import would capture the mock and the
// dump would silently never reach disk. Native `require` bypasses the test
// runner's module graph entirely.
const nativeRequire = createRequire(import.meta.url);
const { randomUUID } = nativeRequire('node:crypto') as typeof import('node:crypto');
const { mkdirSync, writeFileSync } = nativeRequire('node:fs') as typeof import('node:fs');
const path = nativeRequire('node:path') as typeof import('node:path');

import v8Module from '@vitest/coverage-v8';

import { forkDumpDirectoryName, requireForkDumpRoot } from './fork-dumps.js';

import type { ThreadedV8Provider } from './coverage-provider-host.ts';

/**
 * The coverage provider module for the consolidated test run. This file loads
 * in every fork (vitest resolves `customProviderModule` inside workers for the
 * start/take/stop hooks), so it stays light and pulls the host-process
 * provider class in lazily through `getProvider`.
 *
 * `takeCoverage` diverges from stock: the fork writes its own dump file and
 * reports only `{ __file }`. Stock ships the multi-megabyte dump over the
 * runner RPC and the host JSON.stringifies it back to disk — twice through
 * the host's single thread, per test file; here the serialization happens in
 * the forks, in parallel, and the host handles filenames. The host provider
 * (`coverage-provider-host.ts`) understands the marker and sweeps
 * unconsumed dump files after failed runs.
 */

// Inside the run's coverage reports directory, which the host provider
// publishes: that directory is keyed to the run's claim, so a run killed
// before its own sweep has its dumps removed with the directory by the next
// run's coverage reclaim. Under node_modules/.cache — where they used to sit —
// nothing could attribute a dump to a run, so a killed run's dumps stood
// forever. Never os.tmpdir() either: on distros where /tmp is tmpfs every dump
// byte is RAM until the merge workers consume it, and a full run writes
// thousands of dumps.
let dumpDir: string | undefined;
let dumpSeq = 0;

type TakeCoverageOptions = Parameters<NonNullable<(typeof v8Module)['takeCoverage']>>[0];

/**
 * Vitest resolves this module from the `customProviderModule` path string in
 * the consolidated config and reads its default export, so no module imports it.
 * @toolContract
 */
export default {
  ...v8Module,
  async takeCoverage(options: TakeCoverageOptions): Promise<{ __file: string }> {
    const result: unknown = await v8Module.takeCoverage?.(options);
    if (dumpDir === undefined) {
      dumpDir = path.join(
        requireForkDumpRoot(process.env),
        forkDumpDirectoryName(process.pid, randomUUID())
      );
      mkdirSync(dumpDir, { recursive: true });
    }
    const file = path.join(dumpDir, `cov-${String(dumpSeq)}.json`);
    dumpSeq += 1;
    writeFileSync(file, JSON.stringify(result));
    return { __file: file };
  },
  async getProvider(): Promise<ThreadedV8Provider> {
    // Explicit-URL runtime import: a static `.ts` specifier trips TS5097 and
    // an extensionless one fails Node's runtime resolution (the same
    // constraint the shared vitest base config documents).
    const host = (await import(
      new URL('coverage-provider-host.ts', import.meta.url).href
    )) as typeof import('./coverage-provider-host.ts');
    return new host.ThreadedV8Provider();
  },
};
