import { mkdir } from 'node:fs/promises';
import { defineConfig, devices, type PlaywrightTestConfig } from '@playwright/test';

// Reached by path, not by package name: the repo root belongs to no workspace,
// so no `node_modules/@hushbox/*` link resolves here.
import { TIMEOUTS } from './e2e/config/timeouts';
import { apiHealthUrl } from './scripts/lib/playwright/api-health';
import {
  computeProjectGrepInvert,
  resolveRunProjects,
  RUN_PROJECTS_VARIABLE,
} from './scripts/lib/playwright/browser-matrix';
import { projectCallerIp } from './scripts/lib/playwright/identities';
import {
  ALL_PROJECT_NAMES,
  BROWSER_MATRIX_PROJECTS,
  E2E_PROJECT_NAMES,
  PLANE_PROJECTS,
  setupProjectName,
  type E2EProjectName,
  type MatrixProject,
  type ProjectName,
} from './scripts/lib/playwright/projects';
import { resolveLocalWorkerCount } from './scripts/lib/playwright/worker-count';
import { e2eRamPaths, prepareRamRoot, ramRootRequiredBytes } from './scripts/lib/stack/ram-root';
import { stackModeFrom } from './scripts/lib/stack/stack-mode';

const isCI = !!process.env['CI'];

// Local workers come from the per-CPU registry (resolveLocalWorkerCount),
// falling back to 45% of logical cores for an untuned CPU; CI stays pinned at
// 7. The persona pool (E2E_WORKER_POOL_SIZE) is derived as the max of that
// resolved local count and CI's 7, so it always covers whatever `workers`
// count runs: workers ≤ pool by construction. pooledPersonaName() takes
// workerIndex modulo the pool, so a worker count within the pool never wraps
// higher-index workers back onto shared wallets. The per-project caps below
// stay ≤ pool.
const WORKERS = isCI ? 7 : resolveLocalWorkerCount();

/**
 * On Linux, the browsers a Playwright worker launches keep their hot files in
 * the E2E RAM root, so no page load waits on a disk commit: Chromium's
 * shared-memory files follow the temporary directory it inherits, and
 * Playwright makes Firefox's profile in the temporary directory of the worker
 * that launches it, so only the worker's own `TMPDIR` reaches both.
 *
 * Playwright evaluates this file again in every worker, and sets
 * `TEST_WORKER_INDEX` there and nowhere else. The runner, its webServers and
 * global setup and teardown keep the machine's temporary directory: the claims
 * registry every checkout shares and the lifeline sockets both follow
 * `os.tmpdir()`, and moving the runner's would hide this run from every other
 * process that reads them.
 *
 * The runner of an E2E-stack run checks the root has room for this run's
 * workers here rather than in a setup module, because Playwright starts every
 * webServer before any global setup runs. A load under another stack checks
 * nothing: knip loads this file, and a load is not a run.
 */
const ramPaths = e2eRamPaths();
if (ramPaths !== undefined && process.env['TEST_WORKER_INDEX'] !== undefined) {
  await mkdir(ramPaths.browserTmp, { recursive: true });
  process.env['TMPDIR'] = ramPaths.browserTmp;
} else if (ramPaths !== undefined && stackModeFrom(process.env) === 'e2e') {
  await prepareRamRoot(import.meta.dirname, ramRootRequiredBytes(WORKERS));
}

// All projects render at DPR 1. The retina presets (iPhone 15 = 3, Pixel 7 ≈
// 2.625, iPad Pro = 2, Desktop Safari = 2) rasterize several× the pixels for no
// coverage gain — the CSS viewport is unchanged, only raster fidelity drops. Set
// per-project because a top-level `use` is overridden by each `...devices[...]`.
const DEVICE_SCALE_FACTOR = 1;

/**
 * The worktree's computed ports arrive through `scripts/with-env.ts`. Read
 * unguarded, a missing one interpolates as `localhost:undefined` and fails every
 * project with a connection error that names nothing, so this fails fast and
 * names the variable instead (CODE-RULES bans silent env fallbacks).
 */
