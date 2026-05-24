/* eslint-disable no-restricted-syntax -- mobile-test.ts is gated to Linux via assertLinux() and intentionally shells out to mkdir/curl/unzip/bash for one-shot SDK installation on the CI runner. */
import { execa } from 'execa';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { isMainModule } from './lib/is-main.js';

const APK_PATH = 'apps/web/android/app/build/outputs/apk/debug/app-debug.apk';
const BOOT_TIMEOUT_POLLS = 120;
const BOOT_POLL_INTERVAL_MS = 2000;
const BOOT_DIAGNOSTIC_INTERVAL = 10;
const API_TIMEOUT_POLLS = 30;
const API_POLL_INTERVAL_MS = 1000;
const EMULATOR_SERVICE = 'android-emulator';

export function parseArgs(args: string[]): { smoke: boolean } {
  return { smoke: args.includes('--smoke') };
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

export async function getContainerStatus(): Promise<string> {
  try {
    const result = await execa(
      'docker',
      ['compose', '--profile', 'mobile', 'ps', '--format', 'json', EMULATOR_SERVICE],
      { stdio: 'pipe' }
    );
    return result.stdout.trim() || 'no output';
  } catch {
    return 'failed to get container status';
  }
}

export async function dumpContainerLogs(tail = 200): Promise<string> {
  try {
    const result = await execa(
      'docker',
      ['compose', '--profile', 'mobile', 'logs', '--tail', String(tail), EMULATOR_SERVICE],
      { stdio: 'pipe' }
    );
    return result.stdout || result.stderr || 'no logs';
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return `failed to get container logs: ${message}`;
  }
}

function extractErrorDetail(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr ?? '';
  const shortMessage = (error as { shortMessage?: string }).shortMessage ?? '';
  return stderr || shortMessage || (error instanceof Error ? error.message : String(error));
}

async function dumpBootDiagnostics(): Promise<void> {
  console.error('=== EMULATOR BOOT TIMEOUT DIAGNOSTICS ===');
  console.error('--- Container logs (last 200 lines) ---');
  console.error(await dumpContainerLogs());
  console.error('--- Container status ---');
  console.error(await getContainerStatus());
  try {
    const adbDevices = await execa('adb', ['devices'], { stdio: 'pipe' });
    console.error(`--- ADB devices ---\n${adbDevices.stdout}`);
  } catch {
    console.error('--- ADB devices: failed to query ---');
  }
  console.error('=== END DIAGNOSTICS ===');
}

async function pollEmulatorBoot(
  adbPort: string,
  connected: boolean,
  index: number
): Promise<{ connected: boolean; booted: boolean }> {
  if (!connected) {
    const connectResult = await execa('adb', ['connect', `localhost:${adbPort}`], {
      stdio: 'pipe',
    });
    const connectOutput = connectResult.stdout.trim();
    // adb connect returns exit 0 even on failure with output like
    // "unable to connect" or "failed to connect". Only set connected
    // when the output confirms an actual connection.
    if (!connectOutput.includes('connected to') || connectOutput.includes('unable')) {
      if (index % BOOT_DIAGNOSTIC_INTERVAL === 0) {
        console.log(`[poll ${String(index)}] adb connect: ${connectOutput}`);
      }
      return { connected: false, booted: false };
    }
    console.log(`Connected to localhost:${adbPort}`);
    connected = true;
  }

  const result = await execa('adb', [
    '-s',
    `localhost:${adbPort}`,
    'shell',
    'getprop',
    'sys.boot_completed',
  ]);
  return { connected, booted: result.stdout.trim() === '1' };
}

async function setupAdbReverse(adbPort: string): Promise<void> {
  // Set up reverse port forwarding so the emulator can reach the host API.
  // In Docker, 10.0.2.2 maps to the container, not the host.
  // adb reverse tunnels emulator localhost:PORT → host localhost:PORT.
  const apiPort = process.env['HB_API_PORT'] ?? '8787';
  console.log(`Setting up adb reverse for API port ${apiPort}...`);
  await execa('adb', ['-s', `localhost:${adbPort}`, 'reverse', `tcp:${apiPort}`, `tcp:${apiPort}`]);
}

async function logPollError(error: unknown, connected: boolean, index: number): Promise<void> {
  const detail = extractErrorDetail(error);
  const phase = connected ? 'getprop' : 'adb connect';
  console.log(`[poll ${String(index)}] ${phase} error: ${detail}`);
  const status = await getContainerStatus();
  console.log(`[poll ${String(index)}] container: ${status}`);
}

export async function stopEmulator(): Promise<void> {
  console.log('Stopping Android emulator...');
  try {
    // `compose --profile X down` removes the project network too — which
    // detaches sibling containers (postgres, redis from `pnpm dev` running
    // in parallel) and kills the dev API. Stop+rm just the emulator service
    // instead so a concurrent dev stack survives.
    await execa('docker', ['compose', 'stop', 'android-emulator'], {
      stdio: 'inherit',
    });
    await execa('docker', ['compose', 'rm', '-f', 'android-emulator'], {
      stdio: 'inherit',
    });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Failed to stop emulator: ${message}`);
  }
}

export async function startEmulator(): Promise<void> {
  // Detect host KVM group ID so the container user can access /dev/kvm
  const kvmStat = await execa('stat', ['-c', '%g', '/dev/kvm']);
  process.env['HB_KVM_GID'] = kvmStat.stdout.trim();

  console.log('Starting Android emulator...');
  await execa('docker', ['compose', '--profile', 'mobile', 'up', '-d', 'android-emulator'], {
    stdio: 'inherit',
    env: process.env,
  });

  const adbPort = process.env['HB_EMULATOR_ADB_PORT'] ?? '5555';
  let connected = false;

  console.log('Waiting for emulator to boot...');
  for (let index = 0; index < BOOT_TIMEOUT_POLLS; index++) {
    try {
      const poll = await pollEmulatorBoot(adbPort, connected, index);
      connected = poll.connected;
      if (poll.booted) {
        console.log('Emulator booted');
        await setupAdbReverse(adbPort);
        return;
      }
    } catch (error: unknown) {
      if (index % BOOT_DIAGNOSTIC_INTERVAL === 0) {
        await logPollError(error, connected, index);
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, BOOT_POLL_INTERVAL_MS);
    });
  }

  await dumpBootDiagnostics();
  throw new Error('Emulator failed to boot within timeout');
}

export async function startDevStack(): Promise<void> {
  const apiPort = process.env['HB_API_PORT'] ?? '8787';

  try {
    await execa('curl', ['-sf', `http://localhost:${apiPort}/api/health`], { stdio: 'ignore' });
    console.log('API server already running');
    return;
  } catch {
    // API not running, start it
  }

  console.log('Starting dev stack...');
  await execa('pnpm', ['db:up'], { stdio: 'inherit', env: process.env });
  await execa('pnpm', ['db:migrate'], { stdio: 'inherit', env: process.env });
  await execa('pnpm', ['db:seed'], { stdio: 'inherit', env: process.env });

  const apiProcess = execa('pnpm', ['--filter', '@hushbox/api', 'dev'], {
    stdio: 'ignore',
    env: process.env,
    cleanup: false,
  });
  // eslint-disable-next-line promise/prefer-await-to-then, @typescript-eslint/no-empty-function -- fire-and-forget subprocess
  apiProcess.catch(() => {});
  // Allow the parent process to exit without waiting for the dev server
  apiProcess.unref();

  console.log('Waiting for API server...');
  for (let index = 0; index < API_TIMEOUT_POLLS; index++) {
    try {
      await execa('curl', ['-sf', `http://localhost:${apiPort}/api/health`], { stdio: 'ignore' });
      console.log('API server ready');
      return;
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => {
      setTimeout(resolve, API_POLL_INTERVAL_MS);
    });
  }
  throw new Error('API server failed to start within timeout');
}

const GOOGLE_SERVICES_PATH = 'apps/web/android/app/google-services.json';
const APK_APP_VERSION = 'local-mobile-test';

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
  await execa(gradlew, ['assembleDebug'], {
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

export async function installApk(): Promise<void> {
  const adbPort = process.env['HB_EMULATOR_ADB_PORT'] ?? '5555';

  console.log('Installing APK...');
  await execa('adb', ['-s', `localhost:${adbPort}`, 'install', '-r', APK_PATH], {
    stdio: 'inherit',
  });
}

/**
 * Reset the dev API's in-memory version override to match the APK we built.
 *
 * The OTA test flow ({@link setupOtaUpdate}) at the end of a successful
 * `pnpm mobile:test` run sets the override to `OTA_VERSION` and never clears
 * it. The override lives in a module-level variable in the API
 * (`apps/api/src/lib/version-override.ts`), and Wrangler dev is a long-lived
 * process — so the next `pnpm mobile:test` invocation inherits that stale
 * value. Without this reset, every authenticated request from the freshly
 * built APK (which carries `X-App-Version=local-mobile-test`) fails with
 * 426 Upgrade Required, the WebView flips into its offline-overlay state,
 * and every post-login flow assertion misses the elements it needs.
 *
 * Called before each Maestro batch so the override is correct even when a
 * prior run left it dirty.
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

export async function configureAppLinks(): Promise<void> {
  const adbPort = process.env['HB_EMULATOR_ADB_PORT'] ?? '5555';

  console.log('Configuring app link verification...');
  await execa(
    'adb',
    [
      '-s',
      `localhost:${adbPort}`,
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

  console.log('Disabling Chrome so deep links route to app...');
  await execa(
    'adb',
    [
      '-s',
      `localhost:${adbPort}`,
      'shell',
      'pm',
      'disable-user',
      '--user',
      '0',
      'com.android.chrome',
    ],
    { stdio: 'inherit' }
  );
}

/**
 * Prime the soft keyboard (Gboard on docker-android) by typing a dummy string
 * through `adb shell input text` — which bypasses the IME state machine and
 * lands characters via InputManager directly. Without this, Maestro's first
 * `inputText` against a focused WebView field can stall on per-keystroke
 * IME callbacks for the full 120s gRPC deadline. Once the IME process has
 * dispatched any text successfully, subsequent Maestro key events flow
 * normally.
 *
 * The dummy text is sent to whatever happens to have focus (typically the
 * launcher when called between `installApk` and the first `launchApp`), so it
 * has no effect on test state.
 */
export async function primeImeKeyboard(): Promise<void> {
  const adbPort = process.env['HB_EMULATOR_ADB_PORT'] ?? '5555';
  console.log('Priming soft keyboard IME...');
  // Three passes so Gboard's dictionary/prediction caches stay warm for the
  // whole flow batch. One pass works for an isolated flow but degrades
  // across flows. Plain alphanumeric only — `adb shell input text` escaping
  // for punctuation is shell-dependent.
  for (const text of ['maestrowarmup', 'emailtestseed', 'passwordseed123']) {
    await execa('adb', ['-s', `localhost:${adbPort}`, 'shell', 'input', 'text', text], {
      stdio: 'inherit',
    });
  }
}

export async function runMaestro(smoke: boolean): Promise<void> {
  const adbPort = process.env['HB_EMULATOR_ADB_PORT'] ?? '5555';
  const apiPort = process.env['HB_API_PORT'] ?? '8787';

  // Kill and restart the adb server with emulator port scanning disabled.
  // The adb server auto-discovers emulator ports (5554-5682) and creates
  // ghost "emulator-XXXX offline" entries that crash Maestro's dadb.
  // ADB_LOCAL_TRANSPORT_MAX_PORT=0 prevents the scan entirely.
  console.log('Restarting adb server without emulator port scanning...');
  await execa('adb', ['kill-server']).catch(() => {
    // Ignored: kill-server fails if adb is not running
  });
  const adbEnv = { ...process.env, ADB_LOCAL_TRANSPORT_MAX_PORT: '0' };
  await execa('adb', ['start-server'], { env: adbEnv });
  await execa('adb', ['connect', `localhost:${adbPort}`]);
  await execa('adb', ['-s', `localhost:${adbPort}`, 'wait-for-device']);

  // Re-establish reverse port forwarding (lost when adb server was killed).
  console.log(`Re-establishing adb reverse for API port ${apiPort}...`);
  await execa('adb', ['-s', `localhost:${adbPort}`, 'reverse', `tcp:${apiPort}`, `tcp:${apiPort}`]);

  const FLOW_DIR = 'mobile-tests/flows';
  const flowArgs = smoke
    ? [
        `${FLOW_DIR}/01-app-launch.yaml`,
        `${FLOW_DIR}/02-splash-screen.yaml`,
        `${FLOW_DIR}/03-webview-renders.yaml`,
      ]
    : readdirSync(FLOW_DIR)
        .filter((f) => f.endsWith('.yaml') && f !== path.basename(OTA_FLOW))
        .toSorted((a, b) => a.localeCompare(b))
        .map((f) => `${FLOW_DIR}/${f}`);
  const args = [
    'test',
    '--device',
    `localhost:${adbPort}`,
    '--debug-output',
    'maestro-results',
    '--flatten-debug-output',
    ...flowArgs,
  ];

  // Prime the IME immediately before invoking Maestro — Gboard's per-keystroke
  // dispatch on docker-android stalls Maestro's first `inputText` for the
  // full 120s gRPC deadline unless the IME has already processed text. We
  // re-prime before the retry batch for the same reason.
  await primeImeKeyboard();

  console.log(`Running Maestro tests${smoke ? ' (smoke)' : ''}...`);
  const result = await execa('maestro', args, {
    stdout: ['pipe', 'inherit'],
    stderr: 'inherit',
    reject: false,
  });

  if (result.exitCode === 0) return;

  const failedPaths = getFailedFlowPaths(result.stdout);
  if (failedPaths.length === 0) {
    // Can't identify individual failures — fail without retry
    throw new Error('Maestro tests failed');
  }

  console.log(`\nRetrying ${String(failedPaths.length)} failed flow(s)...`);
  await primeImeKeyboard();
  await execa(
    'maestro',
    [
      'test',
      '--device',
      `localhost:${adbPort}`,
      '--debug-output',
      'maestro-results',
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

  const flowDir = 'mobile-tests/flows';
  const nameToPath = new Map<string, string>();
  for (const file of readdirSync(flowDir).filter((f) => f.endsWith('.yaml'))) {
    const content = readFileSync(path.join(flowDir, file), 'utf8');
    const nameMatch = /^name:\s*(.+)$/m.exec(content);
    if (nameMatch?.[1]) {
      nameToPath.set(nameMatch[1].trim(), path.join(flowDir, file));
    }
  }

  return failedNames
    .map((name) => nameToPath.get(name))
    .filter((p): p is string => p !== undefined);
}

const OTA_VERSION = 'ota-v2';
const OTA_FLOW = 'mobile-tests/flows/13-ota-update.yaml';

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

async function runMaestroOta(): Promise<void> {
  const adbPort = process.env['HB_EMULATOR_ADB_PORT'] ?? '5555';

  console.log('Running OTA update Maestro flow...');
  try {
    await execa('maestro', ['test', '--device', `localhost:${adbPort}`, OTA_FLOW], {
      stdio: 'inherit',
    });
  } catch (error: unknown) {
    // Dump app-specific logcat before re-throwing so we can see Capgo/WebView errors
    console.log('\n=== Logcat dump for OTA test failure (Capacitor + CapgoUpdater) ===');
    await execa(
      'adb',
      [
        '-s',
        `localhost:${adbPort}`,
        'logcat',
        '-d',
        '-s',
        'Capacitor/Console:*',
        'CapgoUpdater:*',
        'SplashScreenView:*',
      ],
      { stdio: 'inherit' }
    ).catch(() => {
      // Ignored: logcat dump is best-effort diagnostic output
    });
    throw error;
  }
}

export async function main(): Promise<void> {
  assertLinux();
  const { smoke } = parseArgs(process.argv.slice(2));

  await checkPrerequisites();
  await Promise.all([installMaestro(), installAndroidSdk()]);

  try {
    // Emulator boot, dev stack, and APK build are independent — run in parallel
    await Promise.all([startEmulator(), startDevStack(), buildApk()]);
    await installApk();
    await configureAppLinks();
    await resetVersionOverride();
    await runMaestro(smoke);

    if (!smoke) {
      await setupOtaUpdate();
      await runMaestroOta();
    }

    console.log('Mobile tests complete!');
  } finally {
    await stopEmulator();
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
