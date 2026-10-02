import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { installSignalShutdown } from './shutdown';
import type { SignalTarget } from './shutdown';

function fakeTarget(): SignalTarget & { handlers: (() => void)[]; removed: (() => void)[] } {
  const handlers: (() => void)[] = [];
  const removed: (() => void)[] = [];
  return {
    handlers,
    removed,
    on(_signal, handler) {
      handlers.push(handler);
    },
    off(_signal, handler) {
      removed.push(handler);
    },
  };
}

describe('installSignalShutdown', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('listens for a termination signal', () => {
    const target = fakeTarget();
    const on = vi.spyOn(target, 'on');

    installSignalShutdown({ close: vi.fn(), log: vi.fn(), target });

    expect(on).toHaveBeenCalledWith('SIGTERM', expect.any(Function));
  });

  it('closes the console when the signal arrives', () => {
    const target = fakeTarget();
    const close = vi.fn();
    installSignalShutdown({ close, log: vi.fn(), target, forceExit: vi.fn() });

    target.handlers[0]?.();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('says why the console is going away', () => {
    const target = fakeTarget();
    const log = vi.fn();
    installSignalShutdown({ close: vi.fn(), log, target, forceExit: vi.fn() });

    target.handlers[0]?.();

    expect(log.mock.calls.flat().join(' ')).toContain('shutting down');
  });

  it('ends the process once the close finishes', async () => {
    const target = fakeTarget();
    const forceExit = vi.fn();
    installSignalShutdown({ close: () => Promise.resolve(), log: vi.fn(), target, forceExit });

    target.handlers[0]?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(forceExit).toHaveBeenCalledWith(0);
  });

  it('ends the process anyway when the close never finishes', async () => {
    const target = fakeTarget();
    const forceExit = vi.fn();
    installSignalShutdown({
      close: () => new Promise<void>(() => {}),
      log: vi.fn(),
      target,
      forceExit,
      graceMs: 5000,
    });

    target.handlers[0]?.();
    await vi.advanceTimersByTimeAsync(5000);

    expect(forceExit).toHaveBeenCalledWith(0);
  });

  it('leaves the process alone while the close is still inside its grace', async () => {
    const target = fakeTarget();
    const forceExit = vi.fn();
    installSignalShutdown({
      close: () => new Promise<void>(() => {}),
      log: vi.fn(),
      target,
      forceExit,
      graceMs: 5000,
    });

    target.handlers[0]?.();
    await vi.advanceTimersByTimeAsync(4999);

    expect(forceExit).not.toHaveBeenCalled();
  });

  it('ends the process when the close fails', async () => {
    const target = fakeTarget();
    const forceExit = vi.fn();
    installSignalShutdown({
      close: () => Promise.reject(new Error('teardown blew up')),
      log: vi.fn(),
      target,
      forceExit,
    });

    target.handlers[0]?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(forceExit).toHaveBeenCalledWith(0);
  });

  it('says so when the close fails rather than raising past the handler', async () => {
    const target = fakeTarget();
    const log = vi.fn();
    installSignalShutdown({
      close: () => Promise.reject(new Error('teardown blew up')),
      log,
      target,
      forceExit: vi.fn(),
    });

    target.handlers[0]?.();
    await vi.advanceTimersByTimeAsync(0);

    expect(log.mock.calls.flat().join(' ')).toContain('shutdown failed');
  });

  it('starts one shutdown however many signals arrive', () => {
    const target = fakeTarget();
    const close = vi.fn();
    installSignalShutdown({ close, log: vi.fn(), target, forceExit: vi.fn() });

    target.handlers[0]?.();
    target.handlers[0]?.();

    expect(close).toHaveBeenCalledTimes(1);
  });

  it('stops listening once uninstalled', () => {
    const target = fakeTarget();
    const uninstall = installSignalShutdown({ close: vi.fn(), log: vi.fn(), target });

    uninstall();

    expect(target.removed).toHaveLength(1);
    expect(target.removed).toEqual(target.handlers);
  });

  it('listens on this process when no target is injected', () => {
    const before = process.listenerCount('SIGTERM');

    const uninstall = installSignalShutdown({ close: vi.fn(), log: vi.fn() });
    const during = process.listenerCount('SIGTERM');
    uninstall();

    expect(during).toBe(before + 1);
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });

  it('ends this process when no exit is injected', async () => {
    const codes: (number | undefined)[] = [];
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      codes.push(code);
    }) as never);
    const installed = process.listeners('SIGTERM');
    const uninstall = installSignalShutdown({ close: vi.fn(), log: vi.fn() });
    const handler = process.listeners('SIGTERM').find((entry) => !installed.includes(entry));

    (handler as (() => void) | undefined)?.();
    await vi.advanceTimersByTimeAsync(0);
    uninstall();
    exit.mockRestore();

    expect(codes).toEqual([0]);
  });
});

describe('installSignalShutdown in a live process', () => {
  const modulePath = path.join(import.meta.dirname, 'shutdown.ts');
  const tsxLoader = createRequire(import.meta.filename).resolve('tsx');

  it('leaves no process behind when a signalled close never returns', async () => {
    const script = [
      `const { installSignalShutdown } = await import(${JSON.stringify(modulePath)});`,
      // Stands in for the dev server's own open handles: without a forced exit
      // the process outlives its released port for as long as the machine runs.
      `setInterval(() => {}, 1_000);`,
      // Stands in for the dev server's own signal handler, which awaits a
      // teardown with no timeout. Its mere presence suppresses the default
      // termination, so a hung teardown leaves the process alive for ever.
      `process.on('SIGTERM', () => new Promise(() => {}));`,
      `installSignalShutdown({`,
      `  close: () => new Promise(() => {}),`,
      `  log: () => {},`,
      `  graceMs: 200,`,
      `});`,
      `process.send?.('ready');`,
    ].join('\n');

    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, '--input-type=module', '--eval', script],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
    );
    await new Promise<void>((resolve) => {
      child.once('message', () => {
        resolve();
      });
    });
    child.kill('SIGTERM');

    const outcome = await new Promise<number | 'still running'>((resolve) => {
      const giveUp = setTimeout(() => {
        resolve('still running');
      }, 10_000);
      child.on('exit', (code) => {
        clearTimeout(giveUp);
        resolve(code ?? -1);
      });
    });
    child.kill('SIGKILL');

    expect(outcome).toBe(0);
  }, 20_000);
});
