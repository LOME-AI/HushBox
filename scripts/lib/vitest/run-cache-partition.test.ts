import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { execa } from 'execa';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { RUN_CACHE_SEGMENT_PATTERN } from './vitest-cache.js';

/**
 * Two concurrent runs of ONE invocation shape must not delete each other's
 * dependency bundles.
 *
 * The shape-keyed partition separates a lifted project from the same package
 * invoked at its own root; it does not separate two runs of either. Observed
 * before this test existed: with both runs pointed at one directory, the
 * arriving run logged the removal of that directory, rebundled for over a
 * second, and every file the running one collected in the gap failed on a
 * dependency bundle that was no longer there.
 *
 * The arriving run removes it whenever it judges the directory invalid, and its
 * validity test covers the installed dependency state — which is what changes
 * here between the two runs, because it is what changes between two runs on a
 * machine where dependencies are installed while suites are running.
 *
 * The fixture takes its cache path from the shipped derivation rather than
 * spelling one, so a derivation that stopped separating the two runs fails here
 * instead of failing a suite.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Enough files, and slow enough, that one run is still collecting when the other arrives. */
const PROBE_FILES = 140;
const PROBE_DELAY_MS = 1200;
const DEPENDENCY_MODULES = 400;
const SECOND_RUN_DELAY_MS = 8000;
const FIXTURE_CACHE_DIR = path.join('node_modules', '.vite-fixture');

interface RunResult {
  readonly exitCode: number | undefined;
  readonly output: string;
}

let fixture = '';
let runs: RunResult[] = [];

/** Every `deps_ssr` the fixture holds, wherever the runner put it. */
function dependencyDirectories(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const child = path.join(directory, entry.name);
      if (entry.name === 'deps_ssr') found.push(child);
      else if (!entry.name.includes('_temp_')) walk(child);
    }
  };
  walk(path.join(fixture, 'pkg', FIXTURE_CACHE_DIR));
  return found;
}

/** The invocation segment a dependency directory sits under, of which there is exactly one. */
function invocationSegment(dependencyDirectory: string): string {
  return (
    dependencyDirectory
      .split(path.sep)
      .find((segment) => RUN_CACHE_SEGMENT_PATTERN.test(segment)) ?? ''
  );
}

/**
 * The runner, under the TypeScript loader this repository always runs it under:
 * the configuration below reaches the shipped derivation through a runtime
 * import, exactly as the repository's own configurations do, and that import is
 * left to Node.
 */
async function runVitest(): Promise<RunResult> {
  const result = await execa(
    'vitest',
    ['run', '--config', path.join(fixture, 'consolidated.config.ts')],
    {
      cwd: fixture,
      preferLocal: true,
      localDir: REPO_ROOT,
      env: { NODE_OPTIONS: '--import tsx' },
      all: true,
      reject: false,
    }
  );
  return { exitCode: result.exitCode, output: result.all };
}

beforeAll(async () => {
  fixture = mkdtempSync(path.join(tmpdir(), 'hb-run-cache-partition-'));
  const installedState = writeFixture(fixture);
  runs = await Promise.all([
    runVitest(),
    (async (): Promise<RunResult> => {
      await new Promise((resolve) => setTimeout(resolve, SECOND_RUN_DELAY_MS));
      // What an install does to the state the runner's validity test reads, and
      // the reason the second run judges the first's bundle invalid.
      writeFileSync(installedState, "lockfileVersion: '9.0'\ndependencies: {}\n");
      return runVitest();
    })(),
  ]);
}, 300_000);

afterAll(() => {
  rmSync(fixture, { recursive: true, force: true });
});

describe('two concurrent runs of one invocation shape', () => {
  it('both complete', () => {
    expect(runs.map((run) => run.exitCode)).toEqual([0, 0]);
  });

  it('neither loses the dependency bundle it is importing from', () => {
    for (const run of runs) {
      expect(run.output).not.toMatch(/Cannot find module .*deps_ssr/);
    }
  });

  it('writes one dependency directory per run', () => {
    expect(dependencyDirectories()).toHaveLength(2);
  });

  it('puts the two runs under different invocation segments', () => {
    const segments = dependencyDirectories().map((directory) => invocationSegment(directory));
    expect(new Set(segments).size).toBe(2);
  });
});

