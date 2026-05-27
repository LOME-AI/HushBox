/* eslint-disable no-restricted-syntax -- mobile-test.ts is gated to Linux via assertLinux() and intentionally shells out to mkdir/curl/unzip/bash for one-shot SDK installation on the CI runner. */
import { execa } from 'execa';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { isMainModule } from './lib/is-main.js';
import { bakeImage, detectKvmGid, runEmulatorContainer } from './lib/mobile-image.js';
import { MARKER_PREFIX, extractRelevantSlice } from './lib/extract-mobile-api-log.js';
import { wranglerLogPath } from './wrangler-dev.js';
import { SHARDS } from '../mobile-tests/config.js';

const APK_PATH = 'apps/web/android/app/build/outputs/apk/debug/app-debug.apk';
const BOOT_TIMEOUT_POLLS = 120;
const BOOT_POLL_INTERVAL_MS = 2000;
const BOOT_DIAGNOSTIC_INTERVAL = 10;
const API_TIMEOUT_POLLS = 30;
const API_POLL_INTERVAL_MS = 1000;
const CONTAINER_NAME_PREFIX = 'hushbox-mobile-emulator-shard-';
const DEFAULT_BASE_ADB_PORT = 5555;
const FLOW_DIR = 'mobile-tests/flows';
const OTA_FLOW = 'mobile-tests/flows/13-ota-update.yaml';
const RESULTS_DIR = 'maestro-results';

function baseAdbPort(): number {
  // Honor HB_EMULATOR_ADB_PORT (set by scripts/generate-env per worktree slot)
  // so multiple worktrees can run mobile tests on disjoint port ranges. Each
  // worktree's base + 2*shard then spaces shards within the worktree.
  const fromEnv = process.env['HB_EMULATOR_ADB_PORT'];
  if (fromEnv === undefined) return DEFAULT_BASE_ADB_PORT;
  const parsed = Number(fromEnv);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_BASE_ADB_PORT;
}

export function parseArgs(args: string[]): { smoke: boolean } {
  return { smoke: args.includes('--smoke') };
}

/**
 * Each shard gets a distinct host ADB port. Emulators internally bind to
 * 5554 (console) and 5555 (adb); we map 5555 → 5555 + 2*shard so adjacent
 * shards don't collide and there's room for a per-shard console port if
 * needed in the future.
 */
export function adbPortForShard(shard: number): number {
  return baseAdbPort() + shard * 2;
}

export function containerNameForShard(shard: number): string {
  return `${CONTAINER_NAME_PREFIX}${String(shard)}`;
}

export function debugOutputForShard(shard: number): string {
  return path.join(RESULTS_DIR, `shard-${String(shard)}`);
}

/**
 * Mobile tests depend on KVM acceleration, Docker host networking, and
 * Linux-style filesystem paths used by the android-emulator service. Fail
 * fast on other platforms so the user gets a clear error instead of opaque
 * downstream failures.
 */
export function assertLinux(): void {
  if (process.platform !== 'linux') {
    throw new Error(
      `mobile-test is Linux-only (requires KVM and Docker host networking). Current platform: ${process.platform}.`
    );
  }
}

export async function checkPrerequisites(): Promise<void> {
  try {
    await execa('docker', ['info'], { stdio: 'ignore' });
  } catch {
    throw new Error('Docker is not running. Start Docker and try again.');
  }

  if (!existsSync('/dev/kvm')) {
    throw new Error('/dev/kvm not found. KVM is required for Android emulator acceleration.');
  }
}

export async function installMaestro(): Promise<void> {
  try {
    await execa('maestro', ['--version'], { stdio: 'ignore' });
    console.log('Maestro CLI found');
  } catch {
    console.log('Installing Maestro CLI...');
    await execa('bash', ['-c', 'curl -fsSL "https://get.maestro.mobile.dev" | bash'], {
      stdio: 'inherit',
    });
    const home = process.env['HOME'] ?? '';
    process.env['PATH'] = `${home}/.maestro/bin:${process.env['PATH'] ?? ''}`;
  }
}

const ANDROID_SDK_ROOT = `${process.env['HOME'] ?? ''}/Android/Sdk`;
const CMDLINE_TOOLS_URL =
  'https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip';
const REQUIRED_PLATFORM = 'android-36';