function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set - run Playwright through scripts/with-env.ts`);
  }
  return value;
}

const previewPort = requiredEnv('HB_PREVIEW_PORT');
const apiPort = requiredEnv('HB_API_PORT');
const adminPort = requiredEnv('HB_ADMIN_PORT');
const sandboxPort = requiredEnv('HB_SANDBOX_PORT');
/**
 * Set by a caller that already built and downloaded the bundles (CI's e2e-build
 * job), so the preview servers serve what is on disk instead of rebuilding it.
 */
const prebuiltFlag = process.env['HB_E2E_PREBUILT'] ? ' --prebuilt' : '';

const previewUrl = `http://localhost:${previewPort}`;
const adminUrl = `http://localhost:${adminPort}`;
const sandboxUrl = `http://localhost:${sandboxPort}`;

// Chromium-only launch flag, scoped to chromium-based projects (WebKit rejects
// unknown flags and fails to launch). --disable-dev-shm-usage makes Chromium
// keep its shared-memory files in its temporary directory rather than in
// /dev/shm itself: on Linux that is the worker's directory in the E2E RAM root,
// which the runner's capacity check accounts for and each bring-up empties. GPU
// acceleration is intentionally left enabled so the iGPU offloads rendering —
// the renderer each engine resolves to is printed once per run by
// e2e/global-setup.ts.
const chromiumLaunchOptions = { args: ['--disable-dev-shm-usage'] };

// Which projects the RUN comprises — not always what this process executes, as
// CI splits one run across one single-project process per project and declares
// the whole set to each of them. What this process executes is read off argv,
// the only channel, since Playwright filters projects after this module is
// evaluated. An argv form the parser cannot fully understand throws here rather
// than resolving to a default set: a wrong default silently changes which specs
// run, which is the class of bug the declared matrix exists to remove.
const runProjects = resolveRunProjects({
  argv: process.argv,
  runSet: process.env[RUN_PROJECTS_VARIABLE],
  knownProjects: ALL_PROJECT_NAMES,
  isCI,
});

type Project = NonNullable<PlaywrightTestConfig['projects']>[number];

/**
 * Everything a project declares that is NOT derived from the registry. Keyed by
 * project name as an exhaustive Record, so a project added to the registry
 * without settings here is a compile error rather than a project that silently
 * runs with defaults.
 *
 * Device presets stay written out as literal `devices[...]` lookups: the key is
 * checked against Playwright's own device names, whereas a name carried through
 * the registry would be an index-signature lookup that spreads `undefined` for a
 * typo without complaint.
 */
interface ProjectSettings {
  /** Shared with the project's setup project — which must NOT inherit its storage state. */
  readonly use: NonNullable<Project['use']>;
  /** Absent where the project authenticates itself instead of replaying a saved session. */
  readonly storageState?: string;
  /** Absent where the project takes the config-level `testDir`. */
  readonly testDir?: string;
  readonly testIgnore?: readonly string[];
  readonly workers?: number | string;
}

// Directory routers, and the only two left. `**/mobile/**` draws the
// form-factor axis the registry's roles declare, so the desktop projects
// exclude it and the device projects do not. `**/admin/**` belongs to the admin
// plane, whose own testDir is the one place those specs run.
const DESKTOP_TEST_IGNORE = ['**/mobile/**', '**/admin/**'];
const DEVICE_TEST_IGNORE = ['**/admin/**'];

// Firefox content-process inits are race-prone on lower-spec CPUs (a Ryzen 5
// 5500 without iGPU SIGSEGV'd at workers=5 / 45% of cores in the firefox project
// specifically). Capping just the firefox projects keeps other projects at the
// full global pool.
const FIREFOX_WORKERS = isCI ? 4 : '30%';

