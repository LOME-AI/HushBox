import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import type { Reporter } from 'vitest/node';

import type * as HookTimeout from './hook-timeout.ts';
import type * as TestFileSpellings from './test-file-spellings.ts';
import type * as VitestCache from '../../scripts/lib/vitest/vitest-cache.ts';
import type * as CoverageDirectory from '../../scripts/lib/vitest/coverage-directory.ts';
import type * as VitestWorkers from '../../scripts/lib/vitest/workers.ts';
import type * as PoolMachine from '../../scripts/lib/pool/machine.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Wherever a module is loaded by Node's own loader rather than through a
// transform that rewrites specifiers, its specifiers resolve literally: a `.js`
// specifier for a `.ts` file is ERR_MODULE_NOT_FOUND, an extensionless one
// likewise, and a static `.ts` specifier is TS5097 unless
// `allowImportingTsExtensions` is on — which cannot be enabled here alone,
// because every package's tsconfig pulls this file in through its own
// `*.config.ts`. A type-only import carries the extension under none of those
// constraints, so the runtime import goes through an explicit URL and the
// destructure below stays fully typed. Vite's config loader is what leaves this
// file's relative imports for Node to resolve.
const { OPTIMIZER_INCLUDE, resolveRunnerCacheNames } = (await import(
  new URL('../../scripts/lib/vitest/vitest-cache.ts', import.meta.url).href
)) as typeof VitestCache;

// The default coverage reports directory, loaded through the same URL form and
// for the same reason the `vitest-cache` import states.
const { UNKEYED_COVERAGE_DIRECTORY } = (await import(
  new URL('../../scripts/lib/vitest/coverage-directory.ts', import.meta.url).href
)) as typeof CoverageDirectory;

// The declaration of how this repository spells a module that exists only so
// tests can run, read rather than re-spelled by every exemption that turns on
// that question — this file's coverage exclude among them. Loaded through the
// same URL form and for the same reason the `vitest-cache` import states.
const { TEST_FILE_GLOB } = (await import(
  new URL('./test-file-spellings.ts', import.meta.url).href
)) as typeof TestFileSpellings;

// The worker count and the store it is derived over, loaded through the same
// URL form and for the same reason the `vitest-cache` import states.
const { deriveRepositoryVitestWorkers, recordVitestRun, repoRelativeTestFile, trackRunSplit } =
  (await import(
    new URL('../../scripts/lib/vitest/workers.ts', import.meta.url).href
  )) as typeof VitestWorkers;
const { machineFingerprint } = (await import(
  new URL('../../scripts/lib/pool/machine.ts', import.meta.url).href
)) as typeof PoolMachine;

// Name the cache after the content of the packages the SSR optimizer prebundles
// (below). Vite's reuse test observes no linked-workspace SOURCE, so a fixed
// directory lets it reuse a prebundle of code that no longer exists — forever,
// and reported as an ordinary assertion failure. A content-addressed directory
// makes that impossible: edited sources resolve to a directory vite has never
// seen. Relative, so
// vitest resolves it against each project's own root exactly as the default
// `node_modules/.vite` did. Rationale: `scripts/lib/vitest/vitest-cache.ts`; the
// claim and the sweep: `scripts/lib/vitest/cache-sweep.ts`.
// The invocation segment inside it is what separates two concurrent runs of ONE
// shape: they agree on the generation and on the lifted segment, so without it
// each deletes and rebundles the directory the other is importing from. Those
// two levels are resolved rather than derived here, because the process that
// started this runner minted them and recorded a claim on the directory before
// this config was ever loaded — the optimizer writes into that directory before
// any of our code runs inside the runner. The third is this runner's own, and
// it is the one level always derived here: one claim holder may start several
// runners at once, and a name handed to all of them is a directory they share.
const { generationName, runSegment, runnerSegment } = await resolveRunnerCacheNames(
  process.env,
  process.pid,
  REPO_ROOT
);
const cacheDir = path.join('node_modules', generationName, runSegment, runnerSegment);

// Single source of truth for the DOM-emulator choice — packages that need a
// browser-like environment import this instead of hardcoding the string, so
// a future swap (or a typo) can't drift between packages.
// A package choosing a DOM environment forfeits its per-worker database clone:
// the setup file below provisions only in a Node realm, and records why there.
export const BROWSER_TEST_ENVIRONMENT = 'happy-dom';