export async function installAndroidSdk(): Promise<void> {
  const androidHome = process.env['ANDROID_HOME'];
  if (androidHome && existsSync(`${androidHome}/platforms/${REQUIRED_PLATFORM}`)) {
    console.log('Android SDK found');
  } else if (existsSync(`${ANDROID_SDK_ROOT}/platforms/${REQUIRED_PLATFORM}`)) {
    process.env['ANDROID_HOME'] = ANDROID_SDK_ROOT;
    console.log('Android SDK found');
  } else {
    console.log('Installing Android SDK command-line tools...');
    await execa('mkdir', ['-p', `${ANDROID_SDK_ROOT}/cmdline-tools`]);
    // eslint-disable-next-line sonarjs/publicly-writable-directories -- /tmp is standard for CI SDK downloads
    await execa('curl', ['-fsSL', '-o', '/tmp/cmdline-tools.zip', CMDLINE_TOOLS_URL], {
      stdio: 'inherit',
    });
    await execa(
      'unzip',
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- /tmp is standard for CI SDK downloads
      ['-q', '-o', '/tmp/cmdline-tools.zip', '-d', `${ANDROID_SDK_ROOT}/cmdline-tools`],
      {
        stdio: 'inherit',
      }
    );
    await execa('mv', [
      `${ANDROID_SDK_ROOT}/cmdline-tools/cmdline-tools`,
      `${ANDROID_SDK_ROOT}/cmdline-tools/latest`,
    ]);

    process.env['ANDROID_HOME'] = ANDROID_SDK_ROOT;

    const sdkmanager = `${ANDROID_SDK_ROOT}/cmdline-tools/latest/bin/sdkmanager`;

    console.log('Accepting Android SDK licenses...');
    await execa('bash', ['-c', `yes | ${sdkmanager} --licenses`], { stdio: 'pipe' });

    console.log(`Installing platforms;${REQUIRED_PLATFORM}...`);
    await execa(sdkmanager, [`platforms;${REQUIRED_PLATFORM}`, 'platform-tools'], {
      stdio: 'inherit',
    });
  }

  const home = process.env['ANDROID_HOME'] ?? ANDROID_SDK_ROOT;
  process.env['PATH'] = `${home}/platform-tools:${process.env['PATH'] ?? ''}`;
}

function extractErrorDetail(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr ?? '';
  const shortMessage = (error as { shortMessage?: string }).shortMessage ?? '';
  return stderr || shortMessage || (error instanceof Error ? error.message : String(error));
}

async function disconnectStaleAdb(host: string): Promise<void> {
  await execa('adb', ['disconnect', host], { stdio: 'pipe' }).catch(() => {
    // Disconnect can fail if there's no entry to remove; that's fine.
  });
}

async function tryAdbConnect(host: string, index: number): Promise<boolean> {
  const connectResult = await execa('adb', ['connect', host], { stdio: 'pipe' });
  const connectOutput = connectResult.stdout.trim();
  // adb connect returns exit 0 even on failure with output like
  // "unable to connect", "failed to connect", or "device offline".
  // "device offline" happens when adb's local device table holds a stale
  // half-dead entry from a previous broken session — `adb disconnect`
  // clears it so the next iteration's connect attempt starts clean.
  const connectFailed =
    !connectOutput.includes('connected to') ||
    connectOutput.includes('unable') ||
    connectOutput.includes('offline');
  if (!connectFailed) {
    return true;
  }
  if (index % BOOT_DIAGNOSTIC_INTERVAL === 0) {
    console.log(`[poll ${String(index)}] adb connect ${host}: ${connectOutput}`);
  }
  if (connectOutput.includes('offline')) {
    await disconnectStaleAdb(host);
  }
  return false;
}

async function checkBootCompleted(
  host: string,
  index: number
): Promise<{ connected: boolean; booted: boolean }> {
  try {
    const result = await execa('adb', ['-s', host, 'shell', 'getprop', 'sys.boot_completed']);
    return { connected: true, booted: result.stdout.trim() === '1' };
  } catch (error: unknown) {
    const detail = extractErrorDetail(error);
    if (detail.includes('offline') || detail.includes('not found')) {
      if (index % BOOT_DIAGNOSTIC_INTERVAL === 0) {
        console.log(`[poll ${String(index)}] getprop ${host}: ${detail}`);
      }
      await disconnectStaleAdb(host);
      return { connected: false, booted: false };
    }
    return { connected: true, booted: false };
  }
}

async function pollEmulatorBoot(
  host: string,
  connected: boolean,
  index: number
): Promise<{ connected: boolean; booted: boolean }> {
  if (!connected) {
    const ok = await tryAdbConnect(host, index);
    if (!ok) return { connected: false, booted: false };
    console.log(`Connected to ${host}`);
  }
  return checkBootCompleted(host, index);
}

async function setupAdbReverse(host: string): Promise<void> {
  const apiPort = process.env['HB_API_PORT'] ?? '8787';
  console.log(`Setting up adb reverse for API port ${apiPort} on ${host}...`);
  await execa('adb', ['-s', host, 'reverse', `tcp:${apiPort}`, `tcp:${apiPort}`]);
}

