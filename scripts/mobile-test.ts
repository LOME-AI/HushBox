/* eslint-disable no-restricted-syntax -- mobile-test.ts is gated to Linux via assertLinux() and intentionally shells out to mkdir/curl/unzip/bash for one-shot SDK installation on the CI runner. */
import AdmZip from 'adm-zip';
import { execa } from 'execa';
import {
  appendFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appBundleOptions, verifyBundle } from './verify-bundle.js';
import { withBuildLease } from './lib/bundling/lease.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { removeEmulatorContainer } from './lib/mobile/emulator-container.js';
import {
  CMDLINE_TOOLS_ARCHIVE,
  MAESTRO_ARCHIVE,
  MAESTRO_VERSION,
  verifyArchive,
} from './lib/mobile/pinned-archives.js';
import { documentSeedPayload } from './lib/mobile/document-seed.js';
import {
  FLOW_DIR,
  OTA_FLOW,
  listFlowsForRun,
  partitionByWeight,
  weighFlows,
} from './lib/mobile/flows.js';
import {
  WITH_ENV_HINT,
  requireApiPort,
  requireEnv,
  requireSandboxPort,
} from './lib/mobile/required-env.js';
import {
  RESULTS_DIR,
  adbPortForShard,
  containerNameForShard,
  debugOutputForShard,
} from './lib/mobile/shards.js';
import { bakeImage, detectKvmGid, runEmulatorContainer } from './lib/mobile/mobile-image.js';
import { MARKER_PREFIX, readRunApiSlice } from './lib/mobile/extract-mobile-api-log.js';
import { apiHealthUrl } from './lib/playwright/api-health.js';
import { wranglerDebugLogPath, wranglerLogPath } from './wrangler-dev.js';
import { r2PutArgs } from './lib/wrangler/r2.js';
import { spawnLongLived, type LongLivedChild } from './lib/spawn/long-lived.js';
import { stackModeFrom } from './with-env.js';
import { SHARDS } from '../mobile-tests/config.js';

const APK_PATH = 'apps/web/android/app/build/outputs/apk/debug/app-debug.apk';
const WEB_APP_DIR = 'apps/web';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Cold boot on budtmo/docker-android (no quick-boot snapshot baked in) takes
// 30-60 s on a quiet host. On the Blacksmith 4-vCPU runner with two emulator
// containers KVM-accelerating in parallel against a contended CPU, observed
// boots have reached ~5 minutes. 600 s = 10 min leaves enough headroom that
// the timeout fires on a genuinely-wedged emulator, not on a slow-but-healthy
// one. Drop back down once a snapshot-baking path is back in service.
const BOOT_TIMEOUT_POLLS = 300;
const BOOT_POLL_INTERVAL_MS = 2000;
const BOOT_DIAGNOSTIC_INTERVAL = 10;
const API_TIMEOUT_POLLS = 30;
const API_POLL_INTERVAL_MS = 1000;
const SANDBOX_TIMEOUT_POLLS = 30;
const SANDBOX_POLL_INTERVAL_MS = 1000;

