import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock execa before importing the module
vi.mock('execa', () => ({
  execa: vi.fn(),
}));

// Mock fs.existsSync for /dev/kvm check
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    writeFileSync: vi.fn(),
  };
});

import { execa } from 'execa';
import { existsSync, writeFileSync } from 'node:fs';
import {
  parseArgs,
  checkPrerequisites,
  installMaestro,
  installAndroidSdk,
  startEmulator,
  startDevStack,
  buildApk,
  installApk,
  runMaestro,
  main,
} from './mobile-test.js';

const mockExeca = vi.mocked(execa);
const mockExistsSync = vi.mocked(existsSync);
const mockWriteFileSync = vi.mocked(writeFileSync);

describe('mobile-test script', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExeca.mockResolvedValue({} as never);
    mockExistsSync.mockReturnValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('parseArgs', () => {
    it('returns smoke false by default', () => {
      expect(parseArgs([])).toEqual({ smoke: false });
    });

    it('returns smoke true when --smoke flag is present', () => {
      expect(parseArgs(['--smoke'])).toEqual({ smoke: true });
    });

    it('ignores other flags', () => {
      expect(parseArgs(['--other', '--smoke', '--flag'])).toEqual({ smoke: true });
    });
  });

  describe('checkPrerequisites', () => {
    it('calls docker info to check Docker is running', async () => {
      await checkPrerequisites();

      expect(mockExeca).toHaveBeenCalledWith('docker', ['info'], { stdio: 'ignore' });
    });

    it('throws when Docker is not running', async () => {
      mockExeca.mockRejectedValueOnce(new Error('Docker not running'));

      await expect(checkPrerequisites()).rejects.toThrow('Docker is not running');
    });

    it('checks /dev/kvm exists', async () => {
      await checkPrerequisites();

      expect(mockExistsSync).toHaveBeenCalledWith('/dev/kvm');
    });

    it('throws when /dev/kvm is not found', async () => {
      mockExistsSync.mockReturnValue(false);

      await expect(checkPrerequisites()).rejects.toThrow('/dev/kvm not found');
    });
  });

  describe('installMaestro', () => {
    it('checks if maestro is already installed', async () => {
      await installMaestro();

      expect(mockExeca).toHaveBeenCalledWith('maestro', ['--version'], { stdio: 'ignore' });
    });

    it('installs maestro when not found', async () => {
      mockExeca.mockRejectedValueOnce(new Error('not found'));
      mockExeca.mockResolvedValueOnce({} as never);

      await installMaestro();

      expect(mockExeca).toHaveBeenCalledWith(
        'bash',
        ['-c', 'curl -fsSL "https://get.maestro.mobile.dev" | bash'],
        { stdio: 'inherit' }
      );
    });

    it('does not install when maestro is already available', async () => {
      await installMaestro();

      expect(mockExeca).toHaveBeenCalledTimes(1);
    });
  });

  describe('installAndroidSdk', () => {
    afterEach(() => {
      delete process.env['ANDROID_HOME'];
    });

    it('skips install when ANDROID_HOME is set and platform exists', async () => {
      process.env['ANDROID_HOME'] = '/opt/android-sdk';
      mockExistsSync.mockReturnValue(true);

      await installAndroidSdk();

      const curlCalls = mockExeca.mock.calls.filter((c) => c[0] === 'curl');
      expect(curlCalls).toHaveLength(0);
    });

    it('skips install when default SDK location has platform', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockReturnValue(true);

      await installAndroidSdk();

      const curlCalls = mockExeca.mock.calls.filter((c) => c[0] === 'curl');
      expect(curlCalls).toHaveLength(0);
      expect(process.env['ANDROID_HOME']).toContain('Android/Sdk');
    });

    it('installs SDK when not found', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockImplementation(((p: string) => !p.includes('android-36')) as never);

      await installAndroidSdk();

      expect(mockExeca).toHaveBeenCalledWith(
        'curl',
        expect.arrayContaining(['-o', '/tmp/cmdline-tools.zip']), // eslint-disable-line sonarjs/publicly-writable-directories -- /tmp is standard for CI SDK downloads
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(mockExeca).toHaveBeenCalledWith(
        'unzip',
        expect.arrayContaining(['/tmp/cmdline-tools.zip']), // eslint-disable-line sonarjs/publicly-writable-directories -- /tmp is standard for CI SDK downloads
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(process.env['ANDROID_HOME']).toContain('Android/Sdk');
    });

    it('accepts licenses and installs platform', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockImplementation(((p: string) => !p.includes('android-36')) as never);

      await installAndroidSdk();

      expect(mockExeca).toHaveBeenCalledWith(
        'bash',
        ['-c', expect.stringContaining('--licenses')],
        expect.objectContaining({ stdio: 'pipe' })
      );
      expect(mockExeca).toHaveBeenCalledWith(
        expect.stringContaining('sdkmanager'),
        expect.arrayContaining(['platforms;android-36', 'platform-tools']),
        expect.objectContaining({ stdio: 'inherit' })
      );
    });
  });

  describe('startEmulator', () => {
    const emulatorMock = ((cmd: string, args?: readonly string[]) => {
      if (cmd === 'stat') return Promise.resolve({ stdout: '993' } as never);
      if (cmd === 'adb' && Array.isArray(args) && args.includes('getprop')) {
        return Promise.resolve({ stdout: '1' } as never);
      }
      return Promise.resolve({} as never);
    }) as never;

    it('detects KVM group ID before starting', async () => {
      mockExeca.mockImplementation(emulatorMock);

      await startEmulator();

      expect(mockExeca).toHaveBeenCalledWith('stat', ['-c', '%g', '/dev/kvm']);
      expect(process.env['HB_KVM_GID']).toBe('993');

      delete process.env['HB_KVM_GID'];
    });

    it('starts emulator via docker compose with mobile profile', async () => {
      mockExeca.mockImplementation(emulatorMock);

      await startEmulator();

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['compose', '--profile', 'mobile', 'up', '-d', '--force-recreate', 'android-emulator'],
        expect.objectContaining({ stdio: 'inherit' })
      );

      delete process.env['HB_KVM_GID'];
    });

    it('connects adb to the emulator port', async () => {
      process.env['HB_EMULATOR_ADB_PORT'] = '5555';
      mockExeca.mockImplementation(emulatorMock);

      await startEmulator();

      expect(mockExeca).toHaveBeenCalledWith('adb', ['connect', 'localhost:5555'], {
        stdio: 'pipe',
      });

      delete process.env['HB_EMULATOR_ADB_PORT'];
      delete process.env['HB_KVM_GID'];
    });

    it('polls for boot completion', async () => {
      let pollCount = 0;
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'stat') return Promise.resolve({ stdout: '993' } as never);
        if (cmd === 'adb' && Array.isArray(args) && args.includes('getprop')) {
          pollCount++;
          if (pollCount < 3) return Promise.reject(new Error('not ready'));
          return Promise.resolve({ stdout: '1' } as never);
        }
        return Promise.resolve({} as never);
      }) as never);

      await startEmulator();

      expect(pollCount).toBe(3);

      delete process.env['HB_KVM_GID'];
    });
  });

  describe('startDevStack', () => {
    it('checks if API is already running', async () => {
      process.env['HB_API_PORT'] = '8787';

      await startDevStack();

      expect(mockExeca).toHaveBeenCalledWith('curl', ['-sf', 'http://localhost:8787/api/health'], {
        stdio: 'ignore',
      });

      delete process.env['HB_API_PORT'];
    });

    it('skips startup when API is already running', async () => {
      process.env['HB_API_PORT'] = '8787';

      await startDevStack();

      // Only the health check call, no db:up/migrate/seed
      const dbUpCalls = mockExeca.mock.calls.filter(
        (call) => call[0] === 'pnpm' && Array.isArray(call[1]) && call[1].includes('db:up')
      );
      expect(dbUpCalls).toHaveLength(0);

      delete process.env['HB_API_PORT'];
    });

    it('starts full stack when API is not running', async () => {
      process.env['HB_API_PORT'] = '8787';
      let healthCheckCount = 0;

      mockExeca.mockImplementation(((cmd: string, _args?: readonly string[]) => {
        if (cmd === 'curl') {
          healthCheckCount++;
          if (healthCheckCount === 1) return Promise.reject(new Error('not running'));
          return Promise.resolve({} as never);
        }
        return Promise.resolve({} as never);
      }) as never);

      await startDevStack();

      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['db:up'],
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['db:migrate'],
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['db:seed'],
        expect.objectContaining({ stdio: 'inherit' })
      );

      delete process.env['HB_API_PORT'];
    });

    it('starts API server in background when stack is not running', async () => {
      process.env['HB_API_PORT'] = '8787';
      let healthCheckCount = 0;

      mockExeca.mockImplementation(((cmd: string, _args?: readonly string[]) => {
        if (cmd === 'curl') {
          healthCheckCount++;
          if (healthCheckCount === 1) return Promise.reject(new Error('not running'));
          return Promise.resolve({} as never);
        }
        return Promise.resolve({} as never);
      }) as never);

      await startDevStack();

      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['--filter', '@hushbox/api', 'dev'],
        expect.objectContaining({ stdio: 'ignore' })
      );

      delete process.env['HB_API_PORT'];
    });
  });

  describe('buildApk', () => {
    beforeEach(() => {
      process.env['API_URL'] = 'http://localhost:8787';
      process.env['FRONTEND_URL'] = 'http://localhost:5173';
    });

    afterEach(() => {
      delete process.env['API_URL'];
      delete process.env['FRONTEND_URL'];
    });

    it('builds web with env vars derived from process.env', async () => {
      await buildApk();

      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['--filter', 'web', 'build'],
        expect.objectContaining({
          stdio: 'inherit',
          env: expect.objectContaining({
            VITE_API_URL: 'http://localhost:8787',
            VITE_PLATFORM: 'android-direct',
            VITE_APP_VERSION: 'local-mobile-test',
            VITE_OPAQUE_SERVER_ID: 'localhost:5173',
          }),
        })
      );
    });

    it('throws when API_URL is not set', async () => {
      delete process.env['API_URL'];

      await expect(buildApk()).rejects.toThrow('API_URL not set');
    });

    it('throws when FRONTEND_URL is not set', async () => {
      delete process.env['FRONTEND_URL'];

      await expect(buildApk()).rejects.toThrow('FRONTEND_URL not set');
    });

    it('syncs capacitor', async () => {
      await buildApk();

      expect(mockExeca).toHaveBeenCalledWith('npx', ['cap', 'sync', 'android'], {
        stdio: 'inherit',
        cwd: 'apps/web',
        env: process.env,
      });
    });

    it('writes google-services.json from base64 env var when missing', async () => {
      const jsonContent = '{"project_info":{"project_id":"test"}}';
      process.env['GOOGLE_SERVICES_JSON_BASE64'] = Buffer.from(jsonContent).toString('base64');
      mockExistsSync.mockImplementation(
        ((p: string) => p !== 'apps/web/android/app/google-services.json') as never
      );

      await buildApk();

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        'apps/web/android/app/google-services.json',
        jsonContent
      );

      delete process.env['GOOGLE_SERVICES_JSON_BASE64'];
    });

    it('skips writing google-services.json when file already exists', async () => {
      mockExistsSync.mockReturnValue(true);

      await buildApk();

      expect(mockWriteFileSync).not.toHaveBeenCalled();
    });

    it('throws when google-services.json is missing and env var is not set', async () => {
      delete process.env['GOOGLE_SERVICES_JSON_BASE64'];
      mockExistsSync.mockImplementation(
        ((p: string) => p !== 'apps/web/android/app/google-services.json') as never
      );

      await expect(buildApk()).rejects.toThrow('GOOGLE_SERVICES_JSON_BASE64');
    });

    it('runs gradle assembleDebug with version and keystore env vars', async () => {
      await buildApk();

      expect(mockExeca).toHaveBeenCalledWith('./gradlew', ['assembleDebug'], {
        stdio: 'inherit',
        cwd: 'apps/web/android',
        env: expect.objectContaining({
          VERSION_CODE: '1',
          VERSION_NAME: 'local-mobile-test',
          ANDROID_KEYSTORE_PATH: 'debug.keystore',
          ANDROID_KEYSTORE_PASSWORD: 'debug',
          ANDROID_KEY_ALIAS: 'debug',
          ANDROID_KEY_PASSWORD: 'debug',
        }),
      });
    });
  });

  describe('installApk', () => {
    it('installs APK via adb', async () => {
      process.env['HB_EMULATOR_ADB_PORT'] = '5555';

      await installApk();

      expect(mockExeca).toHaveBeenCalledWith(
        'adb',
        [
          '-s',
          'localhost:5555',
          'install',
          '-r',
          'apps/web/android/app/build/outputs/apk/debug/app-debug.apk',
        ],
        { stdio: 'inherit' }
      );

      delete process.env['HB_EMULATOR_ADB_PORT'];
    });
  });

  describe('runMaestro', () => {
    it('reconnects adb before running maestro', async () => {
      process.env['HB_EMULATOR_ADB_PORT'] = '5555';

      await runMaestro(false);

      expect(mockExeca).toHaveBeenCalledWith('adb', ['disconnect', 'localhost:5555']);
      expect(mockExeca).toHaveBeenCalledWith('adb', ['connect', 'localhost:5555']);

      delete process.env['HB_EMULATOR_ADB_PORT'];
    });

    it('runs all flows with --device flag when smoke is false', async () => {
      process.env['HB_EMULATOR_ADB_PORT'] = '5555';

      await runMaestro(false);

      expect(mockExeca).toHaveBeenCalledWith(
        'maestro',
        [
          'test',
          '--device',
          'localhost:5555',
          '--debug-output',
          'maestro-results',
          '--flatten-debug-output',
          'mobile-tests/flows/',
        ],
        { stdio: 'inherit' }
      );

      delete process.env['HB_EMULATOR_ADB_PORT'];
    });

    it('runs only smoke flows when smoke is true', async () => {
      process.env['HB_EMULATOR_ADB_PORT'] = '5555';

      await runMaestro(true);

      expect(mockExeca).toHaveBeenCalledWith(
        'maestro',
        [
          'test',
          '--device',
          'localhost:5555',
          '--debug-output',
          'maestro-results',
          '--flatten-debug-output',
          'mobile-tests/flows/01-app-launch.yaml',
          'mobile-tests/flows/02-splash-screen.yaml',
          'mobile-tests/flows/03-webview-renders.yaml',
        ],
        { stdio: 'inherit' }
      );

      delete process.env['HB_EMULATOR_ADB_PORT'];
    });
  });

  describe('main', () => {
    beforeEach(() => {
      process.env['HB_API_PORT'] = '8787';
      process.env['HB_EMULATOR_ADB_PORT'] = '5555';
      process.env['API_URL'] = 'http://localhost:8787';
      process.env['FRONTEND_URL'] = 'http://localhost:5173';

      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'stat') return Promise.resolve({ stdout: '993' } as never);
        if (cmd === 'adb' && Array.isArray(args) && args.includes('getprop')) {
          return Promise.resolve({ stdout: '1' } as never);
        }
        return Promise.resolve({} as never);
      }) as never);
    });

    afterEach(() => {
      delete process.env['HB_API_PORT'];
      delete process.env['HB_EMULATOR_ADB_PORT'];
      delete process.env['HB_KVM_GID'];
      delete process.env['API_URL'];
      delete process.env['FRONTEND_URL'];
    });

    it('executes all steps in order', async () => {
      const callOrder: string[] = [];

      const hasArgument = (args: readonly string[] | undefined, argument: string): boolean =>
        Array.isArray(args) && args.includes(argument);

      const matchers: {
        cmd: string;
        argument?: string;
        label: string;
        result?: { stdout: string };
      }[] = [
        { cmd: 'stat', label: 'detect-kvm-gid', result: { stdout: '993' } },
        { cmd: 'docker', argument: 'info', label: 'check-docker' },
        { cmd: 'maestro', argument: '--version', label: 'check-maestro' },
        { cmd: 'docker', argument: '--profile', label: 'start-emulator' },
        { cmd: 'adb', argument: 'connect', label: 'adb-connect' },
        { cmd: 'adb', argument: 'getprop', label: 'wait-boot', result: { stdout: '1' } },
        { cmd: 'curl', label: 'health-check' },
        { cmd: 'pnpm', argument: 'build', label: 'build' },
        { cmd: 'npx', label: 'cap-sync' },
        { cmd: './gradlew', label: 'gradle' },
        { cmd: 'adb', argument: 'install', label: 'install-apk' },
        { cmd: 'adb', argument: 'disconnect', label: 'adb-disconnect' },
        { cmd: 'maestro', argument: 'test', label: 'run-maestro' },
      ];

      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        for (const matcher of matchers) {
          if (cmd === matcher.cmd && (!matcher.argument || hasArgument(args, matcher.argument))) {
            callOrder.push(matcher.label);
            if (matcher.result) return Promise.resolve(matcher.result as never);
          }
        }
        return Promise.resolve({} as never);
      }) as never);

      await main();

      expect(callOrder).toEqual([
        'check-docker',
        'check-maestro',
        'detect-kvm-gid',
        'start-emulator',
        'adb-connect',
        'wait-boot',
        'health-check',
        'build',
        'cap-sync',
        'gradle',
        'install-apk',
        'adb-disconnect',
        'adb-reconnect',
        'run-maestro',
      ]);
      // installAndroidSdk runs but only calls existsSync (no execa), so it won't appear in callOrder
    });

    it('stops execution if prerequisites fail', async () => {
      mockExeca.mockRejectedValueOnce(new Error('Docker not running'));

      await expect(main()).rejects.toThrow('Docker is not running');
    });
  });
});