export async function startEmulator(
  shard: number,
  imageTag: string,
  kvmGid: string
): Promise<void> {
  const host = `localhost:${String(adbPortForShard(shard))}`;
  console.log(`Starting Android emulator (shard ${String(shard)}) on ${host}...`);
  await runEmulatorContainer({
    name: containerNameForShard(shard),
    hostAdbPort: adbPortForShard(shard),
    imageTag,
    kvmGid,
    // Enables noVNC at port 6080 inside the container for live emulator
    // viewing — useful for debugging a hung test interactively.
    includeVnc: true,
    stdio: 'inherit',
  });

  let connected = false;
  console.log(`Waiting for emulator on ${host} to boot...`);
  for (let index = 0; index < BOOT_TIMEOUT_POLLS; index++) {
    try {
      const poll = await pollEmulatorBoot(host, connected, index);
      connected = poll.connected;
      if (poll.booted) {
        console.log(`Emulator booted on ${host}`);
        await setupAdbReverse(host);
        return;
      }
    } catch (error: unknown) {
      if (index % BOOT_DIAGNOSTIC_INTERVAL === 0) {
        const detail = extractErrorDetail(error);
        console.log(`[poll ${String(index)}] ${host} error: ${detail}`);
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, BOOT_POLL_INTERVAL_MS);
    });
  }
  throw new Error(`Emulator on ${host} failed to boot within timeout`);
}

export async function startEmulators(n: number, imageTag: string): Promise<void> {
  const kvmGid = await detectKvmGid();
  await Promise.all(
    Array.from({ length: n }, (_, shard) => startEmulator(shard, imageTag, kvmGid))
  );
}