const PROJECT_SETTINGS: Record<ProjectName, ProjectSettings> = {
  chromium: {
    use: {
      ...devices['Desktop Chrome'],
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      launchOptions: chromiumLaunchOptions,
    },
    storageState: 'e2e/.auth/chromium/test-alice.json',
    testDir: './e2e',
    testIgnore: DESKTOP_TEST_IGNORE,
  },
  firefox: {
    use: {
      ...devices['Desktop Firefox'],
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      // Every test opens a fresh context and the disk cache keys its entries
      // per context, so nothing it keeps is read again; left on, it grows each
      // worker's profile with every test.
      launchOptions: { firefoxUserPrefs: { 'browser.cache.disk.enable': false } },
    },
    storageState: 'e2e/.auth/firefox/test-alice.json',
    testDir: './e2e',
    testIgnore: DESKTOP_TEST_IGNORE,
    workers: FIREFOX_WORKERS,
  },
  webkit: {
    use: { ...devices['Desktop Safari'], deviceScaleFactor: DEVICE_SCALE_FACTOR },
    storageState: 'e2e/.auth/webkit/test-alice.json',
    testDir: './e2e',
    testIgnore: DESKTOP_TEST_IGNORE,
  },
  'iphone-15': {
    // Pin DPR below the device's retina factor to free render budget (see
    // DEVICE_SCALE_FACTOR). The CSS viewport is unchanged, so coverage is too.
    use: { ...devices['iPhone 15'], deviceScaleFactor: DEVICE_SCALE_FACTOR },
    storageState: 'e2e/.auth/iphone-15/test-alice.json',
    testIgnore: DEVICE_TEST_IGNORE,
  },
  'pixel-7': {
    use: {
      ...devices['Pixel 7'],
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      launchOptions: chromiumLaunchOptions,
    },
    storageState: 'e2e/.auth/pixel-7/test-alice.json',
    testIgnore: DEVICE_TEST_IGNORE,
  },
  'ipad-pro': {
    use: { ...devices['iPad Pro 11'], deviceScaleFactor: DEVICE_SCALE_FACTOR },
    storageState: 'e2e/.auth/ipad-pro/test-alice.json',
    testIgnore: DEVICE_TEST_IGNORE,
  },
  // Admin SPA project: baseURL is adminUrl, the admin `vite preview` server
  // serving the e2e-mode admin build (not the dev server, not the web preview).
  // No storageState and no persona login — the SPA self-authenticates
  // via the dev-JWT mint (its fetch wrapper mints a dev Access JWT from GET
  // /api/dev/admin-token through the preview proxy), and API-level specs mint
  // their own JWT via the adminApi fixture. e2e/admin/** is excluded from every
  // browser-matrix project above, so admin specs run here only.
  admin: {
    use: {
      ...devices['Desktop Chrome'],
      deviceScaleFactor: DEVICE_SCALE_FACTOR,
      baseURL: adminUrl,
      launchOptions: chromiumLaunchOptions,
    },
    testDir: './e2e/admin',
  },
};

const isMatrixProject = (name: ProjectName): name is MatrixProject =>
  (BROWSER_MATRIX_PROJECTS as readonly string[]).includes(name);

/**
 * A project's `use` block carrying that identity. A project's setup project
 * takes the same address deliberately: its logins spend the windows that
 * project's own specs spend later. A settings block naming the header itself
 * still wins — the merge order is what leaves that door open.
 *
 * Worker slot 0, because this runs once per project at config evaluation and no
 * worker index exists yet: `test.info().parallelIndex` is readable only inside a
 * test or a test-scoped fixture. `e2e/fixtures.ts` overrides the
 * `extraHTTPHeaders` option per worker, so every context a test creates through
 * the suite's own `test` presents its own worker's address and this value is the
 * floor rather than the identity. A test root that does not extend those
 * fixtures — `e2e/auth.setup.ts`, which imports Playwright's `test` directly —
 * keeps slot 0 on every worker, so its persona logins all spend one window.
 * What makes that safe is a bound, not the phase order: each setup test clears
 * the auth rate limits immediately before its single login, so the logins
 * counted between two clears are at most the workers running that setup project
 * concurrently — well inside `loginIpRateLimit`'s per-window allowance at every
 * worker count this suite runs. Raising worker counts far enough, or giving a
 * setup test a second login, spends that one window instead.
 *
 * Reach: Playwright applies a project's context options as DEFAULTS to every
 * browser and request context created during a test, hand-built ones included,
 * so the suite's own context factories carry this without knowing about it. A
 * caller that passes `extraHTTPHeaders` itself opts out — the key is present,
 * so the default is not merged, and that context falls back to whatever address
 * the runtime injects.
 *
 * This partitions only the limiters keyed on the caller's address, and only for
 * callers that present this identity. Limiters keyed on a user, an email or a
 * token stay shared across projects and are still wiped for every identity by
 * the dev resets — the API's dev Redis-reset module enumerates exactly which,
 * and is the one place that list lives. A spec that presents a guest identity
 * instead takes it from the same registry-and-slot derivation
 * (`projectGuestIp`), out of a block this one cannot reach.
 * Do not read a project identity as isolation.
 */
