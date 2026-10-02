import { createServer, type Server } from 'node:http';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApiLivenessWatchdog, createHealthProbe } from './api-liveness-watchdog.js';
import { API_LIVENESS } from '../e2e/config/timeouts.js';
import type { ProbeOutcome } from './api-liveness-watchdog.js';
import type { AddressInfo } from 'node:net';

const ok = (): ProbeOutcome => ({ ok: true, detail: '200' });
const dead = (detail: string): ProbeOutcome => ({ ok: false, detail });

describe('createApiLivenessWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const runFor = async (cycles: number): Promise<void> => {
    await vi.advanceTimersByTimeAsync(API_LIVENESS.PROBE_CADENCE * cycles);
  };

  it('never trips while the probe answers 200', async () => {
    const onTrip = vi.fn();
    const watchdog = createApiLivenessWatchdog({
      endpoint: 'http://localhost:1/health',
      probe: () => Promise.resolve(ok()),
      onTrip,
    });

    watchdog.start();
    await runFor(API_LIVENESS.TRIP_FAILURES * 5);
    watchdog.stop();

    expect(onTrip).not.toHaveBeenCalled();
  });

  it('trips after exactly the configured consecutive failures', async () => {
    const onTrip = vi.fn();
    const watchdog = createApiLivenessWatchdog({
      endpoint: 'http://localhost:1/health',
      probe: () => Promise.resolve(dead('timeout')),
      onTrip,
    });

    watchdog.start();
    await runFor(API_LIVENESS.TRIP_FAILURES - 1);
    expect(onTrip).not.toHaveBeenCalled();

    await runFor(1);
    expect(onTrip).toHaveBeenCalledTimes(1);

    await runFor(10);
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it('resets the failure count on any 200', async () => {
    const outcomes = [dead('timeout'), dead('HTTP 503'), ok(), dead('timeout'), dead('timeout')];
    const onTrip = vi.fn();
    const watchdog = createApiLivenessWatchdog({
      endpoint: 'http://localhost:1/health',
      probe: () => Promise.resolve(outcomes.shift() ?? ok()),
      onTrip,
    });

    watchdog.start();
    await runFor(outcomes.length);
    watchdog.stop();

    expect(onTrip).not.toHaveBeenCalled();
  });

  it('counts a probe that hangs until its own budget as a failure rather than blocking', async () => {
    // A failing sample need not fail fast: a request the proxy holds for retry
    // and a worker that stalled both go unanswered, so the probe resolves only
    // once its own abort budget elapses. A sample that consumes the whole
    // budget must be followed by the next one rather than stalling the
    // watchdog behind it.
    const probe = vi.fn(
      () =>
        new Promise<ProbeOutcome>((resolve) => {
          setTimeout(() => {
            resolve(dead('timeout'));
          }, API_LIVENESS.PROBE_TIMEOUT);
        })
    );
    const onTrip = vi.fn();
    const watchdog = createApiLivenessWatchdog({
      endpoint: 'http://localhost:1/health',
      probe,
      onTrip,
    });

    watchdog.start();
    // One cadence to the first sample, then every sample consuming its whole
    // budget before the next starts, plus one budget of slack.
    await vi.advanceTimersByTimeAsync(
      API_LIVENESS.PROBE_CADENCE + (API_LIVENESS.TRIP_FAILURES + 1) * API_LIVENESS.PROBE_TIMEOUT
    );

    expect(probe).toHaveBeenCalledTimes(API_LIVENESS.TRIP_FAILURES);
    expect(onTrip).toHaveBeenCalledTimes(1);
  });

  it('names the endpoint, the failure count and the elapsed span in the reason', async () => {
    const onTrip = vi.fn();
    const watchdog = createApiLivenessWatchdog({
      endpoint: 'http://localhost:59993/health',
      probe: () => Promise.resolve(dead('HTTP 503 Your worker restarted mid-request')),
      onTrip,
    });

    watchdog.start();
    await runFor(API_LIVENESS.TRIP_FAILURES);

    const reason = onTrip.mock.calls[0]?.[0] as string;
    expect(reason).toContain('GET http://localhost:59993/health');
    expect(reason).toContain(String(API_LIVENESS.TRIP_FAILURES));
    expect(reason).toContain('Your worker restarted mid-request');
    expect(reason).toMatch(/\d+s/);
  });

  it('reports the age of the last 200 when one was seen', async () => {
    const outcomes = [ok(), dead('timeout'), dead('timeout'), dead('timeout')];
    const onTrip = vi.fn();
    const watchdog = createApiLivenessWatchdog({
      endpoint: 'http://localhost:1/health',
      probe: () => Promise.resolve(outcomes.shift() ?? dead('timeout')),
      onTrip,
    });

    watchdog.start();
    await runFor(outcomes.length);

    expect(onTrip.mock.calls[0]?.[0]).toContain('last 200 was');
  });

  it('says so when no probe ever answered 200', async () => {
    const onTrip = vi.fn();
    const watchdog = createApiLivenessWatchdog({
      endpoint: 'http://localhost:1/health',
      probe: () => Promise.resolve(dead('timeout')),
      onTrip,
    });

    watchdog.start();
    await runFor(API_LIVENESS.TRIP_FAILURES);

    expect(onTrip.mock.calls[0]?.[0]).toContain('never answered');
  });

  it('treats a probe that throws as a failed sample', async () => {
    const onTrip = vi.fn();
    const watchdog = createApiLivenessWatchdog({
      endpoint: 'http://localhost:1/health',
      probe: () => Promise.reject(new Error('socket hang up')),
      onTrip,
    });

    watchdog.start();
    await runFor(API_LIVENESS.TRIP_FAILURES);

    expect(onTrip.mock.calls[0]?.[0]).toContain('socket hang up');
  });

  it('discards the outcome of a sample that was still in flight when stopped', async () => {
    const onTrip = vi.fn();
    const watchdog = createApiLivenessWatchdog({
      endpoint: 'http://localhost:1/health',
      probe: () =>
        new Promise<ProbeOutcome>((resolve) => {
          setTimeout(() => {
            resolve(dead('timeout'));
          }, API_LIVENESS.PROBE_TIMEOUT);
        }),
      onTrip,
    });

    watchdog.start();
    await vi.advanceTimersByTimeAsync(API_LIVENESS.PROBE_CADENCE);
    watchdog.stop();
    await vi.advanceTimersByTimeAsync(API_LIVENESS.PROBE_TIMEOUT * 2);

    expect(onTrip).not.toHaveBeenCalled();
  });

  it('issues no further probe after stop', async () => {
    const probe = vi.fn(() => Promise.resolve(ok()));
    const watchdog = createApiLivenessWatchdog({
      endpoint: 'http://localhost:1/health',
      probe,
      onTrip: vi.fn(),
    });

    watchdog.start();
    await runFor(2);
    const taken = probe.mock.calls.length;
    expect(taken).toBeGreaterThan(0);

    watchdog.stop();
    await runFor(10);

    expect(probe.mock.calls.length).toBe(taken);
  });
});