/**
 * A one-package workspace the runner can be pointed at, lifted exactly as the
 * repository's own consolidated configuration lifts a package. The dependency
 * is large enough that rebundling it takes long enough to be observed, and the
 * probe files are slow enough that a run is still collecting them while the
 * other arrives.
 *
 * Returns the installed-state file the runner's validity test reads.
 */
function writeFixture(root: string): string {
  // The configuration below carries a top-level await, which the loader compiles
  // for the module system the nearest manifest declares; and the loader the
  // runner is started under resolves from here.
  writeFileSync(path.join(root, 'package.json'), '{"name":"fixture","type":"module"}');
  mkdirSync(path.join(root, 'node_modules'), { recursive: true });
  symlinkSync(path.join(REPO_ROOT, 'node_modules', 'tsx'), path.join(root, 'node_modules', 'tsx'));
  const packageRoot = path.join(root, 'pkg');
  const dependency = path.join(packageRoot, 'node_modules', 'fixture-dependency');
  mkdirSync(dependency, { recursive: true });
  let index = '';
  for (let module = 0; module < DEPENDENCY_MODULES; module += 1) {
    const exports = Array.from(
      { length: 40 },
      (_, name) => `export const value${String(module)}_${String(name)} = ${String(module * name)};`
    ).join('\n');
    writeFileSync(path.join(dependency, `m${String(module)}.js`), `${exports}\n`);
    index += `export * from './m${String(module)}.js';\n`;
  }
  writeFileSync(path.join(dependency, 'index.js'), `${index}export const value = 42;\n`);
  writeFileSync(
    path.join(dependency, 'package.json'),
    '{"name":"fixture-dependency","version":"1.0.0","type":"module","main":"index.js"}'
  );
  writeFileSync(path.join(packageRoot, 'package.json'), '{"name":"pkg","type":"module"}');

  const installedState = path.join(packageRoot, 'node_modules', '.pnpm', 'lock.yaml');
  mkdirSync(path.dirname(installedState), { recursive: true });
  writeFileSync(installedState, "lockfileVersion: '9.0'\n");

  for (let file = 0; file < PROBE_FILES; file += 1) {
    writeFileSync(
      path.join(packageRoot, `t${String(file).padStart(2, '0')}.probe.test.ts`),
      "import { value } from 'fixture-dependency';\n" +
        "import { it, expect } from 'vitest';\n" +
        `it('loads the dependency ${String(file)}', async () => {\n` +
        `  await new Promise((resolve) => setTimeout(resolve, ${String(PROBE_DELAY_MS)}));\n` +
        '  expect(value).toBe(42);\n' +
        '});\n'
    );
  }

  const test = {
    name: 'pkg',
    include: ['*.probe.test.ts'],
    deps: { optimizer: { ssr: { enabled: true, include: ['fixture-dependency'] } } },
  };
  const cacheModule = new URL('vitest-cache.ts', import.meta.url).href;
  writeFileSync(
    path.join(root, 'consolidated.config.ts'),
    `import path from 'node:path';\n` +
      `const { liftedCacheDir, runCacheSegment } = await import(${JSON.stringify(cacheModule)});\n` +
      `const cacheDir = path.join(${JSON.stringify(FIXTURE_CACHE_DIR)}, runCacheSegment(process.pid));\n` +
      `export default {\n` +
      `  test: {\n` +
      `    projects: [\n` +
      `      {\n` +
      `        root: ${JSON.stringify(packageRoot)},\n` +
      `        cacheDir: liftedCacheDir(cacheDir, 'pkg'),\n` +
      `        test: ${JSON.stringify(test)},\n` +
      `      },\n` +
      `    ],\n` +
      `  },\n` +
      `};\n`
  );
  return installedState;
}