export async function stopEmulator(shard: number): Promise<void> {
  const name = containerNameForShard(shard);
  console.log(`Stopping emulator shard ${String(shard)} (${name})...`);
  try {
    await execa('docker', ['rm', '-f', name], { stdio: 'inherit' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to stop emulator ${name}: ${message}`);
  }
}

export async function stopEmulators(n: number): Promise<void> {
  await Promise.all(Array.from({ length: n }, (_, shard) => stopEmulator(shard)));
}

/**
 * Tracks dev-stack resources WE started, so cleanup can selectively tear
 * down only what's ours. If startDevStack reuses an already-running API
 * (curl health check succeeds), both fields stay null/false and stopDevStack
 * is a no-op — we never touch resources we didn't start.
 */
export interface DevStackHandle {
  /** Wrangler dev subprocess we spawned; null when we reused a running API. */
  apiProcess: ReturnType<typeof execa> | null;
  /** True when we ran `pnpm db:up` (and therefore should run `pnpm db:down`). */
  weStartedContainers: boolean;
}

const EMPTY_DEV_STACK_HANDLE: DevStackHandle = {
  apiProcess: null,
  weStartedContainers: false,
};

async function pollApiReady(apiPort: string): Promise<boolean> {
  try {
    await execa('curl', ['-sf', `http://localhost:${apiPort}/api/health`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export async function startDevStack(): Promise<DevStackHandle> {
  const apiPort = process.env['HB_API_PORT'] ?? '8787';

  if (await pollApiReady(apiPort)) {
    console.log('API server already running — reusing existing dev stack (will not tear down)');
    // Idempotent upsert; cheap to repeat and protects against stale state
    // (e.g. a DEV_PASSWORD change since the reused API was last seeded).
    await execa('pnpm', ['db:seed'], { stdio: 'inherit', env: process.env });
    return EMPTY_DEV_STACK_HANDLE;
  }

  console.log('Starting dev stack...');
  let weStartedContainers = false;
  let apiProcess: ReturnType<typeof execa> | null = null;
  try {
    await execa('pnpm', ['db:up'], { stdio: 'inherit', env: process.env });
    // db:up succeeded (or partially started containers) — we own teardown
    // from this point forward, even if a later step fails.
    weStartedContainers = true;
    await execa('pnpm', ['db:migrate'], { stdio: 'inherit', env: process.env });
    await execa('pnpm', ['db:seed'], { stdio: 'inherit', env: process.env });

    apiProcess = execa('pnpm', ['--filter', '@hushbox/api', 'dev'], {
      stdio: 'ignore',
      env: process.env,
    });
    // eslint-disable-next-line promise/prefer-await-to-then, @typescript-eslint/no-empty-function -- fire-and-forget subprocess; explicit kill happens via stopDevStack
    apiProcess.catch(() => {});
    // unref so the parent's event loop can exit without waiting on the API.
    // The explicit kill in stopDevStack handles graceful shutdown on the
    // normal exit path; execa's default cleanup (forceKillAfterDelay) covers
    // crash paths where finally doesn't run.
    apiProcess.unref();

    console.log('Waiting for API server...');
    for (let index = 0; index < API_TIMEOUT_POLLS; index++) {
      if (await pollApiReady(apiPort)) {
        console.log('API server ready');
        return { apiProcess, weStartedContainers };
      }
      await new Promise((resolve) => {
        setTimeout(resolve, API_POLL_INTERVAL_MS);
      });
    }
    throw new Error('API server failed to start within timeout');
  } catch (error) {
    // Partial start: tear down what we created so the failure doesn't leak
    // containers or a wrangler subprocess. Then rethrow.
    await stopDevStack({ apiProcess, weStartedContainers });
    throw error;
  }
}

/**
 * Tear down whatever WE started in this run. Resources we found already
 * running (handle fields null/false) are left untouched — explicitly so we
 * don't kill a sibling `pnpm dev` session.
 *
 * Best-effort: subprocess kill / container teardown failures are logged,
 * not thrown, so a partial-cleanup hiccup doesn't mask the original error
 * that triggered the cleanup.
 */
async function bestEffort(label: string, action: () => unknown): Promise<void> {
  try {
    await action();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`${label}: ${message}`);
  }
}

export async function stopDevStack(handle: DevStackHandle): Promise<void> {
  if (handle.apiProcess) {
    console.log('Stopping API server we started...');
    // execa's .kill() is OS-agnostic: SIGTERM on POSIX, equivalent on
    // Windows via TerminateProcess. forceKillAfterDelay (5s) handles
    // children that ignore SIGTERM.
    await bestEffort('Failed to stop API server', () => handle.apiProcess?.kill());
  }
  if (handle.weStartedContainers) {
    console.log('Tearing down dev stack containers we started...');
    await bestEffort('Failed to tear down dev stack', () =>
      execa('pnpm', ['db:down'], { stdio: 'inherit', env: process.env })
    );
  }
}

const GOOGLE_SERVICES_PATH = 'apps/web/android/app/google-services.json';
export const APK_APP_VERSION = 'local-mobile-test';
export const API_SLICE_PATH = path.join(RESULTS_DIR, 'api-during-mobile-test.log');
const FAILURE_TAIL_LINES = 200;

/**
 * Brackets a block of maestro work with START/END markers in the wrangler dev
 * log. scripts/lib/extract-mobile-api-log.ts uses those markers (combined
 * with the X-App-Version filter) to slice out the API activity that belongs
 * to *this* run when the API is shared with sibling sessions.
 */
export async function withMobileTestRun<T>(runId: string, body: () => Promise<T>): Promise<T> {
  const apiPort = process.env['HB_API_PORT'] ?? '8787';
  const logPath = wranglerLogPath(apiPort);
  appendFileSync(logPath, `${MARKER_PREFIX} ${runId} START ${new Date().toISOString()} =====\n`);
  try {
    return await body();
  } finally {
    appendFileSync(logPath, `${MARKER_PREFIX} ${runId} END ${new Date().toISOString()} =====\n`);
  }
}

/**
 * Reads the raw wrangler log, slices out the section belonging to `runId`
 * (filtered to APK traffic only via X-App-Version), and writes the slice to
 * maestro-results/api-during-mobile-test.log — the post-hoc debug artifact.
 *
 * Assumes RESULTS_DIR exists; main() creates it before any work begins.
 */
export function writeApiSlice(runId: string): void {
  const apiPort = process.env['HB_API_PORT'] ?? '8787';
  const rawLog = readFileSync(wranglerLogPath(apiPort), 'utf8');
  const slice = extractRelevantSlice({
    rawLog,
    runId,
    mobileVersion: APK_APP_VERSION,
  });
  writeFileSync(API_SLICE_PATH, slice);
}

/**
 * Echoes the tail of the slice file to stdout on failure so CI step output
 * shows the API-side context without requiring the artifact download. Mirrors
 * the post-mortem logcat dump pattern used by runMaestroOta() for OTA flows.
 */
export function dumpApiLogTail(tailLines: number = FAILURE_TAIL_LINES): void {
  const content = readFileSync(API_SLICE_PATH, 'utf8');
  if (content.length === 0) {
    process.stdout.write('\n=== API log slice is empty ===\n');
    return;
  }
  const lines = content.split('\n');
  const tailStart = Math.max(0, lines.length - tailLines);
  const tail = lines.slice(tailStart).join('\n');
  const shown = lines.length - tailStart;
  process.stdout.write(`\n=== last ${String(shown)} lines of API log ===\n`);
  process.stdout.write(tail);
  process.stdout.write('\n=== end of API log tail ===\n');
}

export async function buildApk(): Promise<void> {
  const apiUrl = process.env['API_URL'];
  if (!apiUrl) throw new Error('API_URL not set. Ensure the script is run via with-env.');
  const frontendUrl = process.env['FRONTEND_URL'];
  if (!frontendUrl) throw new Error('FRONTEND_URL not set. Ensure the script is run via with-env.');

  if (!existsSync(GOOGLE_SERVICES_PATH)) {
    const googleServicesB64 = process.env['GOOGLE_SERVICES_JSON_BASE64'];
    if (!googleServicesB64) {
      throw new Error(
        'GOOGLE_SERVICES_JSON_BASE64 not set and google-services.json not found. Run pnpm generate:env.'
      );
    }
    console.log('Writing google-services.json from GOOGLE_SERVICES_JSON_BASE64...');
    writeFileSync(GOOGLE_SERVICES_PATH, Buffer.from(googleServicesB64, 'base64').toString('utf8'));
  }

  console.log('Building web for mobile...');
  await execa('pnpm', ['--filter', 'web', 'build'], {
    stdio: 'inherit',
    env: {
      ...process.env,
      TURBO_FORCE: 'true',
      VITE_API_URL: apiUrl,
      VITE_PLATFORM: 'android-direct',
      VITE_APP_VERSION: APK_APP_VERSION,
      VITE_OPAQUE_SERVER_ID: new URL(frontendUrl).host,
    },
  });

  console.log('Syncing Capacitor...');
  await execa('npx', ['cap', 'sync', 'android'], {
    stdio: 'inherit',
    cwd: 'apps/web',
    env: process.env,
  });

  console.log('Building debug APK...');
  const gradlew = ['.', 'gradlew'].join('/');
  // `clean` is required: every run produces freshly content-hashed web assets, and AGP's
  // incremental mergeDebugAssets retains the prior build's now-deleted files. compressDebugAssets
  // then fails trying to overwrite their existing per-asset .jar ("already contains entry").
  await execa(gradlew, ['clean', 'assembleDebug'], {
    stdio: 'inherit',
    cwd: 'apps/web/android',
    env: {
      ...process.env,
      VERSION_CODE: '1',
      VERSION_NAME: 'local-mobile-test',
      ANDROID_KEYSTORE_PATH: 'debug.keystore',
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Android debug keystore uses well-known values
      ANDROID_KEYSTORE_PASSWORD: 'debug',
      ANDROID_KEY_ALIAS: 'debug',
      // eslint-disable-next-line sonarjs/no-hardcoded-passwords -- Android debug keystore uses well-known values
      ANDROID_KEY_PASSWORD: 'debug',
    },
  });
}

export async function installApk(shard: number): Promise<void> {
  const host = `localhost:${String(adbPortForShard(shard))}`;
  console.log(`Installing APK on ${host}...`);
  await execa('adb', ['-s', host, 'install', '-r', APK_PATH], { stdio: 'inherit' });
}

export async function installApks(n: number): Promise<void> {
  await Promise.all(Array.from({ length: n }, (_, shard) => installApk(shard)));
}

/**
 * Reset the dev API's in-memory version override to match the APK we built.
 * See setupOtaUpdate() — without this reset, a stale override from a prior
 * run causes every authenticated request from the freshly built APK to
 * fail with 426 Upgrade Required.
 */
export async function resetVersionOverride(): Promise<void> {
  const apiPort = process.env['HB_API_PORT'] ?? '8787';
  console.log(`Resetting dev version override to ${APK_APP_VERSION}...`);
  const res = await fetch(`http://localhost:${apiPort}/api/dev/set-version`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: APK_APP_VERSION }),
  });
  if (!res.ok) {
    throw new Error(`Failed to reset version override: HTTP ${String(res.status)}`);
  }
}

