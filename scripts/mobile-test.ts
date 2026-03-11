import { execa } from 'execa';
import { existsSync, writeFileSync } from 'node:fs';

const APK_PATH = 'apps/web/android/app/build/outputs/apk/debug/app-debug.apk';
const BOOT_TIMEOUT_POLLS = 120;
const BOOT_POLL_INTERVAL_MS = 2000;
const API_TIMEOUT_POLLS = 30;
const API_POLL_INTERVAL_MS = 1000;

export function parseArgs(args: string[]): { smoke: boolean } {
  return { smoke: args.includes('--smoke') };
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
    return;
  }

  if (existsSync(`${ANDROID_SDK_ROOT}/platforms/${REQUIRED_PLATFORM}`)) {
    process.env['ANDROID_HOME'] = ANDROID_SDK_ROOT;
    console.log('Android SDK found');
    return;
  }

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

export async function startEmulator(): Promise<void> {
  // Detect host KVM group ID so the container user can access /dev/kvm
  const kvmStat = await execa('stat', ['-c', '%g', '/dev/kvm']);
  process.env['HB_KVM_GID'] = kvmStat.stdout.trim();

  console.log('Starting Android emulator...');
  await execa(
    'docker',
    ['compose', '--profile', 'mobile', 'up', '-d', '--force-recreate', 'android-emulator'],
    {
      stdio: 'inherit',
      env: process.env,
    }
  );

  const adbPort = process.env['HB_EMULATOR_ADB_PORT'] ?? '5555';
  let connected = false;

  console.log('Waiting for emulator to boot...');
  for (let index = 0; index < BOOT_TIMEOUT_POLLS; index++) {
    try {
      if (!connected) {
        await execa('adb', ['connect', `localhost:${adbPort}`], { stdio: 'pipe' });
        connected = true;
        console.log(`Connected to localhost:${adbPort}`);
      }
      const result = await execa('adb', [
        '-s',
        `localhost:${adbPort}`,
        'shell',
        'getprop',
        'sys.boot_completed',
      ]);
      if (result.stdout.trim() === '1') {
        console.log('Emulator booted');

        // Set up reverse port forwarding so the emulator can reach the host API.
        // In Docker, 10.0.2.2 maps to the container, not the host.
        // adb reverse tunnels emulator localhost:PORT → host localhost:PORT.
        const apiPort = process.env['HB_API_PORT'] ?? '8787';
        console.log(`Setting up adb reverse for API port ${apiPort}...`);
        await execa('adb', [
          '-s',
          `localhost:${adbPort}`,
          'reverse',
          `tcp:${apiPort}`,
          `tcp:${apiPort}`,
        ]);

        return;
      }
    } catch {
      // Not ready yet
    }
    await new Promise((resolve) => {
      setTimeout(resolve, BOOT_POLL_INTERVAL_MS);
    });
  }
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
  });
  // eslint-disable-next-line promise/prefer-await-to-then, @typescript-eslint/no-empty-function -- fire-and-forget subprocess
  apiProcess.catch(() => {});

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
      VITE_API_URL: apiUrl,
      VITE_PLATFORM: 'android-direct',
      VITE_APP_VERSION: 'local-mobile-test',
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

export async function runMaestro(smoke: boolean): Promise<void> {
  const adbPort = process.env['HB_EMULATOR_ADB_PORT'] ?? '5555';

  // Reconnect adb to ensure clean connection state for Maestro.
  await execa('adb', ['disconnect', `localhost:${adbPort}`]);
  await execa('adb', ['connect', `localhost:${adbPort}`]);

  const flowArgs = smoke
    ? [
        'mobile-tests/flows/01-app-launch.yaml',
        'mobile-tests/flows/02-splash-screen.yaml',
        'mobile-tests/flows/03-webview-renders.yaml',
      ]
    : ['mobile-tests/flows/'];
  const args = [
    'test',
    '--device',
    `localhost:${adbPort}`,
    '--debug-output',
    'maestro-results',
    '--flatten-debug-output',
    ...flowArgs,
  ];

  console.log(`Running Maestro tests${smoke ? ' (smoke)' : ''}...`);
  await execa('maestro', args, { stdio: 'inherit' });
}

export async function main(): Promise<void> {
  const { smoke } = parseArgs(process.argv.slice(2));

  await checkPrerequisites();
  await installMaestro();
  await installAndroidSdk();
  await startEmulator();
  await startDevStack();
  await buildApk();
  await installApk();
  await configureAppLinks();
  await runMaestro(smoke);

  console.log('Mobile tests complete!');
}

// CLI entry point
/* v8 ignore start */
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
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
