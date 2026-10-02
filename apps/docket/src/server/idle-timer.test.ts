import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MINUTE_MS } from '@hushbox/shared/durations';
import { startIdleTimer } from './idle-timer';
import type { IdleTimer } from './idle-timer';

describe('startIdleTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('expires after the idle window when nothing happens', () => {
    const onExpire = vi.fn();
    startIdleTimer({ minutes: 30, onExpire });

    vi.advanceTimersByTime(30 * MINUTE_MS);

    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('has not expired one tick before the window closes', () => {
    const onExpire = vi.fn();
    startIdleTimer({ minutes: 30, onExpire });

    vi.advanceTimersByTime(30 * MINUTE_MS - 1);

    expect(onExpire).not.toHaveBeenCalled();
  });

  it('pushes expiry out on every touch', () => {
    const onExpire = vi.fn();
    const timer = startIdleTimer({ minutes: 10, onExpire });

    for (let elapsed = 0; elapsed < 50 * MINUTE_MS; elapsed += 5 * MINUTE_MS) {
      vi.advanceTimersByTime(5 * MINUTE_MS);
      timer.touch();
    }

    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10 * MINUTE_MS);
    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('never expires once stopped', () => {
    const onExpire = vi.fn();
    const timer = startIdleTimer({ minutes: 1, onExpire });

    timer.stop();
    vi.advanceTimersByTime(60 * MINUTE_MS);

    expect(onExpire).not.toHaveBeenCalled();
  });

  it('expires once, not on every window after it', () => {
    const onExpire = vi.fn();
    startIdleTimer({ minutes: 1, onExpire, forceExit: vi.fn() });

    vi.advanceTimersByTime(10 * MINUTE_MS);

    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('ignores a touch that arrives after expiry, so a dying server is not revived', () => {
    const onExpire = vi.fn();
    const timer = startIdleTimer({ minutes: 1, onExpire, forceExit: vi.fn() });

    vi.advanceTimersByTime(1 * MINUTE_MS);
    timer.touch();
    vi.advanceTimersByTime(10 * MINUTE_MS);

    expect(onExpire).toHaveBeenCalledTimes(1);
  });

  it('ends the process itself when the shutdown never returns', async () => {
    const forceExit = vi.fn();
    startIdleTimer({
      minutes: 1,
      graceMs: 5000,
      forceExit,
      onExpire: () => new Promise<void>(() => {}),
    });

    await vi.advanceTimersByTimeAsync(1 * MINUTE_MS + 5000);

    expect(forceExit).toHaveBeenCalledWith(0);
  });

  it('leaves the process alone while the shutdown is still inside its grace', async () => {
    const forceExit = vi.fn();
    startIdleTimer({
      minutes: 1,
      graceMs: 5000,
      forceExit,
      onExpire: () => new Promise<void>(() => {}),
    });

    await vi.advanceTimersByTimeAsync(1 * MINUTE_MS + 4999);

    expect(forceExit).not.toHaveBeenCalled();
  });

  it('never ends the process when the shutdown returns', async () => {
    const forceExit = vi.fn();
    startIdleTimer({ minutes: 1, graceMs: 5000, forceExit, onExpire: () => Promise.resolve() });

    await vi.advanceTimersByTimeAsync(60 * MINUTE_MS);

    expect(forceExit).not.toHaveBeenCalled();
  });

  it('keeps the forced exit armed when the shutdown stops the timer', async () => {
    const forceExit = vi.fn();
    const timer: IdleTimer = startIdleTimer({
      minutes: 1,
      graceMs: 5000,
      forceExit,
      onExpire: () => {
        timer.stop();
        return new Promise<void>(() => {});
      },
    });

    await vi.advanceTimersByTimeAsync(1 * MINUTE_MS + 5000);

    expect(forceExit).toHaveBeenCalledWith(0);
  });
});

describe('startIdleTimer in a live process', () => {
  const modulePath = path.join(import.meta.dirname, 'idle-timer.ts');
  const tsxLoader = createRequire(import.meta.filename).resolve('tsx');

  it('leaves no process behind when the shutdown never returns', async () => {
    const script = [
      `const { startIdleTimer } = await import(${JSON.stringify(modulePath)});`,
      // Stands in for the dev server's own open handles: without a forced exit
      // the process outlives its released port for as long as the machine runs.
      `setInterval(() => {}, 1_000);`,
      `startIdleTimer({ minutes: 0.001, graceMs: 200, onExpire: () => new Promise(() => {}) });`,
    ].join('\n');

    const child = spawn(
      process.execPath,
      ['--import', tsxLoader, '--input-type=module', '--eval', script],
      { stdio: 'ignore' }
    );
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
