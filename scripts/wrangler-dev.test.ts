import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';

vi.mock('execa', () => ({ execa: vi.fn() }));
// The ticker's own cadence, env gate and fire path are covered beside it in
// cron-trigger.test.ts; what this file owns is the wiring — that the dev server
// arms one and takes it down with wrangler — so the module is stubbed here.
vi.mock('./cron-trigger.js', () => ({ startDevCronTicker: vi.fn() }));
// Only the two writers are stubbed; the synchronous read API stays real.
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  createWriteStream: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { execa } from 'execa';
import { createWriteStream, existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startDevCronTicker } from './cron-trigger.js';
import {
  apiWorkerPorts,
  apiWorkerStartInput,
  runWranglerDev,
  watchesSource,
  wranglerLogPath,
  wranglerDebugLogPath,
  isSuppressedStderrLine,
  createStderrFilter,
  wranglerEnvFilePath,
  wranglerPersistPath,
} from './wrangler-dev.js';
import { portEnvName } from './lib/stack/dev-ports.js';
import { PORT_RANGE, STACK_MODES, portFor } from './lib/stack/port-plan.js';
import { e2eRamPaths } from './lib/stack/ram-root.js';

const mockExeca = vi.mocked(execa);
const mockStartDevCronTicker = vi.mocked(startDevCronTicker);
const mockCreateWriteStream = vi.mocked(createWriteStream);
const mockWriteFileSync = vi.mocked(writeFileSync);

const REPO_ROOT = path.join(import.meta.dirname, '..');
const WRANGLER_STATE = path.join(REPO_ROOT, 'apps', 'api', '.wrangler', 'state');
const API_WORKER_ENTRY = path.join(import.meta.dirname, 'lib', 'wrangler', 'api-worker-entry.ts');

interface MockSubprocess {
  stdout: PassThrough;
  stderr: PassThrough;
  then: Promise<{ exitCode: number | undefined }>['then'];
}

function mockSubprocess(exitCode: number | null = 0): {
  subprocess: MockSubprocess;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  // null sentinel → simulate execa's { exitCode: undefined } (kill/signal exit)
  const promise = Promise.resolve({ exitCode: exitCode ?? undefined });
  return {
    subprocess: Object.assign(promise, { stdout, stderr }) as unknown as MockSubprocess,
    stdout,
    stderr,
  };
}

function deferredSubprocess(): {
  subprocess: MockSubprocess;
  resolveExit: (exitCode: number) => void;
} {
  let resolveExit: (exitCode: number) => void = () => {};
  const promise = new Promise<{ exitCode: number | undefined }>((resolve) => {
    resolveExit = (exitCode) => {
      resolve({ exitCode });
    };
  });
  return {
    subprocess: Object.assign(promise, {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
    }) as unknown as MockSubprocess,
    resolveExit,
  };
}

function mockLogStream(): PassThrough & { end: ReturnType<typeof vi.fn> } {
  const stream = new PassThrough() as PassThrough & { end: ReturnType<typeof vi.fn> };
  const realEnd = stream.end.bind(stream);
  stream.end = vi.fn((...args: unknown[]) => realEnd(...(args as Parameters<typeof realEnd>)));
  return stream;
}

/** A scratch persist root nothing has run in, so no launch here reads a live stack's root. */
let emptyPersistRoot: string;

beforeEach(async () => {
  emptyPersistRoot = await mkdtemp(path.join(os.tmpdir(), 'wrangler-dev-persist-'));
});

afterEach(async () => {
  await rm(emptyPersistRoot, { recursive: true, force: true });
});