const projectUse = (name: ProjectName): NonNullable<Project['use']> => {
  const { use } = PROJECT_SETTINGS[name];
  return {
    ...use,
    extraHTTPHeaders: { 'cf-connecting-ip': projectCallerIp(name, 0), ...use.extraHTTPHeaders },
  };
};

// One setup project per seeded project; each authenticates that project's
// personas (suffixed with the project name) to e2e/.auth/<project>/*.json.
// Naturally gated: setup runs only when its dependent project is in the run, so
// CI matrix jobs touch a single user pool. It deliberately does NOT take the
// project's storageState — it is what writes that file.
const setupProject = (name: E2EProjectName): Project => {
  const settings = PROJECT_SETTINGS[name];
  return {
    name: setupProjectName(name),
    testMatch: /auth\.setup\.ts/,
    use: projectUse(name),
    ...(settings.workers === undefined ? {} : { workers: settings.workers }),
  };
};

// One setup project per plane, drawn from the plane's own directory: it proves
// the plane's shared preconditions once, so the plane waits on it and runs
// beside the engine matrix. A project that waits on nothing runs in the setup
// phase instead, and one hung test there holds every browser project idle.
const planeSetupProject = (name: ProjectName): Project => {
  const settings = PROJECT_SETTINGS[name];
  return {
    name: setupProjectName(name),
    ...(settings.testDir === undefined ? {} : { testDir: settings.testDir }),
    testMatch: `${name}.setup.ts`,
    use: projectUse(name),
  };
};

// Per-project tag gating derived from each spec's declaration (see
// scripts/lib/playwright/browser-matrix.ts). `engine-any` specs land on ONE carrier chosen
// from the selection, so narrowing a run moves them rather than dropping them.
// Project `grepInvert` composes (AND) with the CLI `--grep-invert` the CI matrix
// passes for `@local-only`/`@webhook`, so the two gating mechanisms don't
// interfere. Matched against the tagged test title. Only the engine projects are
// routed: a plane's spec set is fixed by its testDir.
const testProject = (name: ProjectName): Project => {
  const settings = PROJECT_SETTINGS[name];
  return {
    name,
    use:
      settings.storageState === undefined
        ? projectUse(name)
        : { ...projectUse(name), storageState: settings.storageState },
    ...(settings.testDir === undefined ? {} : { testDir: settings.testDir }),
    ...(settings.testIgnore === undefined ? {} : { testIgnore: [...settings.testIgnore] }),
    ...(settings.workers === undefined ? {} : { workers: settings.workers }),
    dependencies: [setupProjectName(name)],
    ...(isMatrixProject(name) ? { grepInvert: computeProjectGrepInvert(name, runProjects) } : {}),
  };
};

