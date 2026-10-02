import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HOUR_MS, MINUTE_MS, TEST_DAY_START, freezeClock } from '@hushbox/shared/test-time';
import {
  CRON_SCHEDULES,
  SCHEDULED_TRIGGER_PATH,
  cronMatches,
  fireCron,
  resolveScheduleName,
  runFireCron,
  scheduledTriggerUrl,
  startDevCronTicker,
  shouldStartCronTicker,
  startCronTicker,
} from './cron-trigger.js';
import { rootScripts } from './lib/root-manifest.js';

function okFetch(): typeof globalThis.fetch {
  return vi.fn(() =>
    Promise.resolve(new Response('ok', { status: 200 }))
  ) as unknown as typeof globalThis.fetch;
}

describe('the cron:fire root script', () => {
  it('runs this module through the env loader, so the dev port is in scope', () => {
    const body = rootScripts()['cron:fire'];

    expect(body).toContain('scripts/with-env.ts');
    expect(body).toContain('scripts/cron-trigger.ts');
  });
});

describe('scheduledTriggerUrl', () => {
  it('url-encodes the cron expression onto the scheduled endpoint', () => {
    expect(scheduledTriggerUrl('http://localhost:8788', '*/15 * * * *')).toBe(
      `http://localhost:8788${SCHEDULED_TRIGGER_PATH}?cron=*%2F15%20*%20*%20*%20*`
    );
  });

  it('does not double a trailing slash on the base url', () => {
    expect(scheduledTriggerUrl('http://localhost:8788/', '0 * * * *')).toBe(
      `http://localhost:8788${SCHEDULED_TRIGGER_PATH}?cron=0%20*%20*%20*%20*`
    );
  });
});

describe('cronMatches', () => {
  it('matches a step minute expression only on its step boundaries', () => {
    expect(cronMatches('*/15 * * * *', new Date(TEST_DAY_START + 15 * MINUTE_MS))).toBe(true);
    expect(cronMatches('*/15 * * * *', new Date(TEST_DAY_START + 14 * MINUTE_MS))).toBe(false);
  });

  it('matches a literal hour expression only on that hour', () => {
    expect(cronMatches('0 3 * * *', new Date(TEST_DAY_START + 3 * HOUR_MS))).toBe(true);
    expect(cronMatches('0 3 * * *', new Date(TEST_DAY_START + 4 * HOUR_MS))).toBe(false);
  });

  it('matches a step hour expression only on its step boundaries', () => {
    expect(cronMatches('0 */6 * * *', new Date(TEST_DAY_START + 6 * HOUR_MS))).toBe(true);
    expect(cronMatches('0 */6 * * *', new Date(TEST_DAY_START + 7 * HOUR_MS))).toBe(false);
  });

  it('reads the instant in UTC, never the host zone', () => {
    expect(cronMatches('0 0 * * *', new Date(TEST_DAY_START))).toBe(true);
  });

  it('rejects an expression that does not carry five fields', () => {
    expect(() => cronMatches('0 3 * *', new Date(TEST_DAY_START))).toThrow(/five fields/);
  });

  it('rejects a step of zero, which would divide by nothing', () => {
    expect(() => cronMatches('*/0 * * * *', new Date(TEST_DAY_START))).toThrow(/positive whole/);
  });

  it('rejects a field form it cannot evaluate', () => {
    expect(() => cronMatches('0 1-5 * * *', new Date(TEST_DAY_START))).toThrow(/1-5/);
  });
});

describe('fireCron', () => {
  it('reports the status and body the scheduled endpoint answered with', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('exception', { status: 500 }))
    ) as unknown as typeof globalThis.fetch;

    await expect(fireCron('http://localhost:8788', '0 * * * *', fetchImpl)).resolves.toEqual({
      status: 500,
      body: 'exception',
    });
  });

  it('requests the scheduled endpoint for the expression it was given', async () => {
    const fetchImpl = okFetch();

    await fireCron('http://localhost:8788', '0 * * * *', fetchImpl);

    expect(fetchImpl).toHaveBeenCalledWith(
      scheduledTriggerUrl('http://localhost:8788', '0 * * * *')
    );
  });
});