describe('wrangler-dev', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['HB_API_PORT'];
    delete process.env['HB_API_INSPECTOR_PORT'];
    delete process.env['HB_ENV_MODE'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    { stack: 'development default', envMode: undefined },
    { stack: 'e2e', envMode: 'e2e' },
  ])(
    'runs the Worker entry under this Node, quiet and with the trace collector off, in the $stack stack',
    async ({ envMode }) => {
      process.env['HB_API_PORT'] = '8915';
      process.env['HB_API_INSPECTOR_PORT'] = '8916';
      if (envMode !== undefined) process.env['HB_ENV_MODE'] = envMode;
      mockCreateWriteStream.mockReturnValue(mockLogStream() as never);
      const { subprocess } = mockSubprocess(0);
      mockExeca.mockReturnValue(subprocess as never);

      const exitCode = await runWranglerDev([], () => emptyPersistRoot);

      expect(mockExeca).toHaveBeenCalledWith(
        process.execPath,
        ['--no-warnings', '--import', 'tsx', API_WORKER_ENTRY],
        {
          stdio: ['inherit', 'pipe', 'pipe'],
          reject: false,
          env: {
            WRANGLER_LOG_PATH: wranglerDebugLogPath('8915'),
            WRANGLER_LOG: 'error',
            X_LOCAL_OBSERVABILITY: 'false',
          },
        }
      );
      expect(exitCode).toBe(0);
    }
  );

  it('spawns an entry that exists', () => {
    expect(existsSync(API_WORKER_ENTRY)).toBe(true);
  });

  it('refuses an argument, naming itself as the place to change how the Worker runs', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';

    await expect(runWranglerDev(['--ip', '0.0.0.0'])).rejects.toThrow('scripts/wrangler-dev.ts');
    expect(mockExeca).not.toHaveBeenCalled();
  });

  it('keeps the E2E stack from watching its source', () => {
    expect(watchesSource('e2e')).toBe(false);
  });

  it('keeps the development stack watching its source', () => {
    expect(watchesSource('development')).toBe(true);
  });

  it('builds the E2E Worker start from the stack’s own files and ports, with watching off', () => {
    expect(apiWorkerStartInput('e2e', { port: 8915, inspectorPort: 8916 })).toEqual({
      config: path.join(import.meta.dirname, '..', 'apps', 'api', 'wrangler.toml'),
      envFiles: [wranglerEnvFilePath('e2e')],
      build: { custom: { command: '' } },
      dev: {
        server: { port: 8915 },
        inspector: { port: 8916 },
        persist: wranglerPersistPath('e2e'),
        logLevel: 'error',
        watch: false,
      },
    });
  });

  it.each(STACK_MODES)(
    'starts the %s Worker with the config’s build command overridden by none',
    (stackMode) => {
      // Wrangler falls back to the config's command for an absent or undefined
      // one, so only the empty string clears it.
      expect(apiWorkerStartInput(stackMode, { port: 8915, inspectorPort: 8916 })).toHaveProperty(
        ['build', 'custom', 'command'],
        ''
      );
    }
  );

  it('starts the development Worker watching its source', () => {
    expect(apiWorkerStartInput('development', { port: 8915, inspectorPort: 8916 }).dev.watch).toBe(
      true
    );
  });

  it('loads the backend env file of the stack it was told to run', () => {
    expect(apiWorkerStartInput('e2e', { port: 8915, inspectorPort: 8916 }).envFiles).toEqual([
      wranglerEnvFilePath('e2e'),
    ]);
  });

  it('persists into the state directory of the stack it was told to run', () => {
    expect(apiWorkerStartInput('e2e', { port: 8915, inspectorPort: 8916 }).dev.persist).toBe(
      wranglerPersistPath('e2e')
    );
  });

  it('reads both ports from the stack’s env', () => {
    expect(
      apiWorkerPorts({ HB_API_PORT: '8915', HB_API_INSPECTOR_PORT: '8916' }, 'development')
    ).toEqual({ port: 8915, inspectorPort: 8916 });
  });

  it('refuses a port that is not a number, naming the variable', () => {
    expect(() =>
      apiWorkerPorts({ HB_API_PORT: 'eighty', HB_API_INSPECTOR_PORT: '8916' }, 'development')
    ).toThrow('HB_API_PORT');
  });

  it('names a different backend env file for each stack', () => {
    expect(wranglerEnvFilePath('development')).not.toBe(wranglerEnvFilePath('e2e'));
    expect(wranglerEnvFilePath('development')).toMatch(/apps\/api\/\.dev\.vars$/);
    expect(wranglerEnvFilePath('e2e')).toMatch(/apps\/api\/\.dev\.vars\.e2e$/);
  });

  it('names a different persistence directory for each stack', () => {
    expect(wranglerPersistPath('development')).not.toBe(wranglerPersistPath('e2e'));
  });

  it.each(['development', 'test'] as const)(
    'keeps the %s stack’s persistence directory in wrangler’s own state tree on Linux',
    (stackMode) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

      expect(wranglerPersistPath(stackMode)).toBe(path.join(WRANGLER_STATE, stackMode));
    }
  );

  it.each(['darwin', 'win32'] as const)(
    'keeps the e2e stack’s persistence directory in wrangler’s own state tree on %s',
    (platform) => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);

      expect(wranglerPersistPath('e2e')).toBe(path.join(WRANGLER_STATE, 'e2e'));
    }
  );

  it('puts the e2e stack’s persistence directory in the RAM root on Linux', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    const ramRoot = e2eRamPaths()?.root ?? '';

    expect(path.relative(ramRoot, wranglerPersistPath('e2e'))).not.toMatch(/^\.\.|^$/);
  });

  it('puts the e2e stack’s persistence directory outside the repository on Linux', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    expect(path.relative(REPO_ROOT, wranglerPersistPath('e2e'))).toMatch(/^\.\./);
  });

  it('draws the inspector port from the allocated band, one per stack', () => {
    const development = portFor('apiInspector', { slot: 0, mode: 'development' });
    const e2e = portFor('apiInspector', { slot: 0, mode: 'e2e' });

    expect(development).not.toBe(e2e);
    for (const port of [development, e2e]) {
      expect(port).toBeGreaterThanOrEqual(PORT_RANGE.first);
      expect(port).toBeLessThanOrEqual(PORT_RANGE.last);
    }
  });

  it('takes the inspector port from the variable the port plan mints for it', () => {
    const env = { HB_API_PORT: '8915', [portEnvName('apiInspector')]: '8916' };

    expect(apiWorkerPorts(env, 'development').inspectorPort).toBe(8916);
  });

  it('names the stack whose env files lack the inspector port, and how to rewrite them', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_ENV_MODE'] = 'e2e';

    await expect(runWranglerDev([])).rejects.toThrow(
      "HB_API_INSPECTOR_PORT is not set for the e2e stack — run `pnpm generate:env --mode=e2e` to regenerate that stack's env files"
    );
  });

  it('refuses a stack mode it does not recognise, naming the variable', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';
    process.env['HB_ENV_MODE'] = 'staging';

    await expect(runWranglerDev([])).rejects.toThrow('HB_ENV_MODE');
  });

  it('opens the per-port log file with truncate-on-start', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';
    mockCreateWriteStream.mockReturnValue(mockLogStream() as never);
    const { subprocess } = mockSubprocess(0);
    mockExeca.mockReturnValue(subprocess as never);

    await runWranglerDev([]);

    expect(mockCreateWriteStream).toHaveBeenCalledWith(wranglerLogPath('8915'), { flags: 'w' });
  });

  it('uses a port-suffixed log filename so multi-worktree runs do not collide', () => {
    expect(wranglerLogPath('8915')).toMatch(/apps\/api\/\.wrangler-8915\.log$/);
    expect(wranglerLogPath('8787')).toMatch(/apps\/api\/\.wrangler-8787\.log$/);
  });

  it('uses a port-suffixed debug log filename so multi-worktree runs do not collide', () => {
    expect(wranglerDebugLogPath('8915')).toMatch(/apps\/api\/\.wrangler-debug-8915\.log$/);
    expect(wranglerDebugLogPath('8787')).toMatch(/apps\/api\/\.wrangler-debug-8787\.log$/);
  });

  it('truncates the debug log before the Worker starts appending to it', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';
    mockCreateWriteStream.mockReturnValue(mockLogStream() as never);
    const { subprocess } = mockSubprocess(0);
    mockExeca.mockReturnValue(subprocess as never);

    await runWranglerDev([]);

    expect(mockWriteFileSync).toHaveBeenCalledWith(wranglerDebugLogPath('8915'), '');
    expect(mockWriteFileSync.mock.invocationCallOrder[0]).toBeLessThan(
      mockExeca.mock.invocationCallOrder[0]!
    );
  });

  it('tees subprocess stdout to both the terminal and the log file', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';
    const log = mockLogStream();
    mockCreateWriteStream.mockReturnValue(log as never);
    const { subprocess, stdout } = mockSubprocess(0);
    mockExeca.mockReturnValue(subprocess as never);

    process.stdout.write = vi.fn(() => true) as never;

    const logChunks: Buffer[] = [];
    log.on('data', (chunk: Buffer) => logChunks.push(chunk));

    const runPromise = runWranglerDev([]);
    stdout.write('hello stdout\n');
    stdout.end();
    await runPromise;

    expect(Buffer.concat(logChunks).toString()).toContain('hello stdout');
  });

  it('tees subprocess stderr to the log file', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';
    const log = mockLogStream();
    mockCreateWriteStream.mockReturnValue(log as never);
    const { subprocess, stderr } = mockSubprocess(0);
    mockExeca.mockReturnValue(subprocess as never);

    const logChunks: Buffer[] = [];
    log.on('data', (chunk: Buffer) => logChunks.push(chunk));

    const runPromise = runWranglerDev([]);
    stderr.write('boom\n');
    stderr.end();
    await runPromise;

    expect(Buffer.concat(logChunks).toString()).toContain('boom');
  });

  it('closes the log stream after the subprocess exits', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';
    const log = mockLogStream();
    mockCreateWriteStream.mockReturnValue(log as never);
    const { subprocess } = mockSubprocess(0);
    mockExeca.mockReturnValue(subprocess as never);

    await runWranglerDev([]);

    expect(log.end).toHaveBeenCalled();
  });

  it('propagates child exit code', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';
    mockCreateWriteStream.mockReturnValue(mockLogStream() as never);
    const { subprocess } = mockSubprocess(3);
    mockExeca.mockReturnValue(subprocess as never);

    expect(await runWranglerDev([])).toBe(3);
  });

  it('returns 1 when child has no numeric exit code', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';
    mockCreateWriteStream.mockReturnValue(mockLogStream() as never);
    const { subprocess } = mockSubprocess(null);
    mockExeca.mockReturnValue(subprocess as never);

    expect(await runWranglerDev([])).toBe(1);
  });

  it('names the stack whose env files lack the API port, and how to rewrite them', async () => {
    await expect(runWranglerDev([])).rejects.toThrow(
      "HB_API_PORT is not set for the development stack — run `pnpm generate:env --mode=development` to regenerate that stack's env files"
    );
  });

  it('arms the cron ticker from the process environment and stops it when the Worker exits', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';
    mockCreateWriteStream.mockReturnValue(mockLogStream() as never);
    const stop = vi.fn();
    mockStartDevCronTicker.mockReturnValue({ stop });
    const { subprocess, resolveExit } = deferredSubprocess();
    mockExeca.mockReturnValue(subprocess as never);

    const runPromise = runWranglerDev([]);

    expect(mockStartDevCronTicker).toHaveBeenCalledWith(process.env);
    expect(stop).not.toHaveBeenCalled();
    resolveExit(0);
    await runPromise;
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('runs on when the environment arms no ticker', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';
    mockCreateWriteStream.mockReturnValue(mockLogStream() as never);
    mockStartDevCronTicker.mockReturnValue(null);
    const { subprocess } = mockSubprocess(0);
    mockExeca.mockReturnValue(subprocess as never);

    expect(await runWranglerDev([])).toBe(0);
  });

  it('filters benign disconnect noise from the terminal but keeps it in the log', async () => {
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';
    const log = mockLogStream();
    mockCreateWriteStream.mockReturnValue(log as never);
    const { subprocess, stderr } = mockSubprocess(0);
    mockExeca.mockReturnValue(subprocess as never);

    const originalWrite = process.stderr.write;
    const termChunks: string[] = [];
    process.stderr.write = vi.fn((chunk: string | Uint8Array) => {
      termChunks.push(chunk.toString());
      return true;
    }) as never;
    const logChunks: Buffer[] = [];
    log.on('data', (chunk: Buffer) => logChunks.push(chunk));

    try {
      const runPromise = runWranglerDev([]);
      stderr.write('[ERROR] Uncaught Error: Network connection lost\nreal failure\n');
      stderr.end();
      await runPromise;
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      process.stderr.write = originalWrite;
    }

    const term = termChunks.join('');
    const logged = Buffer.concat(logChunks).toString();
    expect(term).not.toContain('Network connection lost');
    expect(term).toContain('real failure');
    expect(logged).toContain('Network connection lost');
    expect(logged).toContain('real failure');
  });
});