export async function configureAppLinks(shard: number): Promise<void> {
  const host = `localhost:${String(adbPortForShard(shard))}`;
  console.log(`Configuring app link verification on ${host}...`);
  await execa(
    'adb',
    [
      '-s',
      host,
      'shell',
      'pm',
      'set-app-links-allowed',
      '--package',
      'ai.hushbox.app',
      '--user',
      '0',
      'true',
    ],
    { stdio: 'inherit' }
  );
  console.log(`Disabling Chrome on ${host} so deep links route to app...`);
  await execa(
    'adb',
    ['-s', host, 'shell', 'pm', 'disable-user', '--user', '0', 'com.android.chrome'],
    { stdio: 'inherit' }
  );
}

export async function configureAllAppLinks(n: number): Promise<void> {
  await Promise.all(Array.from({ length: n }, (_, shard) => configureAppLinks(shard)));
}

/**
 * Per-character cost of an `inputText` step relative to one Maestro step.
 * Typing into the Capacitor WebView runs ~10s/char on docker-android (Maestro
 * #2718 — see 10-core-user-flow.yaml), so a typed character costs more wall-
 * clock than a typical step. This is the single global dial for how heavily
 * typing counts toward shard balance; it is not per-flow bookkeeping.
 */
export const INPUT_CHAR_WEIGHT = 2;