// The hook budget, declared in its own module (`hook-timeout.ts`) and loaded
// through the same URL form and for the same reason the `vitest-cache` import
// states. Re-exported for the configs that import it from here.
const { HOOK_TIMEOUT_MS } = (await import(
  new URL('./hook-timeout.ts', import.meta.url).href
)) as typeof HookTimeout;
export { HOOK_TIMEOUT_MS };

// One decision, so every consumer that declares a vitest worker ceiling takes
// the count from `deriveRepositoryVitestWorkers` rather than spelling one. A
// config that takes this file's test options takes this ceiling with them: a
// package config that merges this one carries it, and
// `vitest.projects.config.ts` drops `maxWorkers` off each package config it
// lifts and spreads this config's test options into its own root block. A
// figure spelled here rather than derived is measured on one machine and decays
// on every other.
// Declared for every run rather than for a coverage run alone: the derivation
// answers for the ceiling itself rather than for the memory-heavy case, and a
// ceiling read off `process.argv` is one nothing can check — a vitest worker's
// argv carries neither the subcommand nor the flags its own run was launched
// with, so every assertion about such a declaration reads its other branch.
// The arguments the count comes out of are assembled there rather than here
// because a launcher has to name a count on the runner's command line before a
// runner exists to read this declaration, and a command-line count replaces
// this one with nothing clamping it afterwards: a second assembly resolving
// differently opens a width nothing chose — narrower is a slower green run,
// wider opens lanes the memory ladder never admitted, which can exhaust the
// machine rather than merely slow it.
const maxWorkers = deriveRepositoryVitestWorkers(REPO_ROOT, machineFingerprint()).derivation
  .workers;

// What a run reaching this configuration puts back into the store the count
// above came out of. Every launcher records the run it spawned, from outside
// it; a run no launcher started — the watch-mode UI, and any bare runner
// resolving this configuration — has no outside, and a run that reads the
// store without ever writing to it leaves the widths it opened priced by
// nobody.
//
// A reporter reaches exactly those runs and no others, and that is the
// runner's own doing rather than an agreement anything here maintains: vitest
// replaces the resolved reporter list wholesale as soon as a command line
// names a reporter, and every launcher that records names one. The console
// reporter is named beside it because declaring any reporter is what
// suppresses the one vitest would otherwise supply.
const RECORDED_RUN_SHAPE: VitestWorkers.VitestRunShape = 'watch';

// How often the run's tree is read while it runs, matching the cadence the
// pool's own sampler states its reason for: re-deriving a peak from every
// fourth reading gave up as much as five percent of it, and understating a
// peak plans a run that does not fit. Spelled rather than imported because the
// one exported spelling sits in a pool CLI whose module graph costs about a
// third of a second to load — a cost every config load in this repository
// would pay for one integer.
const RUN_SAMPLE_INTERVAL_MS = 250;

let runTracker: VitestWorkers.RunSplitTracker | undefined;
let runStartedAt = 0;
let runWorkers = maxWorkers;