describe('an E2E launch over a persist root an earlier Worker ran in', () => {
  const JOB_DISPATCHER_DATABASE = path.join(
    'v3',
    'do',
    'hushbox-api-JobDispatcher',
    'metadata.sqlite'
  );
  const TRACE_STORE = path.join('v3', 'observability', 'miniflare-wobs-trace-store');

  beforeEach(() => {
    vi.clearAllMocks();
    process.env['HB_API_PORT'] = '8915';
    process.env['HB_API_INSPECTOR_PORT'] = '8916';
    process.env['HB_ENV_MODE'] = 'e2e';
    mockCreateWriteStream.mockReturnValue(mockLogStream() as never);
    mockExeca.mockReturnValue(mockSubprocess(0).subprocess as never);
  });

  afterEach(() => {
    delete process.env['HB_API_PORT'];
    delete process.env['HB_API_INSPECTOR_PORT'];
    delete process.env['HB_ENV_MODE'];
  });

  async function plant(entry: string): Promise<void> {
    await mkdir(path.join(emptyPersistRoot, path.dirname(entry)), { recursive: true });
    await writeFile(path.join(emptyPersistRoot, entry), '');
  }

  it('refuses a root holding Durable Object storage, naming the root', async () => {
    await plant(JOB_DISPATCHER_DATABASE);

    await expect(runWranglerDev([], () => emptyPersistRoot)).rejects.toThrow(emptyPersistRoot);
  });

  it('refuses a root holding Durable Object storage, naming the stale entry', async () => {
    await plant(JOB_DISPATCHER_DATABASE);

    await expect(runWranglerDev([], () => emptyPersistRoot)).rejects.toThrow(
      JOB_DISPATCHER_DATABASE
    );
  });

  it('refuses a root holding the trace collector’s store, naming the stale entry', async () => {
    await plant(TRACE_STORE);

    await expect(runWranglerDev([], () => emptyPersistRoot)).rejects.toThrow(TRACE_STORE);
  });

  it('refuses a root holding an empty Durable Object directory, naming the directory', async () => {
    await mkdir(path.join(emptyPersistRoot, 'v3', 'do'), { recursive: true });

    await expect(runWranglerDev([], () => emptyPersistRoot)).rejects.toThrow(path.join('v3', 'do'));
  });

  it('starts nothing over a root it refuses', async () => {
    await plant(JOB_DISPATCHER_DATABASE);

    await expect(runWranglerDev([], () => emptyPersistRoot)).rejects.toThrow(emptyPersistRoot);

    expect(mockExeca).not.toHaveBeenCalled();
    expect(mockWriteFileSync).not.toHaveBeenCalled();
  });

  it('starts over an empty root', async () => {
    expect(await runWranglerDev([], () => emptyPersistRoot)).toBe(0);
    expect(mockExeca).toHaveBeenCalledTimes(1);
  });

  it('starts over a root that does not exist yet', async () => {
    const absent = path.join(emptyPersistRoot, 'not-made-yet');

    expect(await runWranglerDev([], () => absent)).toBe(0);
  });

  it('starts over a root holding only what the weights seed writes', async () => {
    await plant(path.join('v3', 'r2', 'hushbox-model-weights', 'blobs', 'weights'));
    await plant(path.join('v3', 'cache', 'miniflare-CacheObject', 'metadata.sqlite'));

    expect(await runWranglerDev([], () => emptyPersistRoot)).toBe(0);
  });

  it('starts the development Worker over the state its earlier runs left', async () => {
    process.env['HB_ENV_MODE'] = 'development';
    await plant(JOB_DISPATCHER_DATABASE);

    expect(await runWranglerDev([], () => emptyPersistRoot)).toBe(0);
  });

  it('reads the root of the stack it was told to run', async () => {
    const asked: string[] = [];

    await runWranglerDev([], (stackMode) => {
      asked.push(stackMode);
      return emptyPersistRoot;
    });

    expect(asked).toEqual(['e2e']);
  });
});

