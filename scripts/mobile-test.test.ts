import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

const admZipFilters = vi.hoisted(() => ({
  captured: [] as ((filename: string) => boolean)[],
}));
// A shared timeline for the steps that must happen in a fixed order around a
// dist the guard reads. On the OTA path the archive lands inside the directory
// it archives, so verification has to read the directory before the archive is
// in it; on the APK path the guard has to read the dist before `cap sync`
// copies it into the native project.
const buildSteps = vi.hoisted(() => ({ order: [] as string[] }));
vi.mock('adm-zip', () => ({
  default: class {
    addLocalFolder(_dir: string, _prefix: string, filter?: (filename: string) => boolean): void {
      if (filter) admZipFilters.captured.push(filter);
    }
    writeZip(): void {
      buildSteps.order.push('zip');
    }
  },
}));

// The real lease writes into the repository's own runtime cache, which other
// agents' builds read. Recording pass-through keeps the span assertable without
// any test touching that file.
vi.mock('./lib/bundling/lease.js', () => ({
  withBuildLease: async <T>(
    _root: string,
    _resource: string,
    _holder: string,
    run: () => Promise<T>
  ): Promise<T> => {
    buildSteps.order.push('lease-acquired');
    try {
      return await run();
    } finally {
      buildSteps.order.push('lease-released');
    }
  },
}));

vi.mock('./verify-bundle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./verify-bundle.js')>();
  return {
    ...actual,
    verifyBundle: vi.fn(() => {
      buildSteps.order.push('verify');
      return Promise.resolve();
    }),
  };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    readdirSync: vi.fn((dir: string) => {
      if (dir === 'mobile-tests/flows') {
        return [
          '01-app-launch.yaml',
          '03-webview-renders.yaml',
          '04-back-button.yaml',
          '13-ota-update.yaml',
        ];
      }
      return actual.readdirSync(dir);
    }),
    readFileSync: vi.fn((file: string, _enc?: string) => {
      const filename = file.split('/').pop() ?? '';
      if (filename.startsWith('.wrangler-') && filename.endsWith('.log')) {
        // Default empty wrangler log; tests override with mockReturnValueOnce
        return '';
      }
      // getFailedFlowPaths reads each flow YAML to map the parsed `name:`
      // back to a file path. Mock returns a name derived from the basename.
      const nameMap: Record<string, string> = {
        '01-app-launch.yaml': 'App launches without crashing',
        '03-webview-renders.yaml': 'WebView renders',
        '04-back-button.yaml': 'Back button works',
        '13-ota-update.yaml': 'OTA update downloads and applies',
      };
      return `name: ${nameMap[filename] ?? filename}\n`;
    }),
    writeFileSync: vi.fn(),
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// The slice reader opens and seeks the debug log itself, so it is stubbed here
// and exercised for real in its own test. What this file owns is the wiring:
// which file writeApiSlice points the reader at, and that what comes back is
// what lands on disk.
vi.mock('./lib/mobile/extract-mobile-api-log.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/mobile/extract-mobile-api-log.js')>();
  return {
    ...actual,
    readRunApiSlice: vi.fn(() => 'slice text'),
  };
});

// The real verifier hashes the downloaded file, which these tests never write:
// the download is a mocked curl. The pins stay real, so what is fetched and what
// it is checked against are the shipped values.
vi.mock('./lib/mobile/pinned-archives.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/mobile/pinned-archives.js')>();
  return { ...actual, verifyArchive: vi.fn() };
});

vi.mock('./lib/mobile/mobile-image.js', async () => {
  // Keep the real detectKvmGid and runEmulatorContainer (they shell out via
  // the mocked execa and fs/promises stat). Only stub bakeImage so tests
  // never trigger an actual image build / pull cascade.
  const actual = await vi.importActual<typeof import('./lib/mobile/mobile-image.js')>(
    './lib/mobile/mobile-image.js'
  );
  return {
    ...actual,
    bakeImage: vi.fn(() => Promise.resolve('ghcr.io/lome-ai/hushbox-android-emulator:testtag')),
  };
});

import { execa } from 'execa';
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { MIN_LINES_FOR_DOCUMENT } from '@hushbox/shared/documents';
import { verifyBundle } from './verify-bundle.js';

import { bakeImage } from './lib/mobile/mobile-image.js';
import {
  CMDLINE_TOOLS_ARCHIVE,
  MAESTRO_ARCHIVE,
  MAESTRO_VERSION,
  verifyArchive,
} from './lib/mobile/pinned-archives.js';
import {
  COMMAND_LINE,
  parseFailedFlowNames,
  installAndroidSdk,
  installMaestro,
  checkPrerequisites,
  stopEmulators,
  stopEmulator,
  startEmulators,
  startEmulator,
  adbPortForShard,
  startDevApi,
  buildApk,
  installApk,
  installApks,
  resetVersionOverride,
  configureAppLinks,
  configureAllAppLinks,
  runMaestroOnShard,
  runMaestroShards,
  runMaestroOta,
  setupOtaUpdate,
  stopDevApi,
  startSandboxOrigin,
  stopSandboxOrigin,
  seedDocumentConversation,
  withMobileTestRun,
  writeApiSlice,
  dumpApiLogTail,
  APK_APP_VERSION,
  API_SLICE_PATH,
  main,
} from './mobile-test.js';
import {
  INPUT_CHAR_WEIGHT,
  flowWeight,
  listFlowsForRun,
  partitionByWeight,
} from './lib/mobile/flows.js';
import { requireEnv } from './lib/mobile/required-env.js';
import { containerNameForShard, debugOutputForShard } from './lib/mobile/shards.js';
import {
  documentSeedPayload,
  DOCUMENT_SEED_OWNER_EMAIL,
  DOCUMENT_SEED_MESSAGE,
} from './lib/mobile/document-seed.js';
import { parseCommandLine } from './lib/cli/command-line.js';
import { withScratchDirectory } from './lib/scratch-directory.js';
import { wranglerPersistPath } from './wrangler-dev.js';
import { stackModeFrom } from './with-env.js';
import { recordOwnedResource } from './lib/claims/ownership.js';
import { RUN_CLAIM_ENV, enumerateClaims, registerRun } from './lib/claims/registry.js';
import { emulatorContainerName } from './lib/mobile/emulator-container.js';
import { closeProcessLifeline } from './lib/spawn/long-lived.js';
import { MARKER_PREFIX, readRunApiSlice } from './lib/mobile/extract-mobile-api-log.js';
import { SLOTS, portFor } from './lib/stack/port-plan.js';
import type { LongLivedChild } from './lib/spawn/long-lived.js';

/** Where a shard's emulator answers, read from the allocator rather than restated. */
function adbHost(shard: number): string {
  return `localhost:${String(adbPortForShard(shard))}`;
}
import type { MockInstance } from 'vitest';