function stripQuotes(value: string): string {
  return value.replaceAll(/^['"]|['"]$/g, '');
}

/**
 * Resolve the typed length of an `inputText` value. `${VAR}` references resolve
 * against the flow's own declarations (e.g. `${TEST_USERNAME}` → "tmu") so the
 * count reflects what's actually typed, not the placeholder. An unresolved var
 * falls back to the token's own length.
 */
function resolveInputLength(raw: string, content: string): number {
  const variableName = /^\$\{(\w+)\}$/.exec(raw)?.[1];
  if (variableName !== undefined) {
    const decl = new RegExp(String.raw`^\s*${variableName}:\s*(.+)$`, 'm').exec(content);
    if (decl?.[1] !== undefined) return stripQuotes(decl[1].trim()).length;
    return raw.length;
  }
  return stripQuotes(raw).length;
}

/**
 * Approximate execution cost of a flow, derived entirely from its YAML: the
 * number of steps plus a per-character penalty for `inputText` typing. Adding
 * or editing a flow reweights it automatically — no maintained timing table.
 */
export function flowWeight(content: string): number {
  const separatorIndex = content.search(/^---\s*$/m);
  const body = separatorIndex === -1 ? '' : content.slice(separatorIndex);
  const stepCount = (body.match(/^-\s/gm) ?? []).length;

  let inputChars = 0;
  const inputRegex = /^-\s+inputText:\s*(.+)$/gm;
  let match = inputRegex.exec(body);
  while (match !== null) {
    if (match[1] !== undefined) inputChars += resolveInputLength(match[1].trim(), content);
    match = inputRegex.exec(body);
  }
  return stepCount + inputChars * INPUT_CHAR_WEIGHT;
}

/** Read each flow file and compute its weight. Pure I/O over flowWeight. */
function weighFlows(flows: string[]): Map<string, number> {
  const weights = new Map<string, number>();
  for (const flow of flows) {
    weights.set(flow, flowWeight(readFileSync(flow, 'utf8')));
  }
  return weights;
}

/** Index of the least-loaded shard that still has count capacity. */
function leastLoadedWithCapacity(buckets: string[][], loads: number[], caps: number[]): number {
  let target = -1;
  for (const [index, bucket] of buckets.entries()) {
    if (bucket.length >= (caps[index] ?? 0)) continue;
    if (target === -1 || (loads[index] ?? 0) < (loads[target] ?? 0)) target = index;
  }
  return target;
}

/**
 * Split flows across n shards so each shard runs a near-equal number of flows
 * (counts differ by at most 1) while keeping total weight per shard as even as
 * possible. Flows are placed heaviest-first onto the least-loaded shard that
 * still has count capacity (count-constrained Longest-Processing-Time). This
 * keeps wall-clock balanced when a few flows dominate; a plain round-robin by
 * filename could pile the two slowest flows onto one shard.
 */
export function partitionByWeight(
  flows: string[],
  n: number,
  weightOf: (flow: string) => number
): string[][] {
  const buckets: string[][] = Array.from({ length: n }, () => []);
  const loads = Array.from({ length: n }, () => 0);
  const caps = Array.from(
    { length: n },
    (_, index) => Math.floor(flows.length / n) + (index < flows.length % n ? 1 : 0)
  );
  const ordered = flows.toSorted((a, b) => weightOf(b) - weightOf(a) || a.localeCompare(b));
  for (const flow of ordered) {
    const target = leastLoadedWithCapacity(buckets, loads, caps);
    buckets[target]?.push(flow);
    loads[target] = (loads[target] ?? 0) + weightOf(flow);
  }
  return buckets;
}

export function smokeFlows(): string[] {
  return [
    `${FLOW_DIR}/01-app-launch.yaml`,
    `${FLOW_DIR}/02-splash-screen.yaml`,
    `${FLOW_DIR}/03-webview-renders.yaml`,
  ];
}

export function fullFlowsExcludingOta(): string[] {
  return readdirSync(FLOW_DIR)
    .filter((f) => f.endsWith('.yaml') && f !== path.basename(OTA_FLOW))
    .toSorted((a, b) => a.localeCompare(b))
    .map((f) => `${FLOW_DIR}/${f}`);
}

/* eslint-disable sonarjs/no-selector-parameter -- smoke is the user-facing CLI flag plumbed from parseArgs through main; splitting the caller would just move the same boolean selection one layer up */
export function listFlowsForRun(smoke: boolean): string[] {
  return smoke ? smokeFlows() : fullFlowsExcludingOta();
}
/* eslint-enable sonarjs/no-selector-parameter */

async function prepareAdbServer(n: number): Promise<void> {
  const apiPort = process.env['HB_API_PORT'] ?? '8787';
  // The adb server auto-discovers emulator ports (5554-5682) and creates
  // ghost "emulator-XXXX offline" entries that crash Maestro's dadb.
  // ADB_LOCAL_TRANSPORT_MAX_PORT=0 prevents the scan entirely.
  console.log('Restarting adb server without emulator port scanning...');
  await execa('adb', ['kill-server']).catch(() => {
    // Ignored: kill-server fails if adb is not running.
  });
  await execa('adb', ['start-server'], {
    env: { ...process.env, ADB_LOCAL_TRANSPORT_MAX_PORT: '0' },
  });
  for (let shard = 0; shard < n; shard++) {
    const host = `localhost:${String(adbPortForShard(shard))}`;
    await execa('adb', ['connect', host]);
    await execa('adb', ['-s', host, 'wait-for-device']);
    console.log(`Re-establishing adb reverse for API port ${apiPort} on ${host}...`);
    await execa('adb', ['-s', host, 'reverse', `tcp:${apiPort}`, `tcp:${apiPort}`]);
  }
}

export interface ShardResult {
  shard: number;
  exitCode: number;
  stdout: string;
}

async function runMaestroOnShard(shard: number, flows: string[]): Promise<ShardResult> {
  if (flows.length === 0) {
    return { shard, exitCode: 0, stdout: '' };
  }
  const host = `localhost:${String(adbPortForShard(shard))}`;
  const debugDir = debugOutputForShard(shard);
  mkdirSync(debugDir, { recursive: true });
  const args = [
    'test',
    '--device',
    host,
    '--debug-output',
    debugDir,
    '--flatten-debug-output',
    ...flows,
  ];
  console.log(`[shard ${String(shard)}] maestro test on ${host} (${String(flows.length)} flows)`);
  const result = await execa('maestro', args, {
    stdout: ['pipe', 'inherit'],
    stderr: 'inherit',
    reject: false,
  });
  return {
    shard,
    exitCode: typeof result.exitCode === 'number' ? result.exitCode : 1,
    stdout: result.stdout,
  };
}

export async function runMaestroShards(smoke: boolean, n: number): Promise<void> {
  await prepareAdbServer(n);

  const flows = listFlowsForRun(smoke);
  const weights = weighFlows(flows);
  const partitions = partitionByWeight(flows, n, (flow) => weights.get(flow) ?? 0);

  console.log(`Running Maestro tests${smoke ? ' (smoke)' : ''} across ${String(n)} shard(s)...`);
  const results = await Promise.all(
    partitions.map((part, shard) => runMaestroOnShard(shard, part))
  );

  const allPassed = results.every((r) => r.exitCode === 0);
  if (allPassed) return;

  // Collect failures across all shards. Each shard's stdout is parsed
  // independently; failed flow names map back to YAML paths the same way as
  // the single-shard implementation.
  const failedPaths = results.flatMap((r) => getFailedFlowPaths(r.stdout));
  if (failedPaths.length === 0) {
    // Some shard failed without identifying flows (e.g., maestro itself
    // crashed). Fail without retry rather than re-running everything.
    throw new Error('Maestro tests failed without identifiable flow failures');
  }

  console.log(`\nRetrying ${String(failedPaths.length)} failed flow(s) on shard 0...`);
  const retryHost = `localhost:${String(adbPortForShard(0))}`;
  // Per-shard maestro processes can disturb the host adb server's device
  // table on exit (maestro#2167 — multi-device + non-default-port mode),
  // surfacing as "Device localhost:PORT not connected" on retry. Re-attach
  // before invoking the retry; `adb connect` is idempotent on an already-
  // connected device, so this is safe in the happy path too.
  await execa('adb', ['connect', retryHost]);
  await execa('adb', ['-s', retryHost, 'wait-for-device']);
  await execa(
    'maestro',
    [
      'test',
      '--device',
      retryHost,
      '--debug-output',
      debugOutputForShard(0),
      '--flatten-debug-output',
      ...failedPaths,
    ],
    { stdio: 'inherit' }
  );
}

/** Parse `[Failed] Flow Name (Xs)` lines from maestro output. */
export function parseFailedFlowNames(output: string): string[] {
  const failed: string[] = [];
  const regex = /\[Failed\]\s+(.+?)\s+\([\dm\s]+s\)/g;
  let match = regex.exec(output);
  while (match !== null) {
    if (match[1] !== undefined) failed.push(match[1].trim());
    match = regex.exec(output);
  }
  return failed;
}

/** Map failed flow display names back to their YAML file paths. */
function getFailedFlowPaths(output: string): string[] {
  const failedNames = parseFailedFlowNames(output);
  if (failedNames.length === 0) return [];

  const nameToPath = new Map<string, string>();
  for (const file of readdirSync(FLOW_DIR).filter((f) => f.endsWith('.yaml'))) {
    const content = readFileSync(path.join(FLOW_DIR, file), 'utf8');
    const nameMatch = /^name:\s*(.+)$/m.exec(content);
    if (nameMatch?.[1]) {
      nameToPath.set(nameMatch[1].trim(), path.join(FLOW_DIR, file));
    }
  }

  return failedNames
    .map((name) => nameToPath.get(name))
    .filter((p): p is string => p !== undefined);
}

const OTA_VERSION = 'ota-v2';

/**
 * Builds an OTA bundle, uploads to local R2, and sets the version override.
 * Uses the same codepaths as production (wrangler R2, /api/dev/set-version).
 */
export async function setupOtaUpdate(): Promise<void> {
  const apiUrl = process.env['API_URL'] ?? 'http://localhost:8787';
  const apiPort = process.env['HB_API_PORT'] ?? '8787';

  console.log('Building OTA bundle...');
  await execa('pnpm', ['exec', 'vite', 'build', '--outDir', 'dist-ota'], {
    cwd: 'apps/web',
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_APP_VERSION: OTA_VERSION,
      VITE_PLATFORM: 'android-direct',
      VITE_API_URL: apiUrl,
    },
  });

  console.log('Uploading OTA bundle to local R2...');
  const zipPath = 'ota-bundle.zip';
  await execa('zip', ['-r', zipPath, '.'], { cwd: 'apps/web/dist-ota', stdio: 'inherit' });
  await execa(
    'pnpm',
    [
      'exec',
      'wrangler',
      'r2',
      'object',
      'put',
      `hushbox-app-builds/builds/android-direct/${OTA_VERSION}.zip`,
      '--file',
      `../web/dist-ota/${zipPath}`,
    ],
    { cwd: 'apps/api', stdio: 'inherit' }
  );

  console.log('Setting version override...');
  const res = await fetch(`http://localhost:${apiPort}/api/dev/set-version`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version: OTA_VERSION }),
  });
  if (!res.ok) {
    throw new Error('Failed to set version override');
  }
  console.log(`Version override set to ${OTA_VERSION}`);
}