describe('isSuppressedStderrLine', () => {
  it('suppresses the workerd broken-pipe disconnect message', () => {
    expect(
      isSuppressedStderrLine(
        'kj::getCaughtExceptionAsKj() = kj/async-io-unix.c++:186: disconnected: ::write(fd, buffer.begin(), buffer.size()): Broken pipe'
      )
    ).toBe(true);
  });

  it('suppresses the workerd address-frame stack continuation line', () => {
    expect(
      isSuppressedStderrLine(
        '  stack: /a/bin/workerd@4f0cd3e /a/bin/workerd@4f0d8e1 /a/bin/workerd@34b832f'
      )
    ).toBe(true);
  });

  it('suppresses the Network connection lost uncaught error', () => {
    expect(isSuppressedStderrLine('[ERROR] Uncaught Error: Network connection lost')).toBe(true);
  });

  it('suppresses the in-promise variant of Network connection lost', () => {
    expect(
      isSuppressedStderrLine('✘ [ERROR] Uncaught (in promise) Error: Network connection lost')
    ).toBe(true);
  });

  it('keeps unrelated error lines', () => {
    expect(isSuppressedStderrLine('[ERROR] TypeError: cannot read properties of undefined')).toBe(
      false
    );
  });

  it('keeps normal JS stack frames', () => {
    expect(isSuppressedStderrLine('    at handler (apps/api/src/routes/chat.ts:42:7)')).toBe(false);
  });

  it('keeps a prose line that merely mentions a stack', () => {
    expect(isSuppressedStderrLine('  stack: something went wrong')).toBe(false);
  });

  it('keeps an unrelated broken-pipe-free disconnect line', () => {
    expect(isSuppressedStderrLine('disconnected: peer reset the channel')).toBe(false);
  });

  it('suppresses empty lines (Playwright would prefix them as bare [API])', () => {
    expect(isSuppressedStderrLine('')).toBe(true);
  });

  it('suppresses whitespace-only lines', () => {
    expect(isSuppressedStderrLine('   \t  ')).toBe(true);
  });
});