describe('startCronTicker', () => {
  beforeEach(() => {
    freezeClock(TEST_DAY_START + 14 * MINUTE_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires a schedule when the clock reaches its expression, and not before', async () => {
    const fired: string[] = [];
    const ticker = startCronTicker({
      crons: ['*/15 * * * *'],
      fire: (cron) => {
        fired.push(cron);
        return Promise.resolve();
      },
      onFireFailed: () => {},
    });

    await vi.advanceTimersByTimeAsync(30 * 1000);
    expect(fired).toEqual([]);

    await vi.advanceTimersByTimeAsync(MINUTE_MS);
    expect(fired).toEqual(['*/15 * * * *']);

    ticker.stop();
  });

  it('fires every schedule whose expression the same minute satisfies', async () => {
    const fired: string[] = [];
    const ticker = startCronTicker({
      crons: ['0 * * * *', '0 3 * * *'],
      fire: (cron) => {
        fired.push(cron);
        return Promise.resolve();
      },
      onFireFailed: () => {},
    });

    await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
    expect(fired.filter((cron) => cron === '0 3 * * *')).toEqual(['0 3 * * *']);
    expect(fired.filter((cron) => cron === '0 * * * *')).toHaveLength(3);

    ticker.stop();
  });

  it('reports a failed fire and keeps ticking', async () => {
    const failures: string[] = [];
    let attempts = 0;
    const ticker = startCronTicker({
      crons: ['*/15 * * * *'],
      fire: () => {
        attempts += 1;
        return Promise.reject(new Error('connection refused'));
      },
      onFireFailed: (cron, error) => {
        failures.push(`${cron}: ${error instanceof Error ? error.message : String(error)}`);
      },
    });

    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(attempts).toBe(4);
    expect(failures).toHaveLength(4);
    expect(failures[0]).toBe('*/15 * * * *: connection refused');

    ticker.stop();
  });

  it('arms no further tick when it is stopped while firing', async () => {
    const fired: string[] = [];
    const ticker = startCronTicker({
      crons: ['*/15 * * * *'],
      fire: (cron) => {
        fired.push(cron);
        ticker.stop();
        return Promise.resolve();
      },
      onFireFailed: () => {},
    });

    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(fired).toEqual(['*/15 * * * *']);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops firing once stopped', async () => {
    const fired: string[] = [];
    const ticker = startCronTicker({
      crons: ['*/15 * * * *'],
      fire: (cron) => {
        fired.push(cron);
        return Promise.resolve();
      },
      onFireFailed: () => {},
    });

    ticker.stop();
    await vi.advanceTimersByTimeAsync(HOUR_MS);

    expect(fired).toEqual([]);
  });
});

describe('shouldStartCronTicker', () => {
  it('is false under the E2E env mode', () => {
    expect(shouldStartCronTicker({ NODE_ENV: 'development', E2E: 'true' })).toBe(false);
  });

  it('is true for a plain local dev server', () => {
    expect(shouldStartCronTicker({ NODE_ENV: 'development' })).toBe(true);
  });

  it('fails fast when the env names no mode at all', () => {
    expect(() => shouldStartCronTicker({})).toThrow(/NODE_ENV/);
  });
});

describe('startDevCronTicker', () => {
  beforeEach(() => {
    freezeClock(TEST_DAY_START + 14 * MINUTE_MS);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('arms nothing under the E2E env mode', () => {
    const ticker = startDevCronTicker({
      NODE_ENV: 'development',
      E2E: 'true',
      HB_API_PORT: '8788',
    });

    expect(ticker).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('arms one timer for a dev server and releases it on stop', () => {
    const ticker = startDevCronTicker({ NODE_ENV: 'development', HB_API_PORT: '8788' });

    expect(ticker).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);

    ticker?.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('announces the on-demand command when it arms', () => {
    const ticker = startDevCronTicker({ NODE_ENV: 'development', HB_API_PORT: '8788' });

    expect(vi.mocked(console.warn).mock.calls[0]?.[0]).toContain('pnpm cron:fire');

    ticker?.stop();
  });

  it('fires each due schedule against the dev server', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('ok', { status: 200 })));
    vi.stubGlobal('fetch', fetchImpl);
    const ticker = startDevCronTicker({ NODE_ENV: 'development', HB_API_PORT: '8788' });

    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

    expect(fetchImpl).toHaveBeenCalledWith(
      scheduledTriggerUrl('http://127.0.0.1:8788', CRON_SCHEDULES['jobs-health'])
    );

    ticker?.stop();
    vi.unstubAllGlobals();
  });

  it('reports a fire that never reached the dev server', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('connection refused')))
    );
    const ticker = startDevCronTicker({ NODE_ENV: 'development', HB_API_PORT: '8788' });

    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

    const reported = vi
      .mocked(console.warn)
      .mock.calls.map((call) => String(call[0]))
      .filter((line) => line.includes('failed'));
    expect(reported).toEqual(['cron: firing */15 * * * * failed — connection refused']);

    ticker?.stop();
    vi.unstubAllGlobals();
  });

  it('reports a schedule the handler answered an error status for, and keeps running', async () => {
    const fetchImpl = vi.fn(() => Promise.resolve(new Response('exception', { status: 500 })));
    vi.stubGlobal('fetch', fetchImpl);
    const ticker = startDevCronTicker({ NODE_ENV: 'development', HB_API_PORT: '8788' });

    await vi.advanceTimersByTimeAsync(2 * MINUTE_MS);

    const reported = vi
      .mocked(console.warn)
      .mock.calls.map((call) => String(call[0]))
      .filter((line) => line.includes('failed'));
    expect(reported).toHaveLength(1);
    expect(reported[0]).toContain('answered 500');
    expect(vi.getTimerCount()).toBe(1);

    ticker?.stop();
    vi.unstubAllGlobals();
  });
});

describe('resolveScheduleName', () => {
  it('maps a schedule name to its expression', () => {
    expect(resolveScheduleName('jobs-health')).toBe(CRON_SCHEDULES['jobs-health']);
  });

  it('rejects an unknown name and lists the ones that exist', () => {
    expect(() => resolveScheduleName('nightly')).toThrow(/jobs-health/);
  });
});

describe('runFireCron', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fires the named schedule against the dev api port and succeeds', async () => {
    const fetchImpl = okFetch();

    const exitCode = await runFireCron(['jobs-health'], { HB_API_PORT: '8788' }, fetchImpl);

    expect(exitCode).toBe(0);
    expect(fetchImpl).toHaveBeenCalledWith(
      scheduledTriggerUrl('http://127.0.0.1:8788', CRON_SCHEDULES['jobs-health'])
    );
  });

  it('exits non-zero when the handler answered with an error status', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(new Response('exception', { status: 500 }))
    ) as unknown as typeof globalThis.fetch;

    expect(await runFireCron(['hourly'], { HB_API_PORT: '8788' }, fetchImpl)).toBe(1);
  });

  it('rejects a missing schedule name with the usage line', async () => {
    await expect(runFireCron([], { HB_API_PORT: '8788' }, okFetch())).rejects.toThrow(/Usage/);
  });

  it('fails fast when the dev api port is not in the environment', async () => {
    await expect(runFireCron(['hourly'], {}, okFetch())).rejects.toThrow(/HB_API_PORT/);
  });
});
