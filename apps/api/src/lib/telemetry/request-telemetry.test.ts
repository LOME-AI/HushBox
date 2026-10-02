import { describe, expect, it, vi } from 'vitest';
import { createDurableObjectTelemetry, createRequestTelemetry } from './request-telemetry.js';
import { FINGERPRINT_CODES } from './fingerprint-codes.js';
import { CRON_SCHEDULES } from '../../composition/cron-schedules.js';
import type { Bindings } from '../context/index.js';
import type { ConsoleSink } from './console-adapter.js';
import type { SentryTransportFactory } from './adapters/sentry-adapter.js';
import type { TelemetryEnv } from './request-telemetry.js';

const DSN = 'https://abc123@o1.ingest.sentry.io/42';

function createRecordingConsole(): {
  sink: ConsoleSink;
  lines: { method: string; line: string }[];
} {
  const lines: { method: string; line: string }[] = [];
  const record =
    (method: string) =>
    (line: string): void => {
      lines.push({ method, line });
    };
  return {
    sink: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
    lines,
  };
}

function createSpyTransport(): { factory: SentryTransportFactory; envelopes: unknown[] } {
  const envelopes: unknown[] = [];
  return {
    factory: () => ({
      send: (envelope) => {
        envelopes.push(envelope);
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
    envelopes,
  };
}

describe('createRequestTelemetry sink-list validation (fail fast)', () => {
  it('throws naming TELEMETRY_SINKS when the variable is missing', () => {
    expect(() => createRequestTelemetry({})).toThrow(/TELEMETRY_SINKS/);
  });

  it('throws when TELEMETRY_SINKS is empty', () => {
    expect(() => createRequestTelemetry({ TELEMETRY_SINKS: '' })).toThrow(/TELEMETRY_SINKS/);
  });

  it('throws naming an unknown sink token', () => {
    expect(() => createRequestTelemetry({ TELEMETRY_SINKS: 'console,statsd' })).toThrow(/statsd/);
  });

  it('throws on a duplicated sink token', () => {
    expect(() => createRequestTelemetry({ TELEMETRY_SINKS: 'console,console' })).toThrow(/console/);
  });

  it('throws naming SENTRY_DSN when the sentry sink is requested without a DSN', () => {
    expect(() => createRequestTelemetry({ TELEMETRY_SINKS: 'console,sentry' })).toThrow(
      /SENTRY_DSN/
    );
  });

  it('throws naming SENTRY_DSN when the DSN is the explicit empty (disabled) value', () => {
    expect(() =>
      createRequestTelemetry({ TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN: '' })
    ).toThrow(/SENTRY_DSN/);
  });
});

describe('createRequestTelemetry console-only composition (dev/test registry value)', () => {
  it('delivers logs to the console sink', () => {
    const recording = createRecordingConsole();
    const telemetry = createRequestTelemetry(
      { TELEMETRY_SINKS: 'console' },
      { consoleSink: recording.sink }
    );

    telemetry.info('pipeline probe', { requestId: 'r-1' });

    expect(recording.lines).toHaveLength(1);
    expect(JSON.parse(recording.lines[0]?.line ?? '')).toEqual({
      level: 'info',
      msg: 'pipeline probe',
      requestId: 'r-1',
    });
  });

  it('never reads the Sentry configuration', () => {
    // No DSN: a console-only list must not even look at it.
    expect(() => createRequestTelemetry({ TELEMETRY_SINKS: 'console' })).not.toThrow();
  });
});

describe('createRequestTelemetry full composition (production registry value)', () => {
  function fullEnv(): TelemetryEnv {
    return { TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN: DSN };
  }

  it('fans a captured error out to console and Sentry', async () => {
    const recording = createRecordingConsole();
    const transport = createSpyTransport();
    const tasks: Promise<unknown>[] = [];
    const telemetry = createRequestTelemetry(fullEnv(), {
      consoleSink: recording.sink,
      sentryTransport: transport.factory,
      scheduleFlush: (task) => tasks.push(task),
    });

    telemetry.captureError(new Error('boom'), FINGERPRINT_CODES.mediaGcDeleteFailed);

    expect(recording.lines.map((entry) => entry.method)).toEqual(['error']);
    await Promise.all(tasks);
    expect(transport.envelopes).toHaveLength(1);
  });

  it('schedules the Sentry flush through the provided scheduler', () => {
    const transport = createSpyTransport();
    const tasks: Promise<unknown>[] = [];
    const telemetry = createRequestTelemetry(fullEnv(), {
      consoleSink: createRecordingConsole().sink,
      sentryTransport: transport.factory,
      scheduleFlush: (task) => tasks.push(task),
    });

    telemetry.captureError(new Error('boom'), FINGERPRINT_CODES.workflowNodeDefect);

    expect(tasks).toHaveLength(1);
  });

  it('keeps delivering to the remaining sinks when one sink fails', async () => {
    const explode = (): never => {
      throw new Error('console sink down');
    };
    const transport = createSpyTransport();
    const tasks: Promise<unknown>[] = [];
    const telemetry = createRequestTelemetry(fullEnv(), {
      consoleSink: { debug: explode, info: explode, warn: explode, error: explode },
      sentryTransport: transport.factory,
      scheduleFlush: (task) => tasks.push(task),
    });

    expect(() => {
      telemetry.captureError(new Error('boom'), FINGERPRINT_CODES.workflowNodeDefect);
    }).not.toThrow();
    await Promise.all(tasks);
    expect(transport.envelopes).toHaveLength(1);
  });
});

describe('createRequestTelemetry env surface', () => {
  it('accepts the canonical Worker Bindings type directly', () => {
    const recording = createRecordingConsole();
    const env: Bindings = { TELEMETRY_SINKS: 'console', SENTRY_DSN: DSN };
    const telemetry = createRequestTelemetry(env, { consoleSink: recording.sink });

    telemetry.info('pipeline probe');

    expect(recording.lines).toHaveLength(1);
  });
});

/**
 * The misconfigurations the two postures disagree about: the Worker path
 * throws on every one of them, the Durable Object path degrades.
 */
const MISCONFIGURED: { readonly label: string; readonly env: TelemetryEnv }[] = [
  { label: 'no sink list at all', env: {} },
  { label: 'an empty sink list', env: { TELEMETRY_SINKS: '' } },
  { label: 'an unknown sink token', env: { TELEMETRY_SINKS: 'console,statsd' } },
  { label: 'a duplicated sink token', env: { TELEMETRY_SINKS: 'console,console' } },
  { label: 'the sentry sink without a DSN', env: { TELEMETRY_SINKS: 'console,sentry' } },
  {
    label: 'the sentry sink with an empty DSN',
    env: { TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN: '' },
  },
];

describe('createDurableObjectTelemetry misconfiguration posture', () => {
  it.each(MISCONFIGURED)('returns a working console telemetry given $label', ({ env }) => {
    const recording = createRecordingConsole();

    const telemetry = createDurableObjectTelemetry(env, { consoleSink: recording.sink });
    telemetry.captureError(new Error('boom'), FINGERPRINT_CODES.jobPassFailed);

    expect(recording.lines.map((entry) => entry.method)).toContain('error');
    expect(recording.lines.map((entry) => entry.line).join('\n')).toContain(
      FINGERPRINT_CODES.jobPassFailed
    );
  });

  it.each(MISCONFIGURED)('leaves the request composition failing fast given $label', ({ env }) => {
    expect(() => createRequestTelemetry(env)).toThrow(/TELEMETRY_SINKS|SENTRY_DSN/);
  });

  it('says on the console sink that it degraded', () => {
    const recording = createRecordingConsole();

    createDurableObjectTelemetry(
      { TELEMETRY_SINKS: 'console,statsd' },
      { consoleSink: recording.sink }
    );

    expect(JSON.parse(recording.lines[0]?.line ?? '')).toEqual({
      level: 'error',
      msg: 'telemetry sink composition failed, degrading to console',
    });
  });
});

describe('createDurableObjectTelemetry well-formed composition', () => {
  it('reaches the Sentry transport with no flush scheduler', async () => {
    const transport = createSpyTransport();

    const telemetry = createDurableObjectTelemetry(
      { TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN: DSN },
      { consoleSink: createRecordingConsole().sink, sentryTransport: transport.factory }
    );
    telemetry.captureError(new Error('boom'), FINGERPRINT_CODES.jobPassFailed);

    await vi.waitFor(() => {
      expect(transport.envelopes).toHaveLength(1);
    });
  });

  it('reports nothing degraded when the sink list composes', () => {
    const recording = createRecordingConsole();

    createDurableObjectTelemetry(
      { TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN: DSN },
      { consoleSink: recording.sink, sentryTransport: createSpyTransport().factory }
    );

    expect(recording.lines).toHaveLength(0);
  });
});

describe('createRequestTelemetry cron monitor check-in', () => {
  it('checks in on every composed sink', async () => {
    const recording = createRecordingConsole();
    const transport = createSpyTransport();
    const telemetry = createRequestTelemetry(
      { TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN: DSN },
      {
        consoleSink: recording.sink,
        sentryTransport: transport.factory,
        monitorCrontab: CRON_SCHEDULES['jobs-health'],
      }
    );

    telemetry.checkIn('in_progress');

    expect(recording.lines.map((entry) => entry.method)).toEqual(['info']);
    await vi.waitFor(() => {
      expect(transport.envelopes).toHaveLength(1);
    });
    const envelope = JSON.stringify(transport.envelopes);
    expect(envelope).toContain('jobs-health');
    expect(envelope).toContain(CRON_SCHEDULES['jobs-health']);
  });

  it('keeps checking in on the remaining sinks when one sink throws', async () => {
    const explode = (): never => {
      throw new Error('console sink down');
    };
    const transport = createSpyTransport();
    const telemetry = createRequestTelemetry(
      { TELEMETRY_SINKS: 'console,sentry', SENTRY_DSN: DSN },
      {
        consoleSink: { debug: explode, info: explode, warn: explode, error: explode },
        sentryTransport: transport.factory,
        monitorCrontab: CRON_SCHEDULES['jobs-health'],
      }
    );

    expect(() => {
      telemetry.checkIn('in_progress');
    }).not.toThrow();
    await vi.waitFor(() => {
      expect(transport.envelopes).toHaveLength(1);
    });
  });

  it('checks in through the degraded console composition too', () => {
    const recording = createRecordingConsole();

    const telemetry = createDurableObjectTelemetry(
      { TELEMETRY_SINKS: 'console,statsd' },
      { consoleSink: recording.sink }
    );
    telemetry.checkIn('ok');

    expect(recording.lines.map((entry) => entry.method)).toEqual(['error', 'info']);
  });
});