export default defineConfig({
  // Which stack's env files the run loaded is demanded first, ahead of the
  // suite's own setup and so ahead of every destructive step in it. It is a
  // setup module rather than a check in this file's body because a load is not
  // a run: knip resolves this repo's entry points by loading this config, and a
  // refusal in the body took the whole unused-export gate down with it.
  globalSetup: ['./scripts/lib/playwright/require-e2e-stack.ts', './e2e/global-setup.ts'],
  globalTeardown: './e2e/global-teardown.ts',
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: isCI,
  retries: isCI ? 2 : 1,
  maxFailures: isCI ? 1 : 0,
  workers: WORKERS,
  // Staging only: the reporter copies what a failed or flaky test left into
  // the report directory at the end of the run. Off Linux, Playwright's default,
  // the repository's `test-results/`. Either way it is the directory
  // `scripts/e2e-clean.ts` clears before a run, which cannot be imported here:
  // it reaches a dependency whose types the root `tsconfig.json`, the project
  // that typechecks this file, does not declare.
  ...(ramPaths === undefined ? {} : { outputDir: ramPaths.testResults }),
  timeout: TIMEOUTS.LONG,
  // Backstop so a wedged run can't hang forever. Playwright aborts via its
  // normal shutdown, which group-kills each webServer — so it won't leak orphan
  // dev servers the way a hard Ctrl+C of a stuck run does. Sized above the
  // observed full local matrix (~46m); the multiplier is a fixed count of the
  // per-test budget, not runtime scaling. Raise the count if the matrix grows.
  globalTimeout: 75 * TIMEOUTS.LONG,
  expect: {
    timeout: TIMEOUTS.ASSERT,
  },
  reporter: isCI
    ? [['list'], ['github'], ['html', { open: 'never' }]]
    : [['list'], ['html', { open: 'on-failure' }], ['./scripts/e2e-reporter.ts']],
  use: {
    baseURL: previewUrl,
    // CI captures nothing (failures reproduce locally); local keeps what the
    // debug report consumes — trace, failure screenshot, HAR (in fixtures),
    // console/api/snapshot. Video is off everywhere: the report never reads it.
    trace: isCI ? 'off' : 'retain-on-first-failure',
    screenshot: isCI ? 'off' : 'only-on-failure',
    video: 'off',
    // Determinism: pin clock zone and locale so date/number/collation behaviour
    // is identical on every machine and in CI. Time itself is controlled
    // per-test via page.clock where a test depends on it.
    timezoneId: 'UTC',
    locale: 'en-US',
  },
  webServer: [
    {
      // Builds marketing + web, merges them, then serves a snapshot of the
      // result. The merged dist is exactly what Cloudflare Pages serves in
      // production (/chat, /roadmap, /welcome, /blog reachable from one origin),
      // so E2E covers the same routing as users see. The build is inside the
      // webServer command (not globalSetup) because Playwright completes
      // webServer setup — the spawn and the readiness wait both — before any
      // global-setup module runs, so a build placed there would start only
      // once this server was already expected to be serving the bundle. It
      // serves a snapshot so a build started during the run cannot wipe the
      // bundle out from under it (see
      // `scripts/lib/bundling/bundle-snapshot.ts`).
      command: `tsx scripts/e2e-preview.ts --app=web --port=${previewPort}${prebuiltFlag}`,
      url: previewUrl,
      reuseExistingServer: false,
      timeout: 300_000,
      name: 'Preview',
      stdout: 'ignore',
    },
    {
      // `e2e:prepare` (run before `playwright test`) brings up containers via
      // ensure-stack, runs migrations, then seeds the e2e personas. The
      // webServer just spawns the API Worker's launcher, scripts/wrangler-dev.ts.
      command: 'pnpm --filter @hushbox/api dev',
      url: apiHealthUrl(apiPort),
      reuseExistingServer: false,
      timeout: 180_000,
      name: 'API',
      stdout: 'ignore',
    },
    {
      // The admin SPA runs as a `vite preview` build (like web), so E2E covers
      // the same static bundle Cloudflare serves on admin.hushbox.ai. Its `/api`
      // proxy to the Worker is served by `preview.proxy` (vite.config.ts), and
      // dev-JWT self-auth mints through that proxy. It is keyed on its own build
      // lease, so an admin build and a web build never refuse each other.
      command: `tsx scripts/e2e-preview.ts --app=admin --port=${adminPort}${prebuiltFlag}`,
      url: adminUrl,
      reuseExistingServer: false,
      timeout: 300_000,
      name: 'Admin',
      stdout: 'ignore',
    },
    {
      // The document sandbox origin: an assets-only server (the local-parity
      // equivalent of the production Cloudflare assets Worker) serving the
      // renderer pages and pinned Pyodide assets under their real Content-
      // Security-Policy. The app embeds these pages in a sandboxed iframe, so
      // both the security-containment corpus and the document-flow suite need
      // the origin live and serving the deployed policy (not a permissive dev
      // server). `dev` serves the committed `public/` bundle; the Pyodide
      // assets are fetched into it by the CI `fetch-pyodide` step.
      command: `pnpm --filter @hushbox/sandbox dev`,
      url: `${sandboxUrl}/render.html`,
      reuseExistingServer: false,
      timeout: 120_000,
      name: 'Sandbox',
      stdout: 'ignore',
    },
  ],
  // The registry is the only statement of which projects exist; this array is
  // its four parts in ALL_PROJECT_NAMES order — every seeded project's setup
  // project, then every plane's, then the planes, then the engine matrix.
  projects: [
    ...E2E_PROJECT_NAMES.map((name) => setupProject(name)),
    ...PLANE_PROJECTS.map((name) => planeSetupProject(name)),
    ...PLANE_PROJECTS.map((name) => testProject(name)),
    ...BROWSER_MATRIX_PROJECTS.map((name) => testProject(name)),
  ],
});