const recordingReporter: Reporter = {
  // The count the run really opened: a command line may carry a `--maxWorkers`
  // of its own, and it is that number the lanes below were held at.
  onInit: (vitest) => {
    runWorkers = vitest.config.maxWorkers;
  },
  onTestRunStart: () => {
    runStartedAt = performance.now();
    // One process id answers for both arguments here, and only on this path:
    // the reporter runs inside the runner, whose workers are its own direct
    // children, so the tree measured and the parent the lanes are counted
    // under are the same process. A launcher measures from outside and passes
    // two different ones.
    runTracker = trackRunSplit({
      treeRootPid: process.pid,
      runnerPid: process.pid,
      intervalMs: RUN_SAMPLE_INTERVAL_MS,
    });
  },
  onTestRunEnd: (testModules) => {
    const tracker = runTracker;
    runTracker = undefined;
    if (tracker === undefined) {
      return;
    }
    const tracked = tracker.stop();
    const files = testModules.map((testModule) => ({
      file: repoRelativeTestFile(REPO_ROOT, testModule.moduleId),
      wallMs: testModule.diagnostic().duration,
    }));
    const summedWallMs = files.reduce((total, { wallMs }) => total + wallMs, 0);
    // The row below is assembled a second time, by the measurement the
    // package-rooted launchers share in `scripts/run-package-tests.ts`, and the
    // ladder reads rows from both against each other — so a field derived
    // differently on one side is the ladder comparing itself with itself, and
    // the lanes-at-peak field is where that bites: it states the lanes the
    // tracker saw live at the peak on both sides, never the count the run
    // declared. What the two paths legitimately differ on is what each can
    // observe — a reporter inside the runner reads modules and their projects,
    // a launcher outside it reads the json report and covers one package.
    const disposition = recordVitestRun(
      REPO_ROOT,
      machineFingerprint(),
      {
        wallMs: performance.now() - runStartedAt,
        peakRssKb: tracked.peakRssKb,
        split: tracked.split,
        runnerPid: process.pid,
        declaredWorkers: runWorkers,
        fileCount: files.length,
        peakRunnerChildren: tracked.peakRunnerChildren,
        lanesAtPeak: tracked.lanesAtPeak,
        shape: RECORDED_RUN_SHAPE,
        // Projects, which is what a package is to a runner: a run resolving a
        // package config covers one, and the consolidated config's projects
        // are the packages themselves.
        packageCount: new Set(testModules.map((testModule) => testModule.project.name)).size,
        perFileWallMs: files.length === 0 ? undefined : summedWallMs / files.length,
        sumFileWallMs: files.length === 0 ? undefined : summedWallMs,
      },
      files
    );
    // Refusals only. A watch session ends a run every time a file is saved, so
    // a line per recorded run is noise a reader learns to skip, while a
    // refusal is the one outcome nothing else in the output carries. The
    // launchers' own report is not reused here: it states the derivation the
    // run was launched at, and a command-line count leaves this path unable to
    // name one it is sure of.
    if (disposition.kind === 'refused') {
      console.warn(`[vitest-run] this run recorded no ledger row: ${disposition.reason}`);
    }
  },
};