describe('createHealthProbe', () => {
  let server: Server | undefined;
  let url: string;

  const listen = async (handler: Parameters<typeof createServer>[1]): Promise<number> => {
    const created = createServer(handler);
    await new Promise<void>((resolve) => {
      created.listen(0, '127.0.0.1', resolve);
    });
    server = created;
    const { port } = created.address() as AddressInfo;
    url = `http://127.0.0.1:${String(port)}/health`;
    return port;
  };

  afterEach(async () => {
    const running = server;
    server = undefined;
    if (running === undefined) return;
    await new Promise<void>((resolve) => {
      running.closeAllConnections();
      running.close(() => {
        resolve();
      });
    });
  });

  it('reports a 200 as a healthy sample', async () => {
    await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"status":"ok"}');
    });

    expect(await createHealthProbe(url)()).toEqual({ ok: true, detail: '200' });
  });

  it('reports a non-200 as a failed sample quoting the body', async () => {
    await listen((_request, response) => {
      response.writeHead(503);
      response.end('Your worker restarted mid-request.');
    });

    const outcome = await createHealthProbe(url)();

    expect(outcome.ok).toBe(false);
    expect(outcome.detail).toBe('HTTP 503 Your worker restarted mid-request.');
  });

  it('reports a non-200 with an empty body by status alone', async () => {
    await listen((_request, response) => {
      response.writeHead(502);
      response.end('');
    });

    expect(await createHealthProbe(url)()).toEqual({ ok: false, detail: 'HTTP 502' });
  });

  it('abandons a request the server never answers and calls it a timeout', async () => {
    await listen(() => {
      // Never responds, the way a GET the dev proxy holds for retry, or one a
      // stalled worker took, leaves the probe with no answer rather than an
      // error.
    });

    const outcome = await createHealthProbe(url, 50)();

    expect(outcome).toEqual({ ok: false, detail: 'timeout' });
  });

  it('reports a refused connection as a failed sample', async () => {
    const port = await listen((_request, response) => {
      response.end('ok');
    });
    const running = server;
    server = undefined;
    await new Promise<void>((resolve) => {
      running?.close(() => {
        resolve();
      });
    });

    const outcome = await createHealthProbe(`http://127.0.0.1:${String(port)}/health`, 2000)();

    expect(outcome.ok).toBe(false);
    expect(outcome.detail.length).toBeGreaterThan(0);
    expect(outcome.detail).not.toBe('timeout');
  });
});