export const COMMAND_LINE = {
  command: 'pnpm mobile:test',
  summary: 'Runs the Maestro flows against Android emulators.',
  flags: [{ flag: '--smoke', kind: 'boolean', summary: 'Run the short flow set only.' }],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

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

/**
 * Installs the pinned Maestro release into a directory named by its version, so
 * a `maestro` of another version on PATH, or one the vendor installer left in
 * `~/.maestro/bin`, is never what the flows run under. The tree lands by one
 * rename after its archive verified, so a present binary is a complete install.
 */
export async function installMaestro(): Promise<void> {
  const maestroHome = path.join(requireEnv('HOME'), '.maestro', MAESTRO_VERSION);
  const binDir = path.join(maestroHome, 'bin');
  if (existsSync(path.join(binDir, 'maestro'))) {
    console.log(`Maestro CLI ${MAESTRO_VERSION} found`);
  } else {
    console.log(`Installing Maestro CLI ${MAESTRO_VERSION}...`);
    const staging = `${maestroHome}.partial`;
    const archive = path.join(staging, 'maestro.zip');
    await execa('rm', ['-rf', staging, maestroHome]);
    await execa('mkdir', ['-p', staging]);
    await execa('curl', ['-fsSL', '-o', archive, MAESTRO_ARCHIVE.url], { stdio: 'inherit' });
    verifyArchive(archive, MAESTRO_ARCHIVE);
    await execa('unzip', ['-q', archive, '-d', staging], { stdio: 'inherit' });
    await execa('mv', [path.join(staging, 'maestro'), maestroHome]);
    await execa('rm', ['-rf', staging]);
  }
  process.env['PATH'] = `${binDir}${path.delimiter}${requireEnv('PATH')}`;
}

function androidSdkRoot(): string {
  return `${requireEnv('HOME')}/Android/Sdk`;
}

const REQUIRED_PLATFORM = 'android-36';

export async function installAndroidSdk(): Promise<void> {
  const androidHome = process.env['ANDROID_HOME'];
  let home: string;
  if (androidHome && existsSync(`${androidHome}/platforms/${REQUIRED_PLATFORM}`)) {
    home = androidHome;
    console.log('Android SDK found');
  } else {
    const sdkRoot = androidSdkRoot();
    if (existsSync(`${sdkRoot}/platforms/${REQUIRED_PLATFORM}`)) {
      console.log('Android SDK found');
    } else {
      console.log('Installing Android SDK command-line tools...');
      await execa('mkdir', ['-p', `${sdkRoot}/cmdline-tools`]);
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- /tmp is standard for CI SDK downloads
      await execa('curl', ['-fsSL', '-o', '/tmp/cmdline-tools.zip', CMDLINE_TOOLS_ARCHIVE.url], {
        stdio: 'inherit',
      });
      // eslint-disable-next-line sonarjs/publicly-writable-directories -- /tmp is standard for CI SDK downloads
      verifyArchive('/tmp/cmdline-tools.zip', CMDLINE_TOOLS_ARCHIVE);
      await execa(
        'unzip',
        // eslint-disable-next-line sonarjs/publicly-writable-directories -- /tmp is standard for CI SDK downloads
        ['-q', '-o', '/tmp/cmdline-tools.zip', '-d', `${sdkRoot}/cmdline-tools`],
        {
          stdio: 'inherit',
        }
      );
      await execa('mv', [
        `${sdkRoot}/cmdline-tools/cmdline-tools`,
        `${sdkRoot}/cmdline-tools/latest`,
      ]);

      const sdkmanager = `${sdkRoot}/cmdline-tools/latest/bin/sdkmanager`;

      console.log('Accepting Android SDK licenses...');
      await execa('bash', ['-c', `yes | ${sdkmanager} --licenses`], { stdio: 'pipe' });

      console.log(`Installing platforms;${REQUIRED_PLATFORM}...`);
      await execa(sdkmanager, [`platforms;${REQUIRED_PLATFORM}`, 'platform-tools'], {
        stdio: 'inherit',
      });
    }
    process.env['ANDROID_HOME'] = sdkRoot;
    home = sdkRoot;
  }

  process.env['PATH'] = `${home}/platform-tools:${requireEnv('PATH')}`;
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

async function probeBootProperty(host: string, property: string, index: number): Promise<boolean> {
  const result = await execa('adb', ['-s', host, 'shell', 'getprop', property]);
  if (result.stdout.trim() === '1') return true;
  if (index % BOOT_DIAGNOSTIC_INTERVAL === 0) {
    console.log(`[poll ${String(index)}] ${host}: ${property} not yet '1'`);
  }
  return false;
}

async function checkBootCompleted(
  host: string,
  index: number
): Promise<{ connected: boolean; booted: boolean }> {
  try {
    // `sys.boot_completed=1` matches budtmo/docker-android's own
    // `wait_until_ready` (see budtmo's cli/src/device/emulator.py). Earlier
    // versions of this code also polled `service.bootanim.exit==1` but that
    // property is a transient signal: SurfaceFlinger writes it as `"1"` to
    // tell bootanimation to exit, then bootanimation immediately clears it
    // back to `"0"` on the way out (AOSP `BootAnimation.cpp` EXIT_PROP_NAME
    // + `SurfaceFlinger.cpp` bootFinished()). At a 2 s poll interval the
    // brief `"1"` window is missed deterministically, which is what wedged
    // both shards in CI run 26672463871. The residual WebView warm-up
    // window is absorbed at the flow level by the 45 s `extendedWaitUntil`
    // timeouts in `mobile-tests/flows/*.yaml`, mirroring the 15 s sleep +
    // `dumpsys window` follow-up that budtmo adds after `sys.boot_completed`.
    if (!(await probeBootProperty(host, 'sys.boot_completed', index))) {
      return { connected: true, booted: false };
    }
    return { connected: true, booted: true };
  } catch (error: unknown) {
    const detail = extractErrorDetail(error);
    if (detail.includes('offline') || detail.includes('not found')) {
      if (index % BOOT_DIAGNOSTIC_INTERVAL === 0) {
        console.log(`[poll ${String(index)}] readiness ${host}: ${detail}`);
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
  const apiPort = requireApiPort();
  // The document-panel sandbox iframe loads from VITE_SANDBOX_ORIGIN_URL
  // (http://localhost:<sandbox port>), so the emulator's WebView must reach the
  // host-served sandbox origin at the same port. adb-reverse maps the guest's
  // localhost:<port> to the host's, alongside the API port.
  const sandboxPort = requireSandboxPort();
  console.log(
    `Setting up adb reverse for API port ${apiPort} and sandbox port ${sandboxPort} on ${host}...`
  );
  await execa('adb', ['-s', host, 'reverse', `tcp:${apiPort}`, `tcp:${apiPort}`]);
  await execa('adb', ['-s', host, 'reverse', `tcp:${sandboxPort}`, `tcp:${sandboxPort}`]);
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

/**
 * Ends this run's emulator for a shard.
 *
 * The name alone is no licence to remove: it says which shard of which slot the
 * container stands for, and a same-slot run that outlived this one holds a
 * container under the same name. So the claim registry decides, and a container
 * this run cannot account for is reported rather than destroyed.
 *
 * A failure here is reported and swallowed. Teardown runs in a `finally` around
 * whatever the run was really doing, and a docker error must not replace that
 * run's own outcome with its own.
 */
export async function stopEmulator(shard: number, registryDir?: string): Promise<void> {
  const name = containerNameForShard(shard);
  console.log(`Stopping emulator shard ${String(shard)} (${name})...`);
  try {
    const outcome = await removeEmulatorContainer({ name, registryDir });
    if (outcome.spared !== undefined) console.warn(outcome.spared);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to stop emulator ${name}: ${message}`);
  }
}

export async function stopEmulators(n: number): Promise<void> {
  await Promise.all(Array.from({ length: n }, (_, shard) => stopEmulator(shard)));
}

/**
 * Spawn a wrangler-dev subprocess to serve the API while mobile tests run.
 * The dev stack itself (containers + migrations + seed) is the responsibility
 * of `pnpm ensure-stack`, which runs before this script. We just need a live
 * API process to point the emulator at. The subprocess is killed on exit, and
 * a run killed before it gets there leaves the tree recorded for the next one
 * to reap.
 */
async function pollApiReady(apiPort: string): Promise<boolean> {
  try {
    await execa('curl', ['-sf', apiHealthUrl(apiPort)], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

interface DevApiHandle {
  apiProcess: LongLivedChild | null;
}

export async function startDevApi(): Promise<DevApiHandle> {
  const apiPort = requireApiPort();

  if (await pollApiReady(apiPort)) {
    console.log('API server already running — reusing existing process');
    return { apiProcess: null };
  }

  console.log('Starting API server...');
  // Recorded against this run's claim before the readiness poll below, so a run
  // killed while the API is still starting leaves a record naming the tree.
  const apiProcess = await spawnLongLived('pnpm', ['--filter', '@hushbox/api', 'dev'], {
    stdio: 'ignore',
    env: process.env,
    ports: [Number(apiPort)],
  });

  for (let index = 0; index < API_TIMEOUT_POLLS; index++) {
    if (await pollApiReady(apiPort)) {
      console.log('API server ready');
      return { apiProcess };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, API_POLL_INTERVAL_MS);
    });
  }
  await stopDevApi({ apiProcess });
  // The server is spawned with its streams discarded, so this is the only route
  // by which the reason it refused to start reaches whoever reads the run: the
  // dev script tees wrangler's own output here, and a timeout that named nothing
  // is what made a failed custom build cost an audit to diagnose.
  const serverLog = wranglerLogPath(apiPort);
  dumpLogTail(serverLog, path.relative(REPO_ROOT, serverLog));
  throw new Error('API server failed to start within timeout');
}

export async function stopDevApi(handle: DevApiHandle): Promise<void> {
  if (!handle.apiProcess) return;
  console.log('Stopping API server we started...');
  try {
    // The tree, not the root: `pnpm` supervises wrangler, which supervises
    // workerd, and killing only the root leaves the port held.
    await handle.apiProcess.kill();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to stop API server: ${message}`);
  }
}

/**
 * Spawn the assets-only sandbox origin (`@hushbox/sandbox` dev server) so the
 * emulator's WebView can load the document renderer pages it embeds. Like the
 * API, the underlying assets are the caller's responsibility (built into
 * `apps/sandbox/public`); this just serves them on the computed sandbox port,
 * which `setupAdbReverse` then bridges into each emulator.
 */
async function pollSandboxReady(sandboxPort: string): Promise<boolean> {
  try {
    // /render.html is the html/js/react renderer page — a static asset present
    // whenever the origin is serving, so a 200 means the origin is reachable.
    await execa('curl', ['-sf', `http://localhost:${sandboxPort}/render.html`], {
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

interface SandboxOriginHandle {
  sandboxProcess: LongLivedChild | null;
}

export async function startSandboxOrigin(): Promise<SandboxOriginHandle> {
  const sandboxPort = requireSandboxPort();

  if (await pollSandboxReady(sandboxPort)) {
    console.log('Sandbox origin already running — reusing existing process');
    return { sandboxProcess: null };
  }

  console.log('Starting sandbox origin server...');
  const sandboxProcess = await spawnLongLived('pnpm', ['--filter', '@hushbox/sandbox', 'dev'], {
    stdio: 'ignore',
    env: process.env,
    ports: [Number(sandboxPort)],
  });

  for (let index = 0; index < SANDBOX_TIMEOUT_POLLS; index++) {
    if (await pollSandboxReady(sandboxPort)) {
      console.log('Sandbox origin ready');
      return { sandboxProcess };
    }
    await new Promise((resolve) => {
      setTimeout(resolve, SANDBOX_POLL_INTERVAL_MS);
    });
  }
  await stopSandboxOrigin({ sandboxProcess });
  throw new Error('Sandbox origin failed to start within timeout');
}

export async function stopSandboxOrigin(handle: SandboxOriginHandle): Promise<void> {
  if (!handle.sandboxProcess) return;
  console.log('Stopping sandbox origin we started...');
  try {
    await handle.sandboxProcess.kill();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to stop sandbox origin: ${message}`);
  }
}

/**
 * Seed a conversation whose assistant message carries the HTML document, via
 * the `dev-only` `/dev/conversation` route on the running API. Maestro cannot
 * make HTTP calls, and the mock provider only echoes prompts (so no in-flow
 * turn can produce a fenced document), so the document is seeded here and the
 * flow navigates to it. Freshly seeded each run, it is the newest conversation
 * and sorts to the top of the persona's sidebar. `-sf` fails the run loudly if
 * the seed does not return 2xx.
 */
export async function seedDocumentConversation(): Promise<void> {
  const apiPort = requireApiPort();
  console.log('Seeding the HTML-document conversation for the mobile persona...');
  await execa(
    'curl',
    [
      '-sf',
      '-X',
      'POST',
      `http://localhost:${apiPort}/dev/conversation`,
      '-H',
      'Content-Type: application/json',
      '-d',
      documentSeedPayload(),
    ],
    { stdio: 'ignore' }
  );
}

const GOOGLE_SERVICES_PATH = 'apps/web/android/app/google-services.json';
export const APK_APP_VERSION = 'local-mobile-test';
export const API_SLICE_PATH = path.join(RESULTS_DIR, 'api-during-mobile-test.log');
const FAILURE_TAIL_LINES = 200;

/**
 * Brackets a block of maestro work with START/END markers in wrangler's own
 * debug log. scripts/lib/mobile/extract-mobile-api-log.ts uses those markers to
 * slice out the API request activity that belongs to *this* run, and it reads
 * the debug log rather than the teed stdout beside it because the API's
 * request-completed line is emitted below the dev stack's `error` log level.
 * The structured request-log carries no app-version field, so the START/END
 * window is the only per-run isolation — sibling-session traffic in the same
 * window can no longer be filtered out by APK build.
 *
 * Wrangler is appending to this same file throughout the run. Both writers open
 * it `O_APPEND`, so neither's write lands on top of the other's.
 */
export async function withMobileTestRun<T>(runId: string, body: () => Promise<T>): Promise<T> {
  const apiPort = requireApiPort();
  const logPath = wranglerDebugLogPath(apiPort);
  appendFileSync(logPath, `${MARKER_PREFIX} ${runId} START ${new Date().toISOString()} =====\n`);
  try {
    return await body();
  } finally {
    appendFileSync(logPath, `${MARKER_PREFIX} ${runId} END ${new Date().toISOString()} =====\n`);
  }
}

/**
 * Slices the section belonging to `runId` out of wrangler's debug log (the
 * request-log lines and run markers inside the START/END window) and writes it
 * to maestro-results/api-during-mobile-test.log — the post-hoc debug artifact.
 * Wrangler's own framing and chatter stay in the unfiltered debug log.
 *
 * The log is named to the reader repository-relative: the slice is a CI
 * artifact, and an absolute path in it would disclose the machine it ran on.
 *
 * Assumes RESULTS_DIR exists; main() creates it before any work begins.
 */
export function writeApiSlice(runId: string): void {
  const logPath = wranglerDebugLogPath(requireApiPort());
  writeFileSync(
    API_SLICE_PATH,
    readRunApiSlice({ logPath, logLabel: path.relative(REPO_ROOT, logPath), runId })
  );
}

/**
 * Echoes the tail of a log to stdout on failure so CI step output shows the
 * context without requiring the artifact download. Mirrors the post-mortem
 * logcat dump pattern used by runMaestroOta() for OTA flows.
 *
 * `label` names the file to the reader rather than the path doing it: an
 * absolute path would disclose the machine the run happened on.
 */
function dumpLogTail(file: string, label: string, tailLines: number = FAILURE_TAIL_LINES): void {
  const lines = readFileSync(file, 'utf8').split('\n');
  const tailStart = Math.max(0, lines.length - tailLines);
  const shown = lines.length - tailStart;
  process.stdout.write(`\n=== last ${String(shown)} lines of ${label} ===\n`);
  process.stdout.write(lines.slice(tailStart).join('\n'));
  process.stdout.write(`\n=== end of ${label} ===\n`);
}

/** The slice of the run's API log written by {@link writeApiSlice}. */
export function dumpApiLogTail(tailLines: number = FAILURE_TAIL_LINES): void {
  dumpLogTail(API_SLICE_PATH, 'API log', tailLines);
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

  // The lease spans exactly the three steps that touch the shared web output —
  // the build that writes it, the guard that reads it, and the sync that copies
  // it away — and stops before the native build, which reads only the copy.
  await withBuildLease(REPO_ROOT, 'web-dist', 'pnpm mobile:test', async () => {
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

    // `cap sync` copies this dist into the APK, so the guard runs on it between
    // the build and the sync — the same position the release workflow this script
    // rehearses puts it in. A local build outside the guard is how the leaked
    // bundle this closes was produced.
    console.log('Verifying the web bundle...');
    await verifyBundle(appBundleOptions(REPO_ROOT, WEB_APP_DIR));

    console.log('Syncing Capacitor...');
    await execa('npx', ['cap', 'sync', 'android'], {
      stdio: 'inherit',
      cwd: 'apps/web',
      env: process.env,
    });
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
      ANDROID_KEYSTORE_PASSWORD: 'debug',
      ANDROID_KEY_ALIAS: 'debug',
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
  const apiPort = requireApiPort();
  console.log(`Resetting dev version override to ${APK_APP_VERSION}...`);
  const res = await fetch(`http://localhost:${apiPort}/dev/set-version`, {
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

async function prepareAdbServer(n: number): Promise<void> {
  const apiPort = requireApiPort();
  const sandboxPort = requireSandboxPort();
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
    console.log(
      `Re-establishing adb reverse for API port ${apiPort} and sandbox port ${sandboxPort} on ${host}...`
    );
    await execa('adb', ['-s', host, 'reverse', `tcp:${apiPort}`, `tcp:${apiPort}`]);
    await execa('adb', ['-s', host, 'reverse', `tcp:${sandboxPort}`, `tcp:${sandboxPort}`]);
  }
}

interface ShardResult {
  shard: number;
  exitCode: number;
  stdout: string;
}

export async function runMaestroOnShard(shard: number, flows: string[]): Promise<ShardResult> {
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
  /* v8 ignore next -- weighFlows returns a weight for every flow, so the lookup never misses */
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
    /* v8 ignore next -- the pattern's one group always participates in a match, so the guard is the compiler's index check rather than a case */
    if (match[1] !== undefined) failed.push(match[1].trim());
    match = regex.exec(output);
  }
  return failed;
}

/** Map failed flow display names back to their YAML file paths. */
export function getFailedFlowPaths(output: string): string[] {
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

/** Named once: the vite `--outDir`, the guard's options, and the archived folder all need it. */
const OTA_DIST_DIR_NAME = 'dist-ota';
const OTA_DIST_DIR = path.join(WEB_APP_DIR, OTA_DIST_DIR_NAME);

/**
 * Builds an OTA bundle, uploads to local R2, and sets the version override.
 * Uses the same codepaths as production (wrangler R2, /dev/set-version).
 */
export async function setupOtaUpdate(): Promise<void> {
  const apiUrl = requireEnv('API_URL', WITH_ENV_HINT);
  const apiPort = requireApiPort();

  console.log('Building OTA bundle...');
  await execa('pnpm', ['exec', 'vite', 'build', '--outDir', OTA_DIST_DIR_NAME], {
    cwd: WEB_APP_DIR,
    stdio: 'inherit',
    env: {
      ...process.env,
      VITE_APP_VERSION: OTA_VERSION,
      VITE_PLATFORM: 'android-direct',
      VITE_API_URL: apiUrl,
    },
  });

  // Every other bundle this repo ships is guarded here; this one was the
  // exception, so a leak reached a device-bound bundle with nothing reporting
  // it. Runs before the archive is written, because the archive lands inside
  // the directory it archives: verifying afterwards would report the zip
  // against Cloudflare's per-file cap.
  console.log('Verifying the OTA bundle...');
  await verifyBundle(appBundleOptions(REPO_ROOT, WEB_APP_DIR, OTA_DIST_DIR_NAME));

  console.log('Uploading OTA bundle to local R2...');
  // Zip the bundle in-process with adm-zip (pure JS) instead of shelling out to
  // a `zip` binary, which isn't guaranteed installed on a dev machine. Mirrors
  // `zip -r ota-bundle.zip .`: dist-ota's contents sit at the archive root.
  const zipPath = 'ota-bundle.zip';
  const otaZip = new AdmZip();
  otaZip.addLocalFolder(OTA_DIST_DIR, '', (filename) => !filename.endsWith(zipPath));
  const zipFile = path.join(OTA_DIST_DIR, zipPath);
  otaZip.writeZip(zipFile);
  // Read the written archive back rather than hashing the in-memory model of
  // it: these are the bytes uploaded, and so the bytes the native client
  // verifies against what /updates/current serves.
  const checksum = createHash('sha256').update(readFileSync(zipFile)).digest('hex');
  await execa(
    'pnpm',
    [
      'exec',
      'wrangler',
      ...r2PutArgs(
        `hushbox-app-builds/builds/android-direct/${OTA_VERSION}.zip`,
        `../web/dist-ota/${zipPath}`,
        stackModeFrom(process.env)
      ),
    ],
    { cwd: 'apps/api', stdio: 'inherit' }
  );

  // A bundle's sha256 exists only once the zip is built, so no binding can
  // carry it and the harness publishes it through the dev channel instead —
  // without it the native client refuses to install an unverifiable bundle.
  // Published before the version, because the client reads both from one
  // response: a device polling in between must never see the new version
  // without the checksum that lets it install.
  console.log('Publishing OTA bundle checksum...');
  const checksumRes = await fetch(`http://localhost:${apiPort}/dev/set-checksum`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ platform: 'android-direct', checksum }),
  });
  if (!checksumRes.ok) {
    throw new Error('Failed to publish bundle checksum');
  }

  console.log('Setting version override...');
  const res = await fetch(`http://localhost:${apiPort}/dev/set-version`, {
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
  const parsed = readCommandLine(COMMAND_LINE, process.argv.slice(2));
  if (parsed === null) return;
  assertLinux();
  const smoke = parsed.flags['--smoke'];
  const n = SHARDS;

  await checkPrerequisites();
  await Promise.all([installMaestro(), installAndroidSdk()]);

  // One tag for every shard, resolved before any of them starts; see
  // {@link bakeImage} for what resolving it costs a run.
  const imageTag = await bakeImage({ push: false });

  // Containers, migrations, and seed are the caller's responsibility — locally
  // via `pnpm ensure-stack`, in CI via the workflow's db:up/db:migrate/db:seed
  // steps. Start a wrangler-dev API so the emulator has something to talk to.
  // The idle-killer daemon reaps containers later if this process crashes
  // without explicit teardown.
  const devApi = await startDevApi();
  // The document-panel flow embeds the sandbox origin's renderer pages; serve
  // them locally so the emulator's WebView (via adb-reverse) can reach them.
  const sandboxOrigin = await startSandboxOrigin();
  mkdirSync(RESULTS_DIR, { recursive: true });
  const runId = randomUUID().slice(0, 8);
  try {
    // Seed the HTML-document conversation the document-render flow opens. The
    // API is up and the DB is seeded (ensure-stack) by this point.
    await seedDocumentConversation();
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
    await stopSandboxOrigin(sandboxOrigin);
    await stopDevApi(devApi);
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

/**
 * Published from here as well as from its own module, because this is the door
 * the port allocator's own test and the mobile suite already come through.
 */
export { adbPortForShard } from './lib/mobile/shards.js';