describe('createStderrFilter', () => {
  it('drops suppressed lines and forwards the rest, splitting on newlines', async () => {
    const filter = createStderrFilter();
    const out: string[] = [];
    filter.on('data', (chunk: Buffer) => out.push(chunk.toString()));
    filter.write('keep me\n[ERROR] Uncaught Error: Network connection lost\nkeep me too\n');
    filter.end();
    await new Promise((resolve) => filter.on('end', resolve));

    const joined = out.join('');
    expect(joined).toContain('keep me');
    expect(joined).toContain('keep me too');
    expect(joined).not.toContain('Network connection lost');
  });

  it('forwards a partial final line that has no trailing newline on flush', async () => {
    const filter = createStderrFilter();
    const out: string[] = [];
    filter.on('data', (chunk: Buffer) => out.push(chunk.toString()));
    filter.write('partial without newline');
    filter.end();
    await new Promise((resolve) => filter.on('end', resolve));

    expect(out.join('')).toContain('partial without newline');
  });

  it('drops a suppressed partial final line on flush', async () => {
    const filter = createStderrFilter();
    const out: string[] = [];
    filter.on('data', (chunk: Buffer) => out.push(chunk.toString()));
    filter.write('[ERROR] Uncaught Error: Network connection lost');
    filter.end();
    await new Promise((resolve) => filter.on('end', resolve));

    expect(out.join('')).toBe('');
  });

  it('drops blank lines surrounding a suppressed error block', async () => {
    const filter = createStderrFilter();
    const out: string[] = [];
    filter.on('data', (chunk: Buffer) => out.push(chunk.toString()));
    filter.write('\n[ERROR] Uncaught Error: Network connection lost\n\nafter\n');
    filter.end();
    await new Promise((resolve) => filter.on('end', resolve));

    expect(out.join('')).toBe('after\n');
  });

  it('reassembles a line split across two chunks', async () => {
    const filter = createStderrFilter();
    const out: string[] = [];
    filter.on('data', (chunk: Buffer) => out.push(chunk.toString()));
    filter.write('Uncaught Error: Network ');
    filter.write('connection lost\nkept\n');
    filter.end();
    await new Promise((resolve) => filter.on('end', resolve));

    const joined = out.join('');
    expect(joined).not.toContain('Network connection lost');
    expect(joined).toContain('kept');
  });
});
