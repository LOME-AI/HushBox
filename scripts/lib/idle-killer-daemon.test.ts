/* eslint-disable @typescript-eslint/require-await -- mock fns intentionally async */
/* eslint-disable sonarjs/publicly-writable-directories -- /tmp paths in test fixtures */
import { describe, it, expect, vi } from 'vitest';
import {
  parseDaemonArgs,
  daemonLoop,
  type DaemonDeps,
  type DaemonOptions,
} from './idle-killer-daemon.js';

function fakeDeps(overrides: Partial<DaemonDeps> = {}): DaemonDeps {
  return {
    bindSingleton: vi.fn().mockResolvedValue({ close: vi.fn() }),
    readHeartbeatMtime: vi.fn().mockResolvedValue(Date.now()),
    portsHaveListeners: vi.fn().mockResolvedValue(false),
    composeDown: vi.fn(async () => {}),
    sleep: vi.fn(async () => {}),
    now: vi.fn().mockReturnValue(0),
    log: vi.fn(),
    ...overrides,
  };
}

function options(overrides: Partial<DaemonOptions> = {}): DaemonOptions {
  return {
    port: 7707,
    slot: 1,
    cacheDir: '/tmp/cache',
    ttlMs: 60_000,
    pollMs: 1000,
    composeProject: 'hushbox-1',
    repoRoot: '/tmp/repo',
    apiPort: 8788,
    vitePort: 5174,
    previewPort: 4174,
    ...overrides,
  };
}

describe('parseDaemonArgs', () => {
  it('parses --port --slot --ttl-ms --cache-dir', () => {
    const parsed = parseDaemonArgs([
      '--port',
      '7707',
      '--slot',
      '5',
      '--ttl-ms',
      '3600000',
      '--cache-dir',
      '/foo',
    ]);
    expect(parsed.port).toBe(7707);
    expect(parsed.slot).toBe(5);
    expect(parsed.ttlMs).toBe(3_600_000);
    expect(parsed.cacheDir).toBe('/foo');
  });

  it('throws on missing required flag', () => {
    expect(() => parseDaemonArgs(['--port', '7707'])).toThrow();
  });

  it('throws on a non-numeric port', () => {
    expect(() =>
      parseDaemonArgs(['--port', 'abc', '--slot', '1', '--ttl-ms', '60000', '--cache-dir', '/x'])
    ).toThrow();
  });

  it('throws on an odd-length argv (key without value)', () => {
    expect(() => parseDaemonArgs(['--port'])).toThrow(/malformed/);
  });

  it('throws on a non-numeric --ttl-ms', () => {
    expect(() =>
      parseDaemonArgs(['--port', '7707', '--slot', '1', '--ttl-ms', 'abc', '--cache-dir', '/x'])
    ).toThrow(/--ttl-ms/);
  });

  it('throws on a missing --cache-dir', () => {
    expect(() =>
      parseDaemonArgs(['--port', '7707', '--slot', '1', '--ttl-ms', '60000', '--cache-dir', ''])
    ).toThrow(/cache-dir/);
  });

  it('throws on a negative --slot', () => {
    expect(() =>
      parseDaemonArgs(['--port', '7707', '--slot', '-1', '--ttl-ms', '60000', '--cache-dir', '/x'])
    ).toThrow(/--slot/);
  });
});

describe('daemonLoop', () => {
  it('exits immediately when bindSingleton fails (another daemon already alive)', async () => {
    const deps = fakeDeps({
      bindSingleton: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('addr in use'), { code: 'EADDRINUSE' })),
    });
    const result = await daemonLoop(options(), deps);
    expect(result.exitReason).toBe('singleton-conflict');
    expect(deps.sleep).not.toHaveBeenCalled();
  });

  it('continues looping while heartbeat is fresh', async () => {
    let tick = 0;
    const deps = fakeDeps({
      now: vi.fn().mockImplementation(() => tick * 1000),
      readHeartbeatMtime: vi.fn().mockImplementation(() => tick * 1000),
      sleep: vi.fn().mockImplementation(async () => {
        tick += 1;
        if (tick > 3) throw new Error('halt-test');
      }),
    });
    await expect(daemonLoop(options({ ttlMs: 60_000 }), deps)).rejects.toThrow('halt-test');
    expect(deps.composeDown).not.toHaveBeenCalled();
  });

  it('continues looping when heartbeat is stale BUT ports have listeners (veto)', async () => {
    let iterations = 0;
    const deps = fakeDeps({
      now: vi.fn().mockReturnValue(1_000_000),
      readHeartbeatMtime: vi.fn().mockResolvedValue(0), // ~1000s old
      portsHaveListeners: vi.fn().mockResolvedValue(true),
      sleep: vi.fn().mockImplementation(async () => {
        iterations += 1;
        if (iterations > 2) throw new Error('halt-test');
      }),
    });
    await expect(daemonLoop(options({ ttlMs: 60_000 }), deps)).rejects.toThrow('halt-test');
    expect(deps.composeDown).not.toHaveBeenCalled();
  });

  it('tears down and exits when heartbeat is stale AND no ports have listeners', async () => {
    const deps = fakeDeps({
      now: vi.fn().mockReturnValue(1_000_000),
      readHeartbeatMtime: vi.fn().mockResolvedValue(0),
      portsHaveListeners: vi.fn().mockResolvedValue(false),
    });
    const result = await daemonLoop(options({ ttlMs: 60_000 }), deps);
    expect(deps.composeDown).toHaveBeenCalledWith('hushbox-1', '/tmp/repo');
    expect(result.exitReason).toBe('idle-teardown');
  });

  it('exits gracefully when readHeartbeatMtime returns null (no heartbeat ever recorded)', async () => {
    const deps = fakeDeps({
      readHeartbeatMtime: vi.fn().mockResolvedValue(null),
      portsHaveListeners: vi.fn().mockResolvedValue(false),
      now: vi.fn().mockReturnValue(1_000_000),
    });
    const result = await daemonLoop(options({ ttlMs: 60_000 }), deps);
    // No heartbeat → treat as infinitely stale → tear down.
    expect(deps.composeDown).toHaveBeenCalled();
    expect(result.exitReason).toBe('idle-teardown');
  });
});