export async function runMaestroOta(): Promise<void> {
  // Run OTA on shard 0; it mutates global server state, so single-device is
  // correct (no parallelism benefit, and concurrent runs would conflict).
  const host = `localhost:${String(adbPortForShard(0))}`;
  const debugDir = path.join(RESULTS_DIR, 'ota');
  mkdirSync(debugDir, { recursive: true });
  console.log(`Running OTA update Maestro flow on ${host}...`);
  try {
    await execa(
      'maestro',
      ['test', '--device', host, '--debug-output', debugDir, '--flatten-debug-output', OTA_FLOW],
      { stdio: 'inherit' }
    );
  } catch (error: unknown) {
    // Maestro's --debug-output captures the failure screenshot, UI hierarchy, and
    // logs — a far cleaner source of truth than a raw Capacitor/CapgoUpdater logcat dump.
    console.log(`\nOTA flow failed. Maestro debug artifacts (screenshot + hierarchy): ${debugDir}`);
    throw error;
  }
}

export async function main(): Promise<void> {
  assertLinux();
  const { smoke } = parseArgs(process.argv.slice(2));
  const n = SHARDS;

  await checkPrerequisites();
  await Promise.all([installMaestro(), installAndroidSdk()]);

  // Resolve the image tag up front so we have a single source of truth across
  // all shards. bakeImage handles local-cache / registry-pull / full-bake
  // automatically; in CI on main this image was already pushed by the
  // push-mobile-emulator-image job, so this is a pull. On PRs and local dev
  // it may be a full bake (one-time cost per Dockerfile change).
  const imageTag = await bakeImage({ push: false });

  // Start the dev stack first (sequential) so its handle is captured before
  // any later failure could short-circuit cleanup. The cost is ~30s in the
  // cold case (fresh db:up + API ready-poll); near-zero when reusing an
  // already-running API. The parallel speedup that mattered (emulator boot
  // vs APK build) is preserved below.
  const devStack = await startDevStack();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = randomUUID().slice(0, 8);
  try {
    await Promise.all([startEmulators(n, imageTag), buildApk()]);
    await installApks(n);
    await configureAllAppLinks(n);
    await resetVersionOverride();

    let maestroFailed = false;
    try {
      await withMobileTestRun(runId, async () => {
        await runMaestroShards(smoke, n);
        if (!smoke) {
          await setupOtaUpdate();
          await runMaestroOta();
        }
      });
    } catch (error) {
      maestroFailed = true;
      throw error;
    } finally {
      // Write the bounded slice regardless of outcome; on failure also echo
      // the tail to stdout for fast CI/local triage.
      try {
        writeApiSlice(runId);
        if (maestroFailed) dumpApiLogTail();
      } catch (writeError: unknown) {
        const message = writeError instanceof Error ? writeError.message : String(writeError);
        console.error(`Failed to write API slice: ${message}`);
      }
    }

    console.log('Mobile tests complete!');
  } finally {
    await stopEmulators(n);
    await stopDevStack(devStack);
  }
}

/* v8 ignore start */
const isMain = isMainModule(import.meta.url);
if (isMain) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      console.error('Mobile test failed:', error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
