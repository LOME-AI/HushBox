import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PassThrough } from 'node:stream';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('node:fs', () => ({ createWriteStream: vi.fn() }));

import { execa } from 'execa';
import { createWriteStream } from 'node:fs';
import { runWranglerDev, wranglerLogPath } from './wrangler-dev.js';

const mockExeca = vi.mocked(execa);
const mockCreateWriteStream = vi.mocked(createWriteStream);

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

function mockLogStream(): PassThrough & { end: ReturnType<typeof vi.fn> } {
  const stream = new PassThrough() as PassThrough & { end: ReturnType<typeof vi.fn> };
  const realEnd = stream.end.bind(stream);
  stream.end = vi.fn((...args: unknown[]) => realEnd(...(args as Parameters<typeof realEnd>)));
  return stream;
}

describe('wrangler-dev', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['HB_API_PORT'];
  });

  it('spawns wrangler dev with port from HB_API_PORT and --log-level error', async () => {
    process.env['HB_API_PORT'] = '8915';
    mockCreateWriteStream.mockReturnValue(mockLogStream() as never);
    const { subprocess } = mockSubprocess(0);
    mockExeca.mockReturnValue(subprocess as never);

    const exitCode = await runWranglerDev([]);

    expect(mockExeca).toHaveBeenCalledWith(
      'wrangler',
      ['dev', '--port', '8915', '--log-level', 'error'],
      { stdio: ['inherit', 'pipe', 'pipe'], reject: false }
    );
    expect(exitCode).toBe(0);
  });

  it('forwards extra args after the built-in --log-level error', async () => {
    process.env['HB_API_PORT'] = '8915';
    mockCreateWriteStream.mockReturnValue(mockLogStream() as never);
    const { subprocess } = mockSubprocess(0);
    mockExeca.mockReturnValue(subprocess as never);

    await runWranglerDev(['--ip', '0.0.0.0']);

    expect(mockExeca).toHaveBeenCalledWith(
      'wrangler',
      ['dev', '--port', '8915', '--log-level', 'error', '--ip', '0.0.0.0'],
      { stdio: ['inherit', 'pipe', 'pipe'], reject: false }
    );
  });

  it('opens the per-port log file with truncate-on-start', async () => {
    process.env['HB_API_PORT'] = '8915';
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

  it('tees subprocess stdout to both the terminal and the log file', async () => {
    process.env['HB_API_PORT'] = '8915';
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
    const log = mockLogStream();
    mockCreateWriteStream.mockReturnValue(log as never);
    const { subprocess } = mockSubprocess(0);
    mockExeca.mockReturnValue(subprocess as never);

    await runWranglerDev([]);

    expect(log.end).toHaveBeenCalled();
  });

  it('propagates child exit code', async () => {
    process.env['HB_API_PORT'] = '8915';
    mockCreateWriteStream.mockReturnValue(mockLogStream() as never);
    const { subprocess } = mockSubprocess(3);
    mockExeca.mockReturnValue(subprocess as never);

    expect(await runWranglerDev([])).toBe(3);
  });

  it('returns 1 when child has no numeric exit code', async () => {
    process.env['HB_API_PORT'] = '8915';
    mockCreateWriteStream.mockReturnValue(mockLogStream() as never);
    const { subprocess } = mockSubprocess(null);
    mockExeca.mockReturnValue(subprocess as never);

    expect(await runWranglerDev([])).toBe(1);
  });

  it('throws when HB_API_PORT is unset', async () => {
    await expect(runWranglerDev([])).rejects.toThrow(
      'HB_API_PORT is not set — run pnpm generate:env first'
    );
  });
});