export default defineConfig({
  cacheDir,
  test: {
    maxWorkers,
    reporters: ['default', recordingReporter],
    // Isolation of mock behaviour between tests, not teardown: `mockReset`
    // restores each `vi.fn(impl)` to its constructor implementation, clears an
    // implementation attached after construction, and drains the `*Once`
    // queues — the only one of the runner's lifecycle options that closes
    // both. It runs before user `beforeEach`, so the dominant
    // beforeEach-establishes-mocks style is untouched. The cost: an
    // implementation attached at module scope is gone before the first test, so
    // a default a suite relies on belongs in the `vi.fn` argument.
    mockReset: true,
    unstubGlobals: true,
    unstubEnvs: true,
    // 15s gives slow integration tests (e.g. message-shares with media
    // middleware spin-up) headroom under heavy parallel `test:all` load
    // while still catching genuine hangs. Tightening below this caused
    // sporadic timeouts that masked true-pass tests.
    // Coverage's JIT-off run inflates CPU-bound (OPAQUE) tests under parallel
    // load; 30s headroom prevents contention-timeouts while the non-coverage
    // path keeps fail-fast at 15s.
    testTimeout: process.argv.includes('--coverage') ? 30000 : 15000,
    hookTimeout: HOOK_TIMEOUT_MS,
    // Lint-rule fixture trees contain *.test.ts files that exist to be linted,
    // not run — keep the test collector out of them. The directory NAME is the
    // whole key, so a corpus renamed out of this shape is collected and run.
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/e2e/**',
      '**/__test-fixtures-*__/**',
      '**/*.workers.test.ts',
    ],
    // Per-worker setup: a Node-realm worker clones its own database from the
    // template, and every worker outside the trusted CI phase gets the fetch
    // guard that turns a call to a non-loopback host into a throw —
    // `scripts/lib/vitest/setup.ts` states why that phase is exempt.
    setupFiles: [path.join(REPO_ROOT, 'scripts/lib/vitest/setup.ts')],
    // Mints the run token, sweeps debris left by killed runs, and keeps the
    // migrated+seeded template current. Runs once per vitest process, before
    // any worker exists — `scripts/lib/vitest/setup.ts` then clones the template
    // per worker slot (Node-realm files only), so concurrent test files never
    // share a database.
    globalSetup: [path.join(REPO_ROOT, 'scripts/lib/vitest/global.setup.ts')],
    // Pre-bundle the heavy internal packages once per worker instead of walking
    // their full module trees per test file. Linked workspace packages are not
    // pre-bundled by default, so they must be named explicitly. Node/SSR test
    // files (the api integration suite) are the beneficiaries; browser-env
    // packages are unaffected.
    deps: {
      optimizer: {
        ssr: {
          enabled: true,
          include: OPTIMIZER_INCLUDE,
        },
      },
    },
    coverage: {
      provider: 'v8',
      // Not `coverage/` itself. The provider empties its reports directory from
      // vitest's start path, before global setup and so before the refusal a run
      // reaching vitest outside the runners earns there; a default naming the
      // parent takes every concurrent run's keyed directory with it
      // (`scripts/lib/vitest/coverage-directory.ts`). The runners pass their own
      // directory and never read this.
      reportsDirectory: UNKEYED_COVERAGE_DIRECTORY,
      // A red run still writes its map. Left at vitest's default the report is
      // skipped whenever any test failed, and the consolidated run makes that
      // one suppression cover every batched package at once: one developer's
      // failing file leaves every other package with no coverage judged, which
      // reads exactly like a coverage pass. It also suppresses the threshold
      // check itself, since vitest gates both behind this one flag. The figures
      // a run with a failure yields are short of the ones it would have
      // produced, so the runners mark such a verdict partial rather than
      // presenting it as a complete one.
      reportOnFailure: true,
      // No 'html': threshold enforcement reads the coverage map directly,
      // independent of which reporters run, so dropping it doesn't touch the
      // gate. Nothing in CI or scripts opens the html tree (coverage/ is
      // gitignored) — it's pure per-file-render cost paid on every run for
      // an artifact nobody reads. Browse coverage on demand instead:
      // `vitest run --coverage --coverage.reporter=html`.
      reporter: ['text', 'json'],
      thresholds: {
        // Per-file rather than aggregate, and inherited rather than opted into:
        // an aggregate threshold lets a small completely untested file
        // disappear into the average of the covered ones, so the safe setting
        // is the one a package gets by declaring nothing. Vitest reads this
        // single flag for every threshold group, the global one and each glob
        // one alike, so a package declaring its own globs needs no flag of its
        // own.
        perFile: true,
        lines: 95,
        branches: 95,
        functions: 95,
        statements: 95,
      },
      exclude: [
        'node_modules/**',
        'dist/**',
        '**/*.d.ts',
        // Build configuration, named by the tool that loads it. Matching
        // `.config.` anywhere in a name instead is what put the
        // environment-variable registry outside the gate: the naming
        // convention that makes a registry findable is the one this list used
        // to read as "not source". The failure modes are asymmetric, which is
        // why the enumeration is the safe shape — a tool whose family is
        // missing here has its config counted against coverage and says so in
        // the run that adds it, while an unnamed source file matching a broad
        // pattern leaves the gate in silence.
        '**/astro.config.*',
        '**/capacitor.config.*',
        '**/drizzle.config.*',
        '**/eslint.config.*',
        '**/playwright.config.*',
        '**/prettier.config.*',
        '**/remotion.config.*',
        '**/stryker.config.*',
        '**/vite.config.*',
        '**/vitest*.config.*',
        // Barrels hold exports only, so they are excluded. The extglob is
        // load-bearing: vitest matches this list with picomatch
        // `contains: true`, so a bare `**/index.ts` also swallows an
        // `index.tsx` — a route component, not a barrel — while every
        // anchored reader of the same list (tinyglobby's ignore, the
        // coverage-scope guard's `fs.globSync`) keeps it. `!(x*)` reads the
        // same under both.
        '**/index.ts!(x*)',
        'e2e/**',
        'mocks/**',
        // Whatever spelling this declaration marks exists only so tests can
        // run, so the one declaration releases the whole class from coverage —
        // the same declaration the test-module exemptions elsewhere read.
        TEST_FILE_GLOB,
        '**/__tests__/**',
        // Keyed on the directory NAME alone, so a corpus renamed out of this
        // shape starts counting against coverage as source that never runs.
        '**/__test-fixtures-*__/**',
      ],
    },
  },
});