const mockExeca = vi.mocked(execa);
const mockExistsSync = vi.mocked(existsSync);
const mockReadFileSync = vi.mocked(readFileSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockAppendFileSync = vi.mocked(appendFileSync);
const mockBakeImage = vi.mocked(bakeImage);
const mockVerifyBundle = vi.mocked(verifyBundle);
const mockReadRunApiSlice = vi.mocked(readRunApiSlice);
const mockVerifyArchive = vi.mocked(verifyArchive);

// execa returns a subprocess handle that is also a promise, wrapping the
// runtime process it exposes separately. The long-lived spawner reads a pid off
// the handle before the caller waits for readiness, so a subprocess without one
// is a child that never started; it reads the streams the child was handed, and
// it takes the status the child already carries — neither a code nor a signal,
// for a child that has not ended — and the child's own exit event off the
// runtime process, rather than the handle's resolution, which waits for every
// stream to end as well.
function mockSubprocess(value: unknown = {}): never {
  return Object.assign(Promise.resolve(value as never), {
    pid: 4321,
    kill: vi.fn(),
    stdio: [null, null, null],
    nodeChildProcess: {
      exitCode: null,
      signalCode: null,
      on: (event: string, handler: (code: number | null) => void): void => {
        if (event !== 'exit') return;
        setImmediate(() => {
          handler(0);
        });
      },
    },
  }) as never;
}

/** A handle as `spawnLongLived` hands one back, for the stop paths. */
function fakeLongLivedChild(kill: () => Promise<number>): LongLivedChild {
  return { pid: 4321, pgid: 4321, exit: Promise.resolve(0), kill };
}

// Mirrors the readiness probes in `checkBootCompleted`: adb connect and any
// `getprop` (sys.boot_completed and service.bootanim.exit both want '1').
// Returning null lets callers chain their own dispatch logic for non-readiness
// calls.
function bootReadinessMock(cmd: string, args: readonly string[]): { stdout: string } | null {
  if (cmd !== 'adb') return null;
  if (args.includes('connect')) return { stdout: `connected to ${adbHost(0)}` };
  if (args.includes('getprop')) return { stdout: '1' };
  return null;
}

/**
 * The ports a run claimed while `body` ran, read from a registry of its own so
 * the machine-wide one is untouched.
 */
async function portsClaimedDuring(body: () => Promise<unknown>): Promise<string[]> {
  const registryDir = await mkdtemp(path.join(os.tmpdir(), 'mobile-test-claim-'));
  try {
    const claims = await registerRun(
      {
        command: 'pnpm mobile:test',
        mode: 'development',
        slot: 0,
        gitCommonDir: path.join(registryDir, 'checkout', '.git'),
        registryDir,
      },
      async () => {
        await body();
        return enumerateClaims(registryDir);
      }
    );
    return (claims[0]?.claim.resources ?? [])
      .filter((resource) => resource.kind === 'port')
      .map((resource) => resource.id);
  } finally {
    await rm(registryDir, { recursive: true, force: true });
  }
}

/**
 * The socket this worker answers its children on goes when the file that made
 * it is done, rather than staying until the runner signals the worker — which
 * reaches no handler and would leave the file behind.
 */
afterAll(async () => {
  await closeProcessLifeline();
});

describe('mobile-test script', () => {
  let savedStackSlot: string | undefined;
  let savedSandboxPort: string | undefined;
  let logSpy: MockInstance<typeof console.log>;

  beforeEach(() => {
    vi.clearAllMocks();
    // A test process inherits its pnpm invocation's run claim, and this file
    // spawns through the real spawner over a mocked execa: without this the
    // fixture's stand-in pid is recorded against the machine-wide claim of the
    // run executing these tests, where a reclaimer would later signal it.
    vi.stubEnv(RUN_CLAIM_ENV, '');
    mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
    mockExistsSync.mockReturnValue(true);
    mockBakeImage.mockResolvedValue('ghcr.io/lome-ai/hushbox-android-emulator:testtag');
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    // with-env.ts loads the generated env, whose slot is whatever this checkout
    // holds. Pin it so shard ports are deterministic; the tests that exercise
    // the fail-fast override it. Restore the original after each test.
    savedStackSlot = process.env['HB_STACK_SLOT'];
    process.env['HB_STACK_SLOT'] = '0';
    // Adb-reverse and the sandbox-origin server require HB_SANDBOX_PORT; pin it
    // to the canonical base so tests are deterministic (fail-fast tests delete it).
    savedSandboxPort = process.env['HB_SANDBOX_PORT'];
    process.env['HB_SANDBOX_PORT'] = '7400';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (savedStackSlot === undefined) {
      delete process.env['HB_STACK_SLOT'];
    } else {
      process.env['HB_STACK_SLOT'] = savedStackSlot;
    }
    if (savedSandboxPort === undefined) {
      delete process.env['HB_SANDBOX_PORT'];
    } else {
      process.env['HB_SANDBOX_PORT'] = savedSandboxPort;
    }
  });

  // Once per file rather than per test: the runner restores stubs before each
  // test and never after the last one, so the claim this file blanks in setup
  // outlives the file without a final restore. It cannot live in the per-test
  // teardown above, which the runner runs after every nested per-test teardown
  // in the file — one of those throwing skips it entirely.
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  /**
   * Runs `body` as a registered run in a scratch registry of its own. Starting
   * an emulator records the container against the enclosing run's claim and
   * refuses without one, and the claim this file inherited is cleared above, so
   * this is where such a record goes and nothing reads that registry again.
   */
  function inOwnRun<T>(body: () => Promise<T>): Promise<T> {
    return withScratchDirectory('hushbox-mobile-run-', (registryDir) =>
      registerRun(
        {
          command: 'pnpm mobile:test',
          mode: 'development',
          slot: 0,
          gitCommonDir: path.join(path.sep, 'checkout', '.git'),
          registryDir,
        },
        body
      )
    );
  }

  describe('command line', () => {
    it('reads the smoke set as off by default', () => {
      const parsed = parseCommandLine(COMMAND_LINE, []);
      expect(parsed.kind === 'run' && parsed.flags['--smoke']).toBe(false);
    });

    it('reads --smoke as on', () => {
      const parsed = parseCommandLine(COMMAND_LINE, ['--smoke']);
      expect(parsed.kind === 'run' && parsed.flags['--smoke']).toBe(true);
    });

    it('refuses a flag it does not recognise', () => {
      expect(() => parseCommandLine(COMMAND_LINE, ['--smoke', '--flag'])).toThrow(/--flag/);
    });
  });

  describe('requireEnv', () => {
    afterEach(() => {
      delete process.env['HB_MOBILE_TEST_PROBE'];
    });

    it('returns the value when the variable is set', () => {
      process.env['HB_MOBILE_TEST_PROBE'] = 'some-value';

      expect(requireEnv('HB_MOBILE_TEST_PROBE')).toBe('some-value');
    });

    it('throws naming the variable when it is missing', () => {
      delete process.env['HB_MOBILE_TEST_PROBE'];

      expect(() => requireEnv('HB_MOBILE_TEST_PROBE')).toThrow('HB_MOBILE_TEST_PROBE not set.');
    });

    it('appends the hint to the error message when provided', () => {
      delete process.env['HB_MOBILE_TEST_PROBE'];

      expect(() => requireEnv('HB_MOBILE_TEST_PROBE', 'Run pnpm generate:env first.')).toThrow(
        'HB_MOBILE_TEST_PROBE not set. Run pnpm generate:env first.'
      );
    });

    it('treats an empty string as missing', () => {
      process.env['HB_MOBILE_TEST_PROBE'] = '';

      expect(() => requireEnv('HB_MOBILE_TEST_PROBE')).toThrow('HB_MOBILE_TEST_PROBE not set.');
    });
  });

  describe('shard helpers', () => {
    it('adbPortForShard takes each shard from the allocator lane that shard owns', () => {
      process.env['HB_STACK_SLOT'] = '4';

      for (const shard of [0, 1]) {
        expect(adbPortForShard(shard)).toBe(
          portFor('emulatorAdb', { slot: 4, mode: 'development', lane: shard })
        );
      }
    });

    it('adbPortForShard puts a whole block between shards, so no two slots share a port', () => {
      process.env['HB_STACK_SLOT'] = '4';

      expect(adbPortForShard(1) - adbPortForShard(0)).toBe(SLOTS);
    });

    it('adbPortForShard refuses a slot the generator never wrote', () => {
      process.env['HB_STACK_SLOT'] = 'not-a-slot';

      expect(() => adbPortForShard(0)).toThrow('HB_STACK_SLOT');
    });

    it('containerNameForShard names the shard inside the slot the port comes from', () => {
      process.env['HB_STACK_SLOT'] = '4';

      expect(containerNameForShard(0)).toBe(emulatorContainerName(4, 0));
      expect(containerNameForShard(3)).toBe(emulatorContainerName(4, 3));
    });

    it('containerNameForShard gives two slots different names for one shard', () => {
      process.env['HB_STACK_SLOT'] = '3';
      const onThree = containerNameForShard(0);
      process.env['HB_STACK_SLOT'] = '7';

      expect(containerNameForShard(0)).not.toBe(onThree);
    });

    it('containerNameForShard refuses a slot the generator never wrote', () => {
      process.env['HB_STACK_SLOT'] = 'not-a-slot';

      expect(() => containerNameForShard(0)).toThrow('HB_STACK_SLOT');
    });

    it('debugOutputForShard nests under maestro-results', () => {
      expect(debugOutputForShard(0)).toBe('maestro-results/shard-0');
      expect(debugOutputForShard(2)).toBe('maestro-results/shard-2');
    });
  });

  describe('flowWeight', () => {
    it('counts top-level steps after the --- separator', () => {
      const yaml = [
        'appId: x',
        'name: n',
        'tags:',
        '  - smoke',
        '---',
        '- launchApp:',
        '    clearState: true',
        '- back',
        '- assertVisible: Hi',
      ].join('\n');
      expect(flowWeight(yaml)).toBe(3);
    });

    it('adds weight for literal inputText characters', () => {
      const yaml = ['---', "- inputText: 'TestKeys'"].join('\n');
      expect(flowWeight(yaml)).toBe(1 + 8 * INPUT_CHAR_WEIGHT);
    });

    it('resolves ${VAR} inputText against the flow env block', () => {
      const yaml = ['env:', '  TEST_USERNAME: tmu', '---', '- inputText: ${TEST_USERNAME}'].join(
        '\n'
      );
      expect(flowWeight(yaml)).toBe(1 + 3 * INPUT_CHAR_WEIGHT);
    });

    it('falls back to the token length when a var is unresolved', () => {
      const yaml = ['---', '- inputText: ${MISSING}'].join('\n');
      expect(flowWeight(yaml)).toBe(1 + '${MISSING}'.length * INPUT_CHAR_WEIGHT);
    });

    it('returns 0 for content with no step separator', () => {
      expect(flowWeight('name: just a name\n')).toBe(0);
    });
  });

  describe('partitionByWeight', () => {
    it('balances total weight while keeping equal counts', () => {
      const w = (f: string): number => ({ a: 10, b: 1, c: 9, d: 2 })[f] ?? 0;
      // heaviest-first a(10),c(9),d(2),b(1); caps [2,2] → loads 11/11
      expect(partitionByWeight(['a', 'b', 'c', 'd'], 2, w)).toEqual([
        ['a', 'b'],
        ['c', 'd'],
      ]);
    });

    it('honors the count cap even when one shard is far heavier', () => {
      const w = (f: string): number => ({ a: 100, b: 1, c: 1, d: 1 })[f] ?? 0;
      const result = partitionByWeight(['a', 'b', 'c', 'd'], 2, w);
      expect(result.map((s) => s.length)).toEqual([2, 2]);
    });

    it('produces n buckets even when n > flows', () => {
      expect(partitionByWeight(['a', 'b'], 4, () => 1)).toEqual([['a'], ['b'], [], []]);
    });

    it('returns one bucket for n=1', () => {
      expect(partitionByWeight(['a', 'b', 'c'], 1, () => 1)).toEqual([['a', 'b', 'c']]);
    });

    it('returns n empty buckets for empty flows', () => {
      expect(partitionByWeight([], 3, () => 1)).toEqual([[], [], []]);
    });
  });

  describe('listFlowsForRun', () => {
    it('returns smoke subset when smoke=true', () => {
      const flows = listFlowsForRun(true);
      expect(flows).toEqual([
        'mobile-tests/flows/01-app-launch.yaml',
        'mobile-tests/flows/03-webview-renders.yaml',
      ]);
    });

    it('names only smoke flow files that exist on disk', async () => {
      // The smoke subset is a hardcoded list while the full run globs the flow
      // directory, so a deleted flow leaves a dangling path only this list can
      // carry, and only a real filesystem read can catch.
      const { existsSync: onDisk } = await vi.importActual<typeof import('node:fs')>('node:fs');
      const repoRoot = path.resolve(import.meta.dirname, '..');
      const missing = listFlowsForRun(true).filter((flow) => !onDisk(path.join(repoRoot, flow)));
      expect(missing).toEqual([]);
    });

    it('excludes OTA flow from full run', () => {
      const flows = listFlowsForRun(false);
      expect(flows).not.toContain('mobile-tests/flows/13-ota-update.yaml');
      expect(flows).toContain('mobile-tests/flows/01-app-launch.yaml');
    });
  });

  describe('parseFailedFlowNames', () => {
    it('extracts failed flow names from maestro output', () => {
      const output = [
        '[Passed] App launches without crashing (10s)',
        '[Failed] Keyboard appears and input remains visible (33s) (Assertion is false: "Sign up" is visible)',
        '[Passed] Push notification permission dialog appears (7s)',
      ].join('\n');

      expect(parseFailedFlowNames(output)).toEqual(['Keyboard appears and input remains visible']);
    });

    it('returns empty array when no failures', () => {
      const output = '[Passed] App launches without crashing (10s)\n[Passed] Another flow (5s)';
      expect(parseFailedFlowNames(output)).toEqual([]);
    });

    it('extracts multiple failed flow names', () => {
      const output = [
        '[Failed] Flow A (10s) (some reason)',
        '[Passed] Flow B (5s)',
        '[Failed] Flow C (20s) (another reason)',
      ].join('\n');

      expect(parseFailedFlowNames(output)).toEqual(['Flow A', 'Flow C']);
    });

    it('extracts failed flow names with multi-minute durations', () => {
      const output = [
        '[Passed] App launches without crashing (13s)',
        '[Failed] Keyboard appears and input remains visible (2m 32s)',
        '[Passed] Message list scrolls correctly (50s)',
      ].join('\n');

      expect(parseFailedFlowNames(output)).toEqual(['Keyboard appears and input remains visible']);
    });
  });

  describe('assertLinux', () => {
    it('does not throw on linux', async () => {
      const { assertLinux } = await import('./mobile-test.js');
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
      try {
        expect(() => {
          assertLinux();
        }).not.toThrow();
      } finally {
        spy.mockRestore();
      }
    });

    it('throws on darwin with a clear message', async () => {
      const { assertLinux } = await import('./mobile-test.js');
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
      try {
        expect(() => {
          assertLinux();
        }).toThrow(/Linux-only/);
      } finally {
        spy.mockRestore();
      }
    });

    it('throws on win32 with a clear message', async () => {
      const { assertLinux } = await import('./mobile-test.js');
      const spy = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      try {
        expect(() => {
          assertLinux();
        }).toThrow(/Linux-only/);
      } finally {
        spy.mockRestore();
      }
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
    const pinnedHome = (): string => path.join(requireEnv('HOME'), '.maestro', MAESTRO_VERSION);
    /** No pinned install on disk, and no `maestro` of any version on PATH either. */
    const pinnedBinaryAbsent = (): void => {
      mockExistsSync.mockImplementation(
        ((file: string) => file !== path.join(pinnedHome(), 'bin', 'maestro')) as never
      );
      mockExeca.mockImplementation(((command: string) =>
        command === 'maestro'
          ? Promise.reject(new Error('not found'))
          : Promise.resolve({ exitCode: 0, stdout: '' })) as never);
    };
    const callsTo = (command: string): unknown[][] =>
      mockExeca.mock.calls.filter((call) => call[0] === command);
    const firstCallTo = (command: string): number => {
      const index = mockExeca.mock.calls.findIndex((call) => call[0] === command);
      return mockExeca.mock.invocationCallOrder[index] ?? Number.NaN;
    };
    let savedPath: string | undefined;

    beforeEach(() => {
      savedPath = process.env['PATH'];
    });

    afterEach(() => {
      process.env['PATH'] = savedPath;
    });

    it('downloads nothing when the pinned version is already installed', async () => {
      await installMaestro();

      expect(callsTo('curl')).toEqual([]);
    });

    it('puts the pinned version on PATH when it is already installed', async () => {
      await installMaestro();

      expect(process.env['PATH']?.split(path.delimiter)[0]).toBe(path.join(pinnedHome(), 'bin'));
    });

    it('downloads the pinned release asset when the pinned version is absent', async () => {
      pinnedBinaryAbsent();

      await installMaestro();

      expect(callsTo('curl')).toEqual([
        [
          'curl',
          ['-fsSL', '-o', expect.stringMatching(/maestro\.zip$/), MAESTRO_ARCHIVE.url],
          { stdio: 'inherit' },
        ],
      ]);
    });

    it('never runs the vendor install script', async () => {
      pinnedBinaryAbsent();

      await installMaestro();

      expect(JSON.stringify(mockExeca.mock.calls)).not.toContain('get.maestro.mobile.dev');
    });

    it('checks the download against the pinned digest', async () => {
      pinnedBinaryAbsent();

      await installMaestro();

      const download = callsTo('curl')[0]?.[1] as string[];
      expect(mockVerifyArchive).toHaveBeenCalledWith(download[2], MAESTRO_ARCHIVE);
    });

    it('checks the digest before unpacking', async () => {
      pinnedBinaryAbsent();
      const order: string[] = [];
      mockVerifyArchive.mockImplementation(() => {
        order.push('verify');
      });
      mockExeca.mockImplementation(((command: string) => {
        if (command === 'maestro') return Promise.reject(new Error('not found'));
        if (command === 'unzip') order.push('unzip');
        return Promise.resolve({ exitCode: 0, stdout: '' });
      }) as never);

      await installMaestro();

      expect(order).toEqual(['verify', 'unzip']);
    });

    it('unpacks nothing when the download fails its digest', async () => {
      pinnedBinaryAbsent();
      mockVerifyArchive.mockImplementationOnce(() => {
        throw new Error('checksum mismatch');
      });

      await expect(installMaestro()).rejects.toThrow('checksum mismatch');
      expect(callsTo('unzip')).toEqual([]);
    });

    it('moves the unpacked tree into the pinned version directory last', async () => {
      pinnedBinaryAbsent();

      await installMaestro();

      const moves = callsTo('mv');
      expect(moves).toEqual([['mv', [expect.stringMatching(/maestro$/), pinnedHome()]]]);
      expect(firstCallTo('mv')).toBeGreaterThan(firstCallTo('unzip'));
    });

    it('throws when HOME is not set', async () => {
      const savedHome = process.env['HOME'];
      delete process.env['HOME'];

      try {
        await expect(installMaestro()).rejects.toThrow('HOME not set');
      } finally {
        if (savedHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = savedHome;
      }
    });

    it('throws when PATH is not set', async () => {
      delete process.env['PATH'];

      await expect(installMaestro()).rejects.toThrow('PATH not set');
    });
  });

  describe('installAndroidSdk', () => {
    let savedPath: string | undefined;

    beforeEach(() => {
      savedPath = process.env['PATH'];
    });

    afterEach(() => {
      delete process.env['ANDROID_HOME'];
      process.env['PATH'] = savedPath;
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

    it('downloads the pinned command-line tools archive', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockImplementation(((p: string) => !p.includes('android-36')) as never);

      await installAndroidSdk();

      expect(mockExeca).toHaveBeenCalledWith(
        'curl',
        expect.arrayContaining([CMDLINE_TOOLS_ARCHIVE.url]),
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('checks the command-line tools download against the pinned digest', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockImplementation(((p: string) => !p.includes('android-36')) as never);

      await installAndroidSdk();

      expect(mockVerifyArchive).toHaveBeenCalledWith(
        '/tmp/cmdline-tools.zip', // eslint-disable-line sonarjs/publicly-writable-directories -- /tmp is standard for CI SDK downloads
        CMDLINE_TOOLS_ARCHIVE
      );
    });

    it('unpacks no command-line tools download that fails its digest', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockImplementation(((p: string) => !p.includes('android-36')) as never);
      mockVerifyArchive.mockImplementationOnce(() => {
        throw new Error('checksum mismatch');
      });

      await expect(installAndroidSdk()).rejects.toThrow('checksum mismatch');
      expect(mockExeca.mock.calls.filter((call) => call[0] === 'unzip')).toEqual([]);
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

    it('adds platform-tools to PATH when ANDROID_HOME is set', async () => {
      process.env['ANDROID_HOME'] = '/opt/android-sdk';
      mockExistsSync.mockReturnValue(true);

      await installAndroidSdk();

      expect(process.env['PATH']).toContain('/opt/android-sdk/platform-tools');
    });

    it('adds platform-tools to PATH when using default SDK location', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockReturnValue(true);

      await installAndroidSdk();

      expect(process.env['PATH']).toContain('Android/Sdk/platform-tools');
    });

    it('adds platform-tools to PATH after fresh install', async () => {
      delete process.env['ANDROID_HOME'];
      mockExistsSync.mockImplementation(((p: string) => !p.includes('android-36')) as never);

      await installAndroidSdk();

      expect(process.env['PATH']).toContain('Android/Sdk/platform-tools');
    });

    it('throws when PATH is not set after fresh install', async () => {
      delete process.env['ANDROID_HOME'];
      delete process.env['PATH'];
      mockExistsSync.mockImplementation(((p: string) => !p.includes('android-36')) as never);

      await expect(installAndroidSdk()).rejects.toThrow('PATH not set');
    });

    it('throws when HOME is not set and ANDROID_HOME is missing', async () => {
      const savedHome = process.env['HOME'];
      delete process.env['ANDROID_HOME'];
      delete process.env['HOME'];
      mockExistsSync.mockReturnValue(true);

      try {
        await expect(installAndroidSdk()).rejects.toThrow('HOME not set');
      } finally {
        if (savedHome === undefined) delete process.env['HOME'];
        else process.env['HOME'] = savedHome;
      }
    });
  });

  describe('startEmulator', () => {
    const emulatorMock = ((cmd: string, args?: readonly string[]) => {
      const probe = bootReadinessMock(cmd, Array.isArray(args) ? args : []);
      if (probe) return Promise.resolve(probe as never);
      // Default for any other docker/adb call in this mock.
      return Promise.resolve({ stdout: '' } as never);
    }) as never;

    beforeEach(() => {
      process.env['HB_API_PORT'] = '8787';
    });

    afterEach(() => {
      delete process.env['HB_API_PORT'];
    });

    it('runs docker container with privileged mode and KVM device', async () => {
      mockExeca.mockImplementation(emulatorMock);

      await inOwnRun(() => startEmulator(0, 'test-image', '993'));

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining([
          'run',
          '-d',
          '--privileged',
          '--name',
          containerNameForShard(0),
          '--device',
          '/dev/kvm',
          '--group-add',
          '993',
        ]),
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('publishes shard 1 on the host port its own allocator lane owns', async () => {
      mockExeca.mockImplementation(emulatorMock);

      await inOwnRun(() => startEmulator(1, 'test-image', '993'));

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['-p', `${String(adbPortForShard(1))}:5555`]),
        expect.anything()
      );
    });

    it('connects adb to the shard-specific port', async () => {
      mockExeca.mockImplementation(emulatorMock);

      await inOwnRun(() => startEmulator(0, 'test-image', '993'));

      expect(mockExeca).toHaveBeenCalledWith('adb', ['connect', adbHost(0)], {
        stdio: 'pipe',
      });
    });

    it('polls for boot completion', async () => {
      let pollCount = 0;
      function sysBootCompletedResponse(): Promise<unknown> {
        pollCount++;
        if (pollCount < 3) return Promise.reject(new Error('not ready'));
        return Promise.resolve({ stdout: '1' });
      }
      function dispatchPollCall(cmd: string, args: readonly string[]): Promise<unknown> {
        if (cmd === 'docker' && args.includes('run')) {
          return Promise.resolve({ stdout: 'container-id' });
        }
        if (cmd === 'adb' && args.includes('getprop') && args.includes('sys.boot_completed')) {
          return sysBootCompletedResponse();
        }
        const probe = bootReadinessMock(cmd, args);
        if (probe) return Promise.resolve(probe);
        return Promise.resolve({ stdout: '' });
      }
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) =>
        dispatchPollCall(cmd, Array.isArray(args) ? args : [])) as never);

      await inOwnRun(() => startEmulator(0, 'test-image', '993'));

      expect(pollCount).toBe(3);
    });

    it('asks what holds the shard name before it starts anything', async () => {
      mockExeca.mockImplementation(emulatorMock);

      await inOwnRun(() => startEmulator(0, 'test-image', '993'));

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['ps', '-a', '--filter', `name=^${containerNameForShard(0)}$`])
      );
    });

    it('removes no container when nothing carries the shard name', async () => {
      mockExeca.mockImplementation(emulatorMock);

      await inOwnRun(() => startEmulator(0, 'test-image', '993'));

      const removals = mockExeca.mock.calls.filter(
        (call) => call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'rm'
      );
      expect(removals).toEqual([]);
    });

    /**
     * Drives the boot poll loop with scripted per-call responses: `connects`
     * and `getprops` are consumed one entry per adb connect / getprop call;
     * the last entry repeats. A response can be an Error (or any thrown
     * value) to exercise the failure paths.
     */
    function scriptBootSequence(
      connects: unknown[],
      getprops: unknown[],
      options?: { failDisconnect?: boolean }
    ): void {
      let connectIndex = 0;
      let getpropIndex = 0;
      function next(script: unknown[], index: number): Promise<unknown> {
        const entry = script[Math.min(index, script.length - 1)];
        if (entry instanceof Error || typeof entry === 'string') {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- string rejections exercise extractErrorDetail's non-Error String(error) fallback
          return Promise.reject(entry);
        }
        return Promise.resolve(entry);
      }
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        const argumentList = Array.isArray(args) ? args : [];
        if (cmd === 'adb' && argumentList.includes('connect')) {
          return next(connects, connectIndex++);
        }
        if (cmd === 'adb' && argumentList.includes('getprop')) {
          return next(getprops, getpropIndex++);
        }
        if (cmd === 'adb' && argumentList[0] === 'disconnect' && options?.failDisconnect) {
          return Promise.reject(new Error('no such device'));
        }
        return Promise.resolve({ stdout: '' });
      }) as never);
    }

    it('clears a stale offline adb entry before reconnecting', async () => {
      scriptBootSequence(
        [
          { stdout: 'failed to connect: device offline' },
          { stdout: 'unable to connect' },
          { stdout: `connected to ${adbHost(0)}` },
        ],
        [{ stdout: '1' }],
        // The stale entry's disconnect itself failing must not abort the poll.
        { failDisconnect: true }
      );

      await inOwnRun(() => startEmulator(0, 'test-image', '993'));

      expect(mockExeca).toHaveBeenCalledWith('adb', ['disconnect', adbHost(0)], {
        stdio: 'pipe',
      });
      expect(mockExeca).toHaveBeenCalledWith('adb', [
        '-s',
        adbHost(0),
        'reverse',
        'tcp:8787',
        'tcp:8787',
      ]);
    }, 30_000);

    it('also reverses the sandbox port so the WebView can reach the sandbox origin', async () => {
      scriptBootSequence([{ stdout: `connected to ${adbHost(0)}` }], [{ stdout: '1' }]);

      await inOwnRun(() => startEmulator(0, 'test-image', '993'));

      expect(mockExeca).toHaveBeenCalledWith('adb', [
        '-s',
        adbHost(0),
        'reverse',
        'tcp:7400',
        'tcp:7400',
      ]);
    }, 30_000);

    it('logs boot progress only at the diagnostic interval', async () => {
      scriptBootSequence(
        [{ stdout: `connected to ${adbHost(0)}` }],
        [{ stdout: '0' }, { stdout: '0' }, { stdout: '1' }]
      );

      await inOwnRun(() => startEmulator(0, 'test-image', '993'));

      const progressLogs = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes("sys.boot_completed not yet '1'"));
      expect(progressLogs).toHaveLength(1);
    }, 30_000);

    it('reconnects when the device drops offline mid-boot', async () => {
      scriptBootSequence(
        [{ stdout: `connected to ${adbHost(0)}` }],
        [
          Object.assign(new Error('adb failed'), { stderr: 'error: device offline' }),
          Object.assign(new Error('adb failed'), { stderr: 'error: device offline' }),
          Object.assign(new Error('adb failed'), { stderr: 'protocol fault' }),
          { stdout: '1' },
        ]
      );

      await inOwnRun(() => startEmulator(0, 'test-image', '993'));

      const disconnects = mockExeca.mock.calls.filter(
        (call) => call[0] === 'adb' && Array.isArray(call[1]) && call[1][0] === 'disconnect'
      );
      expect(disconnects).toHaveLength(2);
    }, 30_000);

    it('logs connection errors thrown by adb itself only at the diagnostic interval', async () => {
      scriptBootSequence(
        ['socket hangup', 'socket hangup', { stdout: `connected to ${adbHost(0)}` }],
        [{ stdout: '1' }]
      );

      await inOwnRun(() => startEmulator(0, 'test-image', '993'));

      const errorLogs = logSpy.mock.calls
        .map((call) => String(call[0]))
        .filter((line) => line.includes('error: socket hangup'));
      expect(errorLogs).toHaveLength(1);
    }, 30_000);
  });

  describe('startEmulators', () => {
    beforeEach(() => {
      process.env['HB_API_PORT'] = '8787';
    });

    afterEach(() => {
      delete process.env['HB_API_PORT'];
    });

    it('starts n emulators in parallel with distinct container names', async () => {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        const probe = bootReadinessMock(cmd, Array.isArray(args) ? args : []);
        if (probe) return Promise.resolve(probe as never);
        return Promise.resolve({ stdout: '' } as never);
      }) as never);

      await inOwnRun(() => startEmulators(2, 'test-image'));

      // detectKvmGid uses fs.stat directly (not execa) — verified by the
      // fact that docker run still fires N times, since startEmulator only
      // proceeds after gid resolution.
      const runCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'docker' && Array.isArray(c[1]) && c[1].includes('run')
      );
      expect(runCalls).toHaveLength(2);
      const names = runCalls.map(
        (c) => (c[1] as string[])[(c[1] as string[]).indexOf('--name') + 1]
      );
      expect(names).toContain(containerNameForShard(0));
      expect(names).toContain(containerNameForShard(1));
    });

    it('propagates rejection when any shard fails to start', async () => {
      // Shard 0's docker run succeeds; shard 1's rejects. Promise.all rejects
      // immediately — the caller (main()) relies on this to break out of
      // boot-time work and trigger its finally-block cleanup.
      // We use a no-op setTimeout to skip the 2s boot-poll sleeps; without
      // it shard 0 hangs polling for ~4 minutes after shard 1 rejects.
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((function_: () => void) => {
        function_();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
      try {
        mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
          const argumentList = Array.isArray(args) ? args : [];
          if (
            cmd === 'docker' &&
            argumentList.includes('run') &&
            argumentList.includes(containerNameForShard(1))
          ) {
            return Promise.reject(new Error('docker run failed for shard 1'));
          }
          if (cmd === 'adb' && argumentList.includes('connect')) {
            return Promise.resolve({ stdout: `connected to ${adbHost(0)}` } as never);
          }
          if (cmd === 'adb' && argumentList.includes('getprop')) {
            return Promise.resolve({ stdout: '1' } as never);
          }
          return Promise.resolve({ stdout: '' } as never);
        }) as never);

        await expect(inOwnRun(() => startEmulators(2, 'test-image'))).rejects.toThrow(/shard 1/);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    });
  });

  describe('startDevApi', () => {
    it('reuses an existing healthy API and returns null apiProcess', async () => {
      process.env['HB_API_PORT'] = '8787';
      try {
        const handle = await startDevApi();
        expect(mockExeca).toHaveBeenCalledWith('curl', ['-sf', 'http://localhost:8787/health'], {
          stdio: 'ignore',
        });
        expect(handle.apiProcess).toBeNull();
        const apiDevCalls = mockExeca.mock.calls.filter(
          (call) =>
            call[0] === 'pnpm' &&
            Array.isArray(call[1]) &&
            call[1].includes('--filter') &&
            call[1].includes('@hushbox/api')
        );
        expect(apiDevCalls).toHaveLength(0);
      } finally {
        delete process.env['HB_API_PORT'];
      }
    });

    it('spawns the API dev server in its own process group when API is not ready', async () => {
      process.env['HB_API_PORT'] = '8787';
      let healthCheckCount = 0;
      mockExeca.mockImplementation(((cmd: string, _args?: readonly string[]) => {
        if (cmd === 'curl') {
          healthCheckCount++;
          if (healthCheckCount === 1) return Promise.reject(new Error('not running'));
          return mockSubprocess();
        }
        return mockSubprocess();
      }) as never);
      try {
        const handle = await startDevApi();
        expect(handle.apiProcess).not.toBeNull();
        expect(mockExeca).toHaveBeenCalledWith(
          'pnpm',
          ['--filter', '@hushbox/api', 'dev'],
          expect.objectContaining({
            stdio: ['ignore', 'ignore', 'ignore'],
            detached: true,
          })
        );
      } finally {
        delete process.env['HB_API_PORT'];
      }
    });

    it('claims the API port against the run before it starts the server that binds it', async () => {
      process.env['HB_API_PORT'] = '8787';
      let healthCheckCount = 0;
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'curl') {
          healthCheckCount++;
          if (healthCheckCount === 1) return Promise.reject(new Error('not running'));
          return mockSubprocess();
        }
        return mockSubprocess();
      }) as never);
      try {
        expect(await portsClaimedDuring(() => startDevApi())).toContain('8787');
      } finally {
        delete process.env['HB_API_PORT'];
      }
    });

    it('does not crash when the spawned dev subprocess dies immediately', async () => {
      process.env['HB_API_PORT'] = '8787';
      let healthCheckCount = 0;
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'curl') {
          healthCheckCount++;
          if (healthCheckCount === 1) return Promise.reject(new Error('not running'));
          return mockSubprocess();
        }
        return mockSubprocess({ exitCode: 1 });
      }) as never);

      try {
        const handle = await startDevApi();

        expect(handle.apiProcess).not.toBeNull();
      } finally {
        delete process.env['HB_API_PORT'];
      }
    });

    /** Where a package script the flow runs sits in the call order, or -1. */
    const scriptCallIndex = (packageName: string, script: string): number =>
      mockExeca.mock.calls.findIndex(
        (call) =>
          call[0] === 'pnpm' &&
          Array.isArray(call[1]) &&
          call[1].includes(packageName) &&
          call[1].includes(script)
      );

    /** A first health poll that answers "nothing listening", so the flow starts one. */
    const apiNotYetListening = (): void => {
      let healthCheckCount = 0;
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'curl') {
          healthCheckCount++;
          if (healthCheckCount === 1) return Promise.reject(new Error('not running'));
          return mockSubprocess();
        }
        return mockSubprocess();
      }) as never);
    };

    it('spawns the API dev server when none is listening', async () => {
      process.env['HB_API_PORT'] = '8787';
      apiNotYetListening();
      try {
        await startDevApi();

        expect(scriptCallIndex('@hushbox/api', 'dev')).toBeGreaterThanOrEqual(0);
      } finally {
        delete process.env['HB_API_PORT'];
      }
    });

    it('builds no marketing site when it starts the API', async () => {
      process.env['HB_API_PORT'] = '8787';
      apiNotYetListening();
      try {
        await startDevApi();

        expect(scriptCallIndex('@hushbox/marketing', 'build')).toBe(-1);
      } finally {
        delete process.env['HB_API_PORT'];
      }
    });

    it('extracts no event index when it starts the API', async () => {
      process.env['HB_API_PORT'] = '8787';
      apiNotYetListening();
      try {
        await startDevApi();

        expect(scriptCallIndex('@hushbox/marketing', 'growth:index')).toBe(-1);
      } finally {
        delete process.env['HB_API_PORT'];
      }
    });

    it('builds nothing when it reuses a running API', async () => {
      process.env['HB_API_PORT'] = '8787';
      try {
        await startDevApi();

        expect(scriptCallIndex('@hushbox/marketing', 'build')).toBe(-1);
        expect(scriptCallIndex('@hushbox/marketing', 'growth:index')).toBe(-1);
      } finally {
        delete process.env['HB_API_PORT'];
      }
    });

    it('throws when HB_API_PORT is not set', async () => {
      delete process.env['HB_API_PORT'];

      await expect(startDevApi()).rejects.toThrow('HB_API_PORT not set');
    });

    it('throws when the API never becomes ready', async () => {
      process.env['HB_API_PORT'] = '8787';
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((function_: () => void) => {
        function_();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
      // The failure path echoes the server log, which the next case is about;
      // held here so this one's assertion runs against a quiet stdout.
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      try {
        mockExeca.mockImplementation(((cmd: string) => {
          if (cmd === 'curl') return Promise.reject(new Error('API never ready'));
          return mockSubprocess();
        }) as never);
        await expect(startDevApi()).rejects.toThrow(/failed to start within timeout/);
      } finally {
        stdoutSpy.mockRestore();
        globalThis.setTimeout = originalSetTimeout;
        delete process.env['HB_API_PORT'];
      }
    });

    it('echoes the server log when the API never becomes ready', async () => {
      process.env['HB_API_PORT'] = '8787';
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((function_: () => void) => {
        function_();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      mockReadFileSync.mockImplementation((file) =>
        String(file).endsWith('.wrangler-8787.log')
          ? 'no built marketing site under apps/marketing/dist or apps/web/dist'
          : ''
      );
      try {
        mockExeca.mockImplementation(((cmd: string) => {
          if (cmd === 'curl') return Promise.reject(new Error('API never ready'));
          return mockSubprocess();
        }) as never);

        await expect(startDevApi()).rejects.toThrow(/failed to start within timeout/);

        const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
        expect(written).toContain('no built marketing site');
      } finally {
        stdoutSpy.mockRestore();
        globalThis.setTimeout = originalSetTimeout;
        delete process.env['HB_API_PORT'];
      }
    });
  });

  describe('stopDevApi', () => {
    it('is a no-op when apiProcess is null', async () => {
      await expect(stopDevApi({ apiProcess: null })).resolves.toBeUndefined();
    });

    it('ends the whole tree it started, not only the command at its root', async () => {
      const kill = vi.fn(() => Promise.resolve(0));
      await stopDevApi({ apiProcess: fakeLongLivedChild(kill) });
      expect(kill).toHaveBeenCalled();
    });

    it('does not throw when kill itself fails (best-effort cleanup)', async () => {
      const fakeProcess = fakeLongLivedChild(() => {
        throw new Error('already exited');
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(stopDevApi({ apiProcess: fakeProcess })).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to stop API server'));
    });

    it('stringifies non-Error failures from kill', async () => {
      const fakeProcess = fakeLongLivedChild(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises the non-Error branch of the kill recovery
        throw 'ESRCH';
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(stopDevApi({ apiProcess: fakeProcess })).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ESRCH'));
    });
  });

  describe('startSandboxOrigin', () => {
    it('reuses an already-serving sandbox origin and returns a null process', async () => {
      const handle = await startSandboxOrigin();
      expect(mockExeca).toHaveBeenCalledWith('curl', ['-sf', 'http://localhost:7400/render.html'], {
        stdio: 'ignore',
      });
      expect(handle.sandboxProcess).toBeNull();
      const sandboxDevCalls = mockExeca.mock.calls.filter(
        (call) =>
          call[0] === 'pnpm' &&
          Array.isArray(call[1]) &&
          call[1].includes('--filter') &&
          call[1].includes('@hushbox/sandbox')
      );
      expect(sandboxDevCalls).toHaveLength(0);
    });

    it('spawns the sandbox dev server as a background subprocess when not ready', async () => {
      let readinessCount = 0;
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'curl') {
          readinessCount++;
          if (readinessCount === 1) return Promise.reject(new Error('not serving'));
          return mockSubprocess();
        }
        return mockSubprocess();
      }) as never);

      const handle = await startSandboxOrigin();
      expect(handle.sandboxProcess).not.toBeNull();
      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['--filter', '@hushbox/sandbox', 'dev'],
        expect.objectContaining({
          stdio: ['ignore', 'ignore', 'ignore'],
          detached: true,
        })
      );
    });

    it('claims the sandbox port against the run before it starts the server that binds it', async () => {
      let readinessCount = 0;
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'curl') {
          readinessCount++;
          if (readinessCount === 1) return Promise.reject(new Error('not serving'));
          return mockSubprocess();
        }
        return mockSubprocess();
      }) as never);

      expect(await portsClaimedDuring(() => startSandboxOrigin())).toContain(
        process.env['HB_SANDBOX_PORT']
      );
    });

    it('does not crash when the spawned sandbox subprocess dies immediately', async () => {
      let readinessCount = 0;
      function deadSubprocess(): never {
        return mockSubprocess({ exitCode: 1 });
      }
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'curl') {
          readinessCount++;
          if (readinessCount === 1) return Promise.reject(new Error('not serving'));
          return mockSubprocess();
        }
        return deadSubprocess();
      }) as never);

      const handle = await startSandboxOrigin();
      expect(handle.sandboxProcess).not.toBeNull();
    });

    it('throws when HB_SANDBOX_PORT is not set', async () => {
      delete process.env['HB_SANDBOX_PORT'];
      await expect(startSandboxOrigin()).rejects.toThrow('HB_SANDBOX_PORT not set');
    });

    it('throws when the sandbox origin never becomes ready', async () => {
      const originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((function_: () => void) => {
        function_();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout;
      try {
        mockExeca.mockImplementation(((cmd: string) => {
          if (cmd === 'curl') return Promise.reject(new Error('sandbox never ready'));
          return mockSubprocess();
        }) as never);
        await expect(startSandboxOrigin()).rejects.toThrow(/failed to start within timeout/);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    });
  });

  describe('stopSandboxOrigin', () => {
    it('is a no-op when sandboxProcess is null', async () => {
      await expect(stopSandboxOrigin({ sandboxProcess: null })).resolves.toBeUndefined();
    });

    it('ends the whole tree it started, not only the command at its root', async () => {
      const kill = vi.fn(() => Promise.resolve(0));
      await stopSandboxOrigin({ sandboxProcess: fakeLongLivedChild(kill) });
      expect(kill).toHaveBeenCalled();
    });

    it('does not throw when kill itself fails (best-effort cleanup)', async () => {
      const fakeProcess = fakeLongLivedChild(() => {
        throw new Error('already exited');
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(stopSandboxOrigin({ sandboxProcess: fakeProcess })).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to stop sandbox origin')
      );
    });

    it('stringifies non-Error failures from kill', async () => {
      const fakeProcess = fakeLongLivedChild(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises the non-Error branch of the kill recovery
        throw 'ESRCH';
      });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await expect(stopSandboxOrigin({ sandboxProcess: fakeProcess })).resolves.toBeUndefined();
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('ESRCH'));
    });
  });

  describe('document conversation seed', () => {
    it('payload owns the mobile persona and carries the fenced HTML document', () => {
      const parsed = JSON.parse(documentSeedPayload()) as {
        ownerEmail: string;
        title: string;
        messages: { content: string; senderType: string }[];
      };
      expect(parsed.ownerEmail).toBe(DOCUMENT_SEED_OWNER_EMAIL);
      // The Maestro flow taps the seeded conversation's chat row by this exact
      // title text, so an untitled row (the empty-title placeholder) would be
      // untappable — see mobile-tests/flows/14-document-renders.yaml.
      expect(parsed.title).toBe('Mobile render proof');
      const aiMessage = parsed.messages.find((m) => m.senderType === 'ai');
      expect(aiMessage?.content).toBe(DOCUMENT_SEED_MESSAGE);
      expect(aiMessage?.content).toContain('```html');
    });

    it('the seeded document is at least MIN_LINES_FOR_DOCUMENT lines so the parser extracts it', () => {
      // Asserted against the shared threshold, never a copy of its value: the
      // seed is sized with headroom above it, and raising the threshold past
      // that headroom must fail here rather than silently demote the seeded
      // document to an inline code block on device.
      const fenceBody = DOCUMENT_SEED_MESSAGE.split('```html')[1]?.split('```')[0] ?? '';
      const lineCount = fenceBody.trim().split('\n').length;
      expect(lineCount).toBeGreaterThanOrEqual(MIN_LINES_FOR_DOCUMENT);
    });

    it('POSTs the payload to the dev-only /dev/conversation route on the API port', async () => {
      process.env['HB_API_PORT'] = '8787';
      try {
        await seedDocumentConversation();
        expect(mockExeca).toHaveBeenCalledWith(
          'curl',
          [
            '-sf',
            '-X',
            'POST',
            'http://localhost:8787/dev/conversation',
            '-H',
            'Content-Type: application/json',
            '-d',
            documentSeedPayload(),
          ],
          { stdio: 'ignore' }
        );
      } finally {
        delete process.env['HB_API_PORT'];
      }
    });

    it('throws when HB_API_PORT is not set', async () => {
      delete process.env['HB_API_PORT'];
      await expect(seedDocumentConversation()).rejects.toThrow('HB_API_PORT not set');
    });
  });

  describe('withMobileTestRun', () => {
    beforeEach(() => {
      process.env['HB_API_PORT'] = '8915';
    });
    afterEach(() => {
      delete process.env['HB_API_PORT'];
    });

    it('writes START marker before body executes', async () => {
      const calls: string[] = [];
      mockAppendFileSync.mockImplementation((_path, data) => {
        calls.push(String(data));
      });

      const body = vi.fn(() => {
        // Inspect at body-entry: START should already be written, END not yet
        expect(calls.some((c) => c.includes(`${MARKER_PREFIX} run-1 START`))).toBe(true);
        expect(calls.some((c) => c.includes(`${MARKER_PREFIX} run-1 END`))).toBe(false);
        return Promise.resolve();
      });

      await withMobileTestRun('run-1', body);
      expect(body).toHaveBeenCalledOnce();
    });

    it('writes END marker after body resolves', async () => {
      const calls: string[] = [];
      mockAppendFileSync.mockImplementation((_path, data) => {
        calls.push(String(data));
      });

      await withMobileTestRun('run-2', async () => {});

      expect(calls.some((c) => c.includes(`${MARKER_PREFIX} run-2 START`))).toBe(true);
      expect(calls.some((c) => c.includes(`${MARKER_PREFIX} run-2 END`))).toBe(true);
    });

    it('writes END marker even when body throws', async () => {
      const calls: string[] = [];
      mockAppendFileSync.mockImplementation((_path, data) => {
        calls.push(String(data));
      });

      await expect(
        withMobileTestRun('run-3', () => Promise.reject(new Error('body failed')))
      ).rejects.toThrow('body failed');

      expect(calls.some((c) => c.includes(`${MARKER_PREFIX} run-3 END`))).toBe(true);
    });

    it("writes both markers into wrangler's own debug log for the port", async () => {
      const paths: string[] = [];
      mockAppendFileSync.mockImplementation((path) => {
        paths.push(String(path));
      });

      await withMobileTestRun('run-4', async () => {});

      // The teed stdout log never carries the API's request lines, so the
      // markers have to bracket the run in the file that does.
      expect(paths.every((p) => p.endsWith('apps/api/.wrangler-debug-8915.log'))).toBe(true);
      expect(paths).toHaveLength(2);
    });

    it('throws when HB_API_PORT is not set', async () => {
      delete process.env['HB_API_PORT'];

      await expect(withMobileTestRun('run-6', async () => {})).rejects.toThrow(
        'HB_API_PORT not set'
      );
    });
  });

  describe('writeApiSlice', () => {
    beforeEach(() => {
      process.env['HB_API_PORT'] = '8915';
    });
    afterEach(() => {
      delete process.env['HB_API_PORT'];
    });

    it("reads the run's slice out of wrangler's debug log for the port", () => {
      writeApiSlice('run-5');

      const call = mockReadRunApiSlice.mock.calls[0]?.[0];
      expect(call?.logPath.endsWith('apps/api/.wrangler-debug-8915.log')).toBe(true);
      expect(call?.runId).toBe('run-5');
    });

    it('labels the slice with a repository-relative path, never an absolute one', () => {
      writeApiSlice('run-5');

      expect(mockReadRunApiSlice.mock.calls[0]?.[0].logLabel).toBe(
        'apps/api/.wrangler-debug-8915.log'
      );
    });

    it('writes what the reader returned, header and all', () => {
      mockReadRunApiSlice.mockReturnValueOnce('===== api log slice: 2 request lines =====');

      writeApiSlice('run-5');

      const writeCall = mockWriteFileSync.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].endsWith('api-during-mobile-test.log')
      );
      expect(writeCall?.[1]).toBe('===== api log slice: 2 request lines =====');
    });

    it('writes the slice at the documented API_SLICE_PATH constant', () => {
      writeApiSlice('any-run-id');

      const calls = mockWriteFileSync.mock.calls;
      const target = calls.find(
        (call) => typeof call[0] === 'string' && call[0] === API_SLICE_PATH
      );
      expect(target).toBeDefined();
    });

    it('throws when HB_API_PORT is not set', () => {
      delete process.env['HB_API_PORT'];

      expect(() => {
        writeApiSlice('any-run-id');
      }).toThrow('HB_API_PORT not set');
    });
  });

  describe('resetVersionOverride', () => {
    beforeEach(() => {
      process.env['HB_API_PORT'] = '8787';
    });

    afterEach(() => {
      delete process.env['HB_API_PORT'];
      vi.unstubAllGlobals();
    });

    it('posts the APK version to the dev endpoint on HB_API_PORT', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await resetVersionOverride();

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8787/dev/set-version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: APK_APP_VERSION }),
      });
    });

    it('throws when HB_API_PORT is not set', async () => {
      delete process.env['HB_API_PORT'];

      await expect(resetVersionOverride()).rejects.toThrow('HB_API_PORT not set');
    });

    it('throws when the dev endpoint rejects the override', async () => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500 }));

      await expect(resetVersionOverride()).rejects.toThrow(
        'Failed to reset version override: HTTP 500'
      );
    });
  });

  describe('dumpApiLogTail', () => {
    it('echoes the last N lines of the slice file to the process stdout', () => {
      const sliceContent = Array.from({ length: 250 }, (_, index) => `line ${String(index)}`).join(
        '\n'
      );
      mockReadFileSync.mockImplementationOnce((file) => {
        if (String(file).endsWith('api-during-mobile-test.log')) return sliceContent;
        return '';
      });
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

      try {
        dumpApiLogTail(50);

        const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
        expect(written).toContain('=== last 50 lines of API log');
        expect(written).toContain('line 249');
        expect(written).not.toContain('line 199');
      } finally {
        stdoutSpy.mockRestore();
      }
    });
  });

  describe('buildApk', () => {
    beforeEach(() => {
      buildSteps.order.length = 0;
      mockVerifyBundle.mockImplementation(() => {
        buildSteps.order.push('verify');
        return Promise.resolve();
      });
      process.env['API_URL'] = 'http://localhost:8787';
      process.env['FRONTEND_URL'] = 'http://localhost:5173';
    });

    afterEach(() => {
      delete process.env['API_URL'];
      delete process.env['FRONTEND_URL'];
    });

    it('holds the build lease across every step that touches the shared web output', async () => {
      await buildApk();

      expect(buildSteps.order.at(0)).toBe('lease-acquired');
      expect(buildSteps.order).toContain('verify');
      expect(buildSteps.order.at(-1)).toBe('lease-released');
    });

    it('releases the build lease before the native build that reads no web output', async () => {
      const timeline: string[] = [];
      mockExeca.mockImplementation(((file: string) => {
        timeline.push(file);
        return Promise.resolve({ exitCode: 0 });
      }) as never);
      mockVerifyBundle.mockImplementation(() => {
        timeline.push('verify');
        return Promise.resolve();
      });

      await buildApk();

      const gradleIndex = timeline.findIndex((entry) => entry.endsWith('gradlew'));
      expect(gradleIndex).toBeGreaterThan(-1);
      expect(timeline.slice(0, gradleIndex)).toContain('verify');
      expect(buildSteps.order.at(-1)).toBe('lease-released');
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

    it('verifies the built web dist under the web app own bundle declaration', async () => {
      await buildApk();

      expect(mockVerifyBundle).toHaveBeenCalledTimes(1);
      const options = mockVerifyBundle.mock.calls[0]![0];
      expect(options.distributionDir.endsWith(path.join('apps', 'web', 'dist'))).toBe(true);
      expect(options.shipsTts).toBe(true);
    });

    it('verifies the web dist before capacitor syncs it into the native project', async () => {
      mockExeca.mockImplementation(((command: string, args: readonly string[]) => {
        if (command === 'pnpm' && args.includes('build')) buildSteps.order.push('build');
        if (command === 'npx' && args.includes('sync')) buildSteps.order.push('sync');
        return Promise.resolve({ exitCode: 0, stdout: '' });
      }) as never);

      await buildApk();

      expect(buildSteps.order).toEqual([
        'lease-acquired',
        'build',
        'verify',
        'sync',
        'lease-released',
      ]);
    });

    it('syncs nothing when verification fails', async () => {
      mockVerifyBundle.mockRejectedValue(
        new Error('Bundle verification failed: built artifact carries backend environment material')
      );

      await expect(buildApk()).rejects.toThrow('backend environment material');

      expect(mockExeca).not.toHaveBeenCalledWith(
        'npx',
        ['cap', 'sync', 'android'],
        expect.anything()
      );
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

    it('runs gradle clean assembleDebug with version and keystore env vars', async () => {
      await buildApk();

      expect(mockExeca).toHaveBeenCalledWith('./gradlew', ['clean', 'assembleDebug'], {
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
    it('installs APK via adb on the shard-specific port', async () => {
      await installApk(1);

      expect(mockExeca).toHaveBeenCalledWith(
        'adb',
        [
          '-s',
          adbHost(1),
          'install',
          '-r',
          'apps/web/android/app/build/outputs/apk/debug/app-debug.apk',
        ],
        { stdio: 'inherit' }
      );
    });
  });

  describe('installApks', () => {
    it('installs APK on all n shards', async () => {
      await installApks(2);

      const installCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'adb' && Array.isArray(c[1]) && c[1].includes('install')
      );
      expect(installCalls).toHaveLength(2);
      const targetHosts = installCalls.map((c) => (c[1] as string[])[1]);
      expect(targetHosts).toContain(adbHost(0));
      expect(targetHosts).toContain(adbHost(1));
    });
  });

  describe('configureAppLinks', () => {
    it('targets the shard-specific adb host', async () => {
      await configureAppLinks(1);

      expect(mockExeca).toHaveBeenCalledWith(
        'adb',
        expect.arrayContaining(['-s', adbHost(1), 'shell', 'pm', 'set-app-links-allowed']),
        expect.objectContaining({ stdio: 'inherit' })
      );
    });
  });

  describe('configureAllAppLinks', () => {
    it('configures app links on all n shards', async () => {
      await configureAllAppLinks(2);

      const setAppLinksCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'adb' && Array.isArray(c[1]) && c[1].includes('set-app-links-allowed')
      );
      expect(setAppLinksCalls).toHaveLength(2);
    });
  });

  describe('stopEmulator', () => {
    /** A world in which the named container is running; the stock mock finds none. */
    function containerPresent(name: string): void {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        const argumentList = Array.isArray(args) ? args : [];
        if (cmd === 'docker' && argumentList[0] === 'ps') {
          return Promise.resolve({ stdout: name, exitCode: 0 } as never);
        }
        return Promise.resolve({ stdout: '', exitCode: 0 } as never);
      }) as never);
    }

    function inScratchRun<T>(registryDir: string, body: () => Promise<T>): Promise<T> {
      return registerRun(
        {
          command: 'pnpm mobile:test',
          mode: 'development',
          slot: 0,
          gitCommonDir: path.join(path.sep, 'checkout', '.git'),
          registryDir,
        },
        body
      );
    }

    it('removes the container its own run recorded', async () => {
      const name = containerNameForShard(0);
      containerPresent(name);

      await withScratchDirectory('hushbox-mobile-stop-', (registryDir) =>
        inScratchRun(registryDir, async () => {
          await recordOwnedResource('container', name);
          await stopEmulator(0, registryDir);
        })
      );

      expect(mockExeca).toHaveBeenCalledWith('docker', ['rm', '-f', name], { stdio: 'inherit' });
    });

    it('targets the shard-specific container name', async () => {
      const name = containerNameForShard(1);
      containerPresent(name);

      await withScratchDirectory('hushbox-mobile-stop-', (registryDir) =>
        inScratchRun(registryDir, async () => {
          await recordOwnedResource('container', name);
          await stopEmulator(1, registryDir);
        })
      );

      expect(mockExeca).toHaveBeenCalledWith('docker', ['rm', '-f', name], { stdio: 'inherit' });
    });

    it('leaves another live run’s emulator standing and says whose it is', async () => {
      const name = containerNameForShard(0);
      containerPresent(name);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await withScratchDirectory('hushbox-mobile-stop-held-', (registryDir) =>
        inScratchRun(registryDir, async () => {
          await recordOwnedResource('container', name);
          vi.stubEnv(RUN_CLAIM_ENV, '');
          await inScratchRun(registryDir, () => stopEmulator(0, registryDir));
        })
      );

      const removals = mockExeca.mock.calls.filter(
        (call) => call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'rm'
      );
      expect(removals).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(name));
    });

    it('removes nothing when no container carries the shard name', async () => {
      await stopEmulator(0);

      const removals = mockExeca.mock.calls.filter(
        (call) => call[0] === 'docker' && Array.isArray(call[1]) && call[1][0] === 'rm'
      );
      expect(removals).toEqual([]);
    });

    it('does not throw when docker rm fails', async () => {
      const name = containerNameForShard(0);
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        const argumentList = Array.isArray(args) ? args : [];
        if (cmd === 'docker' && argumentList[0] === 'ps') {
          return Promise.resolve({ stdout: name, exitCode: 0 } as never);
        }
        if (cmd === 'docker' && argumentList[0] === 'rm') {
          return Promise.reject(new Error('container not found'));
        }
        return Promise.resolve({ stdout: '', exitCode: 0 } as never);
      }) as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await withScratchDirectory('hushbox-mobile-stop-fail-', (registryDir) =>
        inScratchRun(registryDir, async () => {
          await recordOwnedResource('container', name);
          await expect(stopEmulator(0, registryDir)).resolves.toBeUndefined();
        })
      );

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to stop emulator'));
    });

    it('stringifies non-Error failures from docker rm', async () => {
      const name = containerNameForShard(0);
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        const argumentList = Array.isArray(args) ? args : [];
        if (cmd === 'docker' && argumentList[0] === 'ps') {
          return Promise.resolve({ stdout: name, exitCode: 0 } as never);
        }
        if (cmd === 'docker' && argumentList[0] === 'rm') {
          // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- a string rejection is what exercises the String(error) fallback
          return Promise.reject('daemon unreachable');
        }
        return Promise.resolve({ stdout: '', exitCode: 0 } as never);
      }) as never);
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      await withScratchDirectory('hushbox-mobile-stop-string-', (registryDir) =>
        inScratchRun(registryDir, async () => {
          await recordOwnedResource('container', name);
          await expect(stopEmulator(0, registryDir)).resolves.toBeUndefined();
        })
      );

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('daemon unreachable'));
    });
  });

  describe('stopEmulators', () => {
    it('stops all n shards in parallel', async () => {
      await stopEmulators(2);

      const probes = mockExeca.mock.calls.filter(
        (c) =>
          c[0] === 'docker' &&
          Array.isArray(c[1]) &&
          c[1][0] === 'ps' &&
          (c[1].includes(`name=^${containerNameForShard(0)}$`) ||
            c[1].includes(`name=^${containerNameForShard(1)}$`))
      );
      expect(probes).toHaveLength(2);
    });
  });

  describe('runMaestroShards', () => {
    beforeEach(() => {
      process.env['HB_API_PORT'] = '8787';
    });

    afterEach(() => {
      delete process.env['HB_API_PORT'];
    });

    it('kills adb server to clear ghost devices', async () => {
      await runMaestroShards(false, 2);

      expect(mockExeca).toHaveBeenCalledWith('adb', ['kill-server']);
    });

    it('restarts adb server with emulator scanning disabled', async () => {
      await runMaestroShards(false, 2);

      expect(mockExeca).toHaveBeenCalledWith('adb', ['start-server'], {
        env: expect.objectContaining({ ADB_LOCAL_TRANSPORT_MAX_PORT: '0' }),
      });
    });

    it('connects adb to each shard after server restart', async () => {
      await runMaestroShards(false, 2);

      expect(mockExeca).toHaveBeenCalledWith('adb', ['connect', adbHost(0)]);
      expect(mockExeca).toHaveBeenCalledWith('adb', ['connect', adbHost(1)]);
    });

    it('re-establishes adb reverse for API port on each shard', async () => {
      process.env['HB_API_PORT'] = '9999';

      await runMaestroShards(false, 2);

      expect(mockExeca).toHaveBeenCalledWith('adb', [
        '-s',
        adbHost(0),
        'reverse',
        'tcp:9999',
        'tcp:9999',
      ]);
      expect(mockExeca).toHaveBeenCalledWith('adb', [
        '-s',
        adbHost(1),
        'reverse',
        'tcp:9999',
        'tcp:9999',
      ]);
    });

    it('runs maestro on each shard with disjoint flow partitions', async () => {
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'maestro') return mockSubprocess({ exitCode: 0, stdout: '' });
        return mockSubprocess();
      }) as never);

      await runMaestroShards(false, 2);

      const maestroCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'maestro' && Array.isArray(c[1]) && c[1].includes('test')
      );
      expect(maestroCalls).toHaveLength(2);

      const allFlows = maestroCalls.flatMap((c) =>
        (c[1] as string[]).filter((argument) => argument.endsWith('.yaml'))
      );
      // OTA excluded; smoke vs non-smoke handled by listFlowsForRun
      expect(allFlows).not.toContain('mobile-tests/flows/13-ota-update.yaml');
      // Each flow appears exactly once across all shards (weight-balanced partition)
      const flowCounts = new Map<string, number>();
      for (const flow of allFlows) {
        flowCounts.set(flow, (flowCounts.get(flow) ?? 0) + 1);
      }
      for (const count of flowCounts.values()) {
        expect(count).toBe(1);
      }
    });

    it('continues when adb kill-server fails because no server is running', async () => {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'adb' && Array.isArray(args) && args[0] === 'kill-server') {
          return Promise.reject(new Error('server not running'));
        }
        if (cmd === 'maestro') return mockSubprocess({ exitCode: 0, stdout: '' });
        return mockSubprocess();
      }) as never);

      await runMaestroShards(false, 1);

      expect(mockExeca).toHaveBeenCalledWith('adb', ['start-server'], expect.anything());
    });

    it('throws when HB_API_PORT is not set', async () => {
      delete process.env['HB_API_PORT'];

      await expect(runMaestroShards(false, 1)).rejects.toThrow('HB_API_PORT not set');
    });

    it('treats a maestro result without an exit code as a failure', async () => {
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'maestro') return mockSubprocess({ stdout: '' });
        return mockSubprocess();
      }) as never);

      await expect(runMaestroShards(false, 1)).rejects.toThrow(
        'Maestro tests failed without identifiable flow failures'
      );
    });

    it('runs only smoke flows when smoke is true', async () => {
      mockExeca.mockImplementation(((cmd: string) => {
        if (cmd === 'maestro') return mockSubprocess({ exitCode: 0, stdout: '' });
        return mockSubprocess();
      }) as never);

      await runMaestroShards(true, 2);

      const maestroCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'maestro' && Array.isArray(c[1]) && c[1].includes('test')
      );
      const allFlows = maestroCalls.flatMap((c) =>
        (c[1] as string[]).filter((argument) => argument.endsWith('.yaml'))
      );
      expect(allFlows).toContain('mobile-tests/flows/01-app-launch.yaml');
      expect(allFlows).toContain('mobile-tests/flows/03-webview-renders.yaml');
      expect(allFlows).toHaveLength(2);
    });

    it('retries failed flows on shard 0', async () => {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'maestro' && Array.isArray(args) && args.includes('test')) {
          // First two are the per-shard runs; one of them returns a failure
          return mockSubprocess({
            exitCode: 1,
            stdout: '[Failed] App launches without crashing (10s) (some reason)',
          });
        }
        return mockSubprocess();
      }) as never);

      await runMaestroShards(false, 2);

      const maestroTestCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'maestro' && Array.isArray(c[1]) && c[1].includes('test')
      );
      // 2 shard runs + 1 retry pass = 3 maestro test invocations
      expect(maestroTestCalls.length).toBeGreaterThanOrEqual(3);
      // Retry targets shard 0's host
      const retry = maestroTestCalls.at(-1)!;
      expect(retry[1] as string[]).toContain(adbHost(0));
    });

    it('re-connects adb to the retry shard before the retry maestro invocation', async () => {
      // Per-shard maestro processes can disturb the host adb server's device
      // table on exit (see maestro#2167), which makes the retry fail with
      // "Device localhost:PORT not connected". The retry path must
      // idempotently re-establish the connection before invoking maestro.
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'maestro' && Array.isArray(args) && args.includes('test')) {
          return mockSubprocess({
            exitCode: 1,
            stdout: '[Failed] App launches without crashing (10s) (some reason)',
          });
        }
        return mockSubprocess();
      }) as never);

      await runMaestroShards(false, 2);

      // Find the index of the final (retry) maestro test call.
      const callOrder = mockExeca.mock.calls.map((c, index) => ({
        index,
        cmd: c[0] as string,
        args: Array.isArray(c[1]) ? (c[1] as string[]) : [],
      }));
      const retryIndex = callOrder.findLast(
        (c) => c.cmd === 'maestro' && c.args.includes('test')
      )!.index;

      // The shard-0 adb connect + wait-for-device must appear after the
      // per-shard runs settle and before the retry maestro fires.
      const reconnectIndex = callOrder.findIndex(
        (c, index) =>
          index < retryIndex &&
          c.cmd === 'adb' &&
          c.args[0] === 'connect' &&
          c.args[1] === adbHost(0) &&
          // Restrict to the LAST adb connect for that host before retry —
          // prepareAdbServer's earlier connect doesn't count.
          callOrder
            .slice(index + 1, retryIndex)
            .every((later) => !(later.cmd === 'adb' && later.args[0] === 'connect'))
      );
      expect(reconnectIndex).toBeGreaterThan(-1);

      const waitForDeviceIndex = callOrder.findIndex(
        (c, index) =>
          index > reconnectIndex &&
          index < retryIndex &&
          c.cmd === 'adb' &&
          c.args.includes('wait-for-device') &&
          c.args.includes(adbHost(0))
      );
      expect(waitForDeviceIndex).toBeGreaterThan(reconnectIndex);
    });

    it('skips a shard nothing was partitioned onto, invoking no maestro and failing nothing', async () => {
      // A shard count above the flow count leaves a shard with nothing to do.
      // It must not invoke maestro, and its empty output must not read as a
      // run whose failures could not be identified.
      const result = await runMaestroOnShard(1, []);

      expect(result).toEqual({ shard: 1, exitCode: 0, stdout: '' });
      expect(mockExeca).not.toHaveBeenCalled();
    });

    it('throws when shard fails without identifiable flow failures', async () => {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'maestro' && Array.isArray(args) && args.includes('test')) {
          return mockSubprocess({ exitCode: 1, stdout: 'unparseable output' });
        }
        return mockSubprocess();
      }) as never);

      await expect(runMaestroShards(false, 2)).rejects.toThrow(/without identifiable/);
    });
  });

  describe('main', () => {
    let savedPath: string | undefined;

    beforeEach(() => {
      savedPath = process.env['PATH'];
      process.env['HB_API_PORT'] = '8787';
      process.env['API_URL'] = 'http://localhost:8787';
      process.env['FRONTEND_URL'] = 'http://localhost:5173';

      function dispatchMainCall(cmd: string, args: readonly string[]): unknown {
        if (cmd === 'stat') return Promise.resolve({ stdout: '993' });
        const probe = bootReadinessMock(cmd, args);
        if (probe) return Promise.resolve(probe);
        if (cmd === 'maestro' && args.includes('test')) {
          return mockSubprocess({ exitCode: 0, stdout: '' });
        }
        // runEmulatorContainer reads stdout.trim() from docker run.
        return Promise.resolve({ stdout: '' });
      }
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) =>
        dispatchMainCall(cmd, Array.isArray(args) ? args : [])) as never);
    });

    afterEach(() => {
      delete process.env['HB_API_PORT'];
      delete process.env['HB_KVM_GID'];
      delete process.env['API_URL'];
      delete process.env['FRONTEND_URL'];
      process.env['PATH'] = savedPath;
    });

    it('calls bakeImage with push=false before starting emulators', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );

      await inOwnRun(main);

      vi.unstubAllGlobals();
      expect(mockBakeImage).toHaveBeenCalledWith({ push: false });
    });

    it('skips the OTA stage when --smoke is passed', async () => {
      const savedArgv = process.argv;
      process.argv = [...savedArgv.slice(0, 2), '--smoke'];
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );

      try {
        await inOwnRun(main);

        const r2Calls = mockExeca.mock.calls.filter(
          (call) => Array.isArray(call[1]) && call[1].includes('r2')
        );
        expect(r2Calls).toEqual([]);
      } finally {
        process.argv = savedArgv;
        vi.unstubAllGlobals();
      }
    });

    function failMaestroDispatch(cmd: string, args: readonly string[]): unknown {
      if (cmd === 'stat') return Promise.resolve({ stdout: '993' });
      const probe = bootReadinessMock(cmd, args);
      if (probe) return Promise.resolve(probe);
      if (cmd === 'maestro' && args.includes('test')) {
        return mockSubprocess({ exitCode: 1, stdout: '' });
      }
      return Promise.resolve({ stdout: '' });
    }

    it('dumps the API log tail when maestro fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );
      const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) =>
        failMaestroDispatch(cmd, Array.isArray(args) ? args : [])) as never);

      try {
        await expect(inOwnRun(main)).rejects.toThrow(
          'Maestro tests failed without identifiable flow failures'
        );

        const written = stdoutSpy.mock.calls.map((call) => String(call[0])).join('');
        expect(written).toContain('API log');
      } finally {
        stdoutSpy.mockRestore();
        vi.unstubAllGlobals();
      }
    });

    it('reports a failure to write the API slice without masking the run error', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) =>
        failMaestroDispatch(cmd, Array.isArray(args) ? args : [])) as never);
      mockWriteFileSync.mockImplementation(() => {
        throw new Error('disk full');
      });

      try {
        await expect(inOwnRun(main)).rejects.toThrow(
          'Maestro tests failed without identifiable flow failures'
        );

        expect(errorSpy).toHaveBeenCalledWith('Failed to write API slice: disk full');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('stringifies non-Error failures from the API slice write', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) =>
        failMaestroDispatch(cmd, Array.isArray(args) ? args : [])) as never);
      mockWriteFileSync.mockImplementation(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- exercises the non-Error branch of the slice-write recovery
        throw 'raw disk failure';
      });

      try {
        await expect(inOwnRun(main)).rejects.toThrow(
          'Maestro tests failed without identifiable flow failures'
        );

        expect(errorSpy).toHaveBeenCalledWith('Failed to write API slice: raw disk failure');
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('stops execution if prerequisites fail', async () => {
      mockExeca.mockRejectedValueOnce(new Error('Docker not running'));

      await expect(main()).rejects.toThrow('Docker is not running');

      const stopCalls = mockExeca.mock.calls.filter(
        (call) =>
          call[0] === 'docker' &&
          Array.isArray(call[1]) &&
          call[1][0] === 'ps' &&
          call[1].includes(`name=^${containerNameForShard(0)}$`)
      );
      expect(stopCalls).toHaveLength(0);
    });

    it('stops all emulators in finally even when a later step fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );

      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'stat') return Promise.resolve({ stdout: '993' } as never);
        const argumentList = Array.isArray(args) ? [...args] : [];
        if (cmd === 'adb') {
          if (argumentList.includes('connect'))
            return Promise.resolve({ stdout: 'connected' } as never);
          if (argumentList.includes('getprop')) return Promise.resolve({ stdout: '1' } as never);
        }
        if (cmd === 'pnpm' && argumentList.includes('build'))
          return Promise.reject(new Error('build failed'));
        return mockSubprocess();
      }) as never);

      await expect(main()).rejects.toThrow('build failed');
      vi.unstubAllGlobals();

      // teardown reaches every shard's emulator
      const stopCalls = mockExeca.mock.calls.filter(
        (call) =>
          call[0] === 'docker' &&
          Array.isArray(call[1]) &&
          call[1][0] === 'ps' &&
          typeof call[1][3] === 'string' &&
          call[1][3].includes('-emulator-shard-')
      );
      const stoppedShards = new Set(stopCalls.map((c) => (c[1] as string[])[3]));
      expect(stoppedShards.size).toBeGreaterThanOrEqual(1);
    });
  });

  describe('runMaestroOta', () => {
    it('runs the OTA flow with --debug-output and passes when maestro succeeds', async () => {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'maestro' && Array.isArray(args) && args.includes('test')) {
          return mockSubprocess({ exitCode: 0, stdout: '' });
        }
        return mockSubprocess();
      }) as never);

      await expect(runMaestroOta()).resolves.toBeUndefined();
      expect(mockExeca).toHaveBeenCalledWith(
        'maestro',
        expect.arrayContaining([
          'test',
          '--debug-output',
          'maestro-results/ota',
          '--flatten-debug-output',
        ]),
        expect.anything()
      );
    });

    it('rethrows without dumping logcat when maestro fails', async () => {
      const otaError = new Error('OTA flow assertion failed');
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        const argumentList = Array.isArray(args) ? args : [];
        if (cmd === 'maestro' && argumentList.includes('test')) return Promise.reject(otaError);
        return mockSubprocess();
      }) as never);

      // Maestro's own --debug-output artifacts replace the post-mortem logcat dump.
      await expect(runMaestroOta()).rejects.toThrow('OTA flow assertion failed');
      const logcatCalls = mockExeca.mock.calls.filter(
        (c) => c[0] === 'adb' && Array.isArray(c[1]) && c[1].includes('logcat')
      );
      expect(logcatCalls).toHaveLength(0);
    });
  });

  describe('setupOtaUpdate', () => {
    beforeEach(() => {
      buildSteps.order.length = 0;
      mockVerifyBundle.mockImplementation(() => {
        buildSteps.order.push('verify');
        return Promise.resolve();
      });
      process.env['API_URL'] = 'http://localhost:8787';
      process.env['HB_API_PORT'] = '8787';
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({}) })
      );
    });

    afterEach(() => {
      delete process.env['API_URL'];
      delete process.env['HB_API_PORT'];
      vi.unstubAllGlobals();
    });

    it('throws when API_URL is not set', async () => {
      delete process.env['API_URL'];

      await expect(setupOtaUpdate()).rejects.toThrow('API_URL not set');
    });

    it('throws when HB_API_PORT is not set', async () => {
      delete process.env['HB_API_PORT'];

      await expect(setupOtaUpdate()).rejects.toThrow('HB_API_PORT not set');
    });

    it('builds OTA bundle with correct VITE_PLATFORM and VITE_APP_VERSION', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);

      await setupOtaUpdate();

      const viteBuild = mockExeca.mock.calls.find(
        (call) =>
          call[0] === 'pnpm' &&
          Array.isArray(call[1]) &&
          call[1].includes('vite') &&
          call[1].includes('build')
      );
      expect(viteBuild).toBeDefined();
      const options = (
        viteBuild as unknown as [string, string[], { env?: Record<string, string> }]
      )[2];
      expect(options.env).toBeDefined();
      expect(options.env!['VITE_PLATFORM']).toBe('android-direct');
      expect(options.env!['VITE_APP_VERSION']).toBe('ota-v2');
    });

    it('uploads to platform-specific R2 key', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);

      await setupOtaUpdate();

      const r2Upload = mockExeca.mock.calls.find(
        (call) =>
          call[0] === 'pnpm' &&
          Array.isArray(call[1]) &&
          call[1].some((argument: string) => argument.includes('hushbox-app-builds'))
      );
      expect(r2Upload).toBeDefined();
      const r2Key = (r2Upload![1] as string[]).find((argument: string) =>
        argument.includes('hushbox-app-builds')
      );
      expect(r2Key).toBe('hushbox-app-builds/builds/android-direct/ota-v2.zip');
    });

    it("uploads into the store of the stack it runs under, never wrangler's default", async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);

      await setupOtaUpdate();

      const r2Upload = mockExeca.mock.calls.find(
        (call) =>
          call[0] === 'pnpm' &&
          Array.isArray(call[1]) &&
          call[1].some((argument: string) => argument.includes('hushbox-app-builds'))
      );
      const argv = r2Upload![1] as string[];
      expect(argv[argv.indexOf('--persist-to') + 1]).toBe(
        wranglerPersistPath(stackModeFrom(process.env))
      );
    });

    it('sets version override via dev endpoint', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await setupOtaUpdate();

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8787/dev/set-version', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 'ota-v2' }),
      });
    });

    it('publishes the sha256 of the zip it uploaded before setting the version', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
      const zipBytes = Buffer.from('the archive bytes wrangler uploads');
      vi.mocked(readFileSync).mockImplementation(((file: string) =>
        file.endsWith('ota-bundle.zip') ? zipBytes : '') as never);
      const mockFetch = vi.fn().mockResolvedValue({ ok: true });
      vi.stubGlobal('fetch', mockFetch);

      await setupOtaUpdate();

      expect(mockFetch).toHaveBeenCalledWith('http://localhost:8787/dev/set-checksum', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          platform: 'android-direct',
          checksum: createHash('sha256').update(zipBytes).digest('hex'),
        }),
      });
      // The client reads version and checksum from one response, so a device
      // polling between the two calls must never see the new version without
      // the checksum that lets it install.
      const endpoints = mockFetch.mock.calls.map((call) => String(call[0]));
      expect(endpoints.indexOf('http://localhost:8787/dev/set-checksum')).toBeLessThan(
        endpoints.indexOf('http://localhost:8787/dev/set-version')
      );
    });

    it('throws when the checksum publish request fails', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => Promise.resolve({ ok: !url.endsWith('/dev/set-checksum') }))
      );

      await expect(setupOtaUpdate()).rejects.toThrow('Failed to publish bundle checksum');
    });

    it('throws when version override request fails', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) => Promise.resolve({ ok: !url.endsWith('/dev/set-version') }))
      );

      await expect(setupOtaUpdate()).rejects.toThrow('Failed to set version override');
    });

    it('excludes the bundle zip itself when zipping dist-ota', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
      admZipFilters.captured.length = 0;

      await setupOtaUpdate();

      const filter = admZipFilters.captured.at(-1);
      expect(filter).toBeDefined();
      expect(filter!('ota-bundle.zip')).toBe(false);
      expect(filter!('index.html')).toBe(true);
    });

    it('verifies the built OTA dist under the web app own bundle declaration', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);

      await setupOtaUpdate();

      expect(mockVerifyBundle).toHaveBeenCalledTimes(1);
      const options = mockVerifyBundle.mock.calls[0]![0];
      expect(options.distributionDir.endsWith(path.join('apps', 'web', 'dist-ota'))).toBe(true);
      expect(options.shipsTts).toBe(true);
    });

    it('verifies the dist before the archive is written into it', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);

      await setupOtaUpdate();

      expect(buildSteps.order).toEqual(['verify', 'zip']);
    });

    it('fails the OTA setup when the built bundle carries backend environment material', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
      mockVerifyBundle.mockRejectedValue(
        new Error('Bundle verification failed: built artifact carries backend environment material')
      );

      await expect(setupOtaUpdate()).rejects.toThrow('backend environment material');
    });

    it('uploads nothing when verification fails', async () => {
      mockExeca.mockResolvedValue({ exitCode: 0, stdout: '' } as never);
      mockVerifyBundle.mockRejectedValue(new Error('Bundle verification failed'));

      await expect(setupOtaUpdate()).rejects.toThrow('Bundle verification failed');

      const r2Upload = mockExeca.mock.calls.find(
        (call) =>
          call[0] === 'pnpm' &&
          Array.isArray(call[1]) &&
          call[1].some((argument: string) => argument.includes('hushbox-app-builds'))
      );
      expect(r2Upload).toBeUndefined();
    });
  });
});
