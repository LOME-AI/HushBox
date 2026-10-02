import { createSentryTelemetry } from './adapters/sentry-adapter.js';
import { createConsoleTelemetry } from './console-adapter.js';
import { createTelemetryFanOut } from './fan-out.js';
import type { Bindings } from '../context/index.js';
import type { SentryTransportFactory } from './adapters/sentry-adapter.js';
import type { ScheduleCheckIn } from './check-in.js';
import type { ConsoleSink } from './console-adapter.js';
import type { Telemetry } from './port.js';

const SINK_NAMES = ['console', 'sentry'] as const;
type SinkName = (typeof SINK_NAMES)[number];

/**
 * The slice of the canonical Worker `Bindings` the telemetry composition
 * reads — derived, never redeclared (`lib/context/app-env.ts` owns the
 * declarations). Which sinks compose is a per-mode env-registry value, never
 * a code branch on the runtime mode — dev/test modes declare `console`,
 * production declares every bound sink.
 */
export type TelemetryEnv = Pick<Bindings, 'TELEMETRY_SINKS' | 'SENTRY_DSN'>;

export interface RequestTelemetryOptions {
  /** Forwarded to the Sentry adapter; the pipeline passes `ctx.waitUntil`. */
  scheduleFlush?: ((task: Promise<unknown>) => void) | undefined;
  /** Console sink override for tests; production uses the global console. */
  consoleSink?: ConsoleSink | undefined;
  /** Transport override for tests; production uses the fetch transport. */
  sentryTransport?: SentryTransportFactory | undefined;
  /** Forwarded to the Sentry adapter; the cron composition root passes the schedule's crontab. */
  monitorCrontab?: string | undefined;
}

/**
 * The Durable Object composition's overrides. No `scheduleFlush`: a Durable
 * Object stays active while it has pending I/O and the transport's fetch is
 * initiated at capture time, so the envelope is delivered without a scheduler
 * — `DurableObjectState.waitUntil` is a documented no-op for that reason.
 */
export type DurableObjectTelemetryOptions = Pick<
  RequestTelemetryOptions,
  'consoleSink' | 'sentryTransport'
>;

function isSinkName(token: string): token is SinkName {
  return (SINK_NAMES as readonly string[]).includes(token);
}

function parseSinkList(raw: string | undefined): SinkName[] {
  if (raw === undefined || raw === '') {
    throw new Error(
      'TELEMETRY_SINKS is missing: every mode declares its sink list in the env registry — ' +
        'there is no default. Set it in wrangler config / .dev.vars.'
    );
  }
  const parsed: SinkName[] = [];
  for (const token of raw.split(',').map((entry) => entry.trim())) {
    if (!isSinkName(token)) {
      throw new Error(
        `TELEMETRY_SINKS contains an unknown sink '${token}' (known: ${SINK_NAMES.join(', ')}).`
      );
    }
    if (parsed.includes(token)) {
      throw new Error(`TELEMETRY_SINKS lists '${token}' more than once.`);
    }
    parsed.push(token);
  }
  return parsed;
}

function createSentrySink(
  env: TelemetryEnv,
  options: RequestTelemetryOptions
): Telemetry & ScheduleCheckIn {
  if (env.SENTRY_DSN === undefined || env.SENTRY_DSN === '') {
    throw new Error(
      'TELEMETRY_SINKS requests the sentry sink but SENTRY_DSN is missing or empty. ' +
        'Set the SENTRY_DSN secret, or remove the sink from the mode in the env registry.'
    );
  }
  return createSentryTelemetry({
    dsn: env.SENTRY_DSN,
    transport: options.sentryTransport,
    scheduleFlush: options.scheduleFlush,
    monitorCrontab: options.monitorCrontab,
  });
}

/**
 * The check-in's fan-out, guarded per sink exactly as the log fan-out is: the
 * port's error channel is `never`, so one sink's failure must not silence the
 * rest or fail the pass being observed.
 */
function checkInAcrossSinks(sinks: readonly ScheduleCheckIn[]): ScheduleCheckIn['checkIn'] {
  return (status) => {
    for (const sink of sinks) {
      try {
        sink.checkIn(status);
        // eslint-disable-next-line catch-swallow/no-silent-catch -- best-effort port: isolate each sink; a violating sink must not fail the pass.
      } catch {
        // Best-effort port: one attempt per sink, no fallback channel — there
        // is nowhere safer to report a telemetry failure than not at all.
      }
    }
  };
}

/**
 * Builds the per-request Telemetry implementation from the TELEMETRY_SINKS
 * registry value: a fan-out over the listed adapters in list order. Sink
 * misconfiguration fails fast (missing list, unknown token, sentry without a
 * DSN).
 */
export function createRequestTelemetry(
  env: TelemetryEnv,
  options: RequestTelemetryOptions = {}
): Telemetry & ScheduleCheckIn {
  const sinks: (Telemetry & ScheduleCheckIn)[] = [];
  for (const name of parseSinkList(env.TELEMETRY_SINKS)) {
    if (name === 'console') {
      sinks.push(createConsoleTelemetry(options.consoleSink));
    } else {
      sinks.push(createSentrySink(env, options));
    }
  }
  return { ...createTelemetryFanOut(sinks), checkIn: checkInAcrossSinks(sinks) };
}

/**
 * The same composition with the opposite posture: a sink misconfiguration
 * yields console-only telemetry instead of throwing.
 *
 * The Worker path keeps its fail-fast because a bad sink list there costs one
 * 500 and is loud within seconds of a deploy. Both Durable Object isolates
 * compose their bindings where a throw is unrecoverable: the ConversationRoom
 * builds them in the DO constructor, so a throw bricks the settlement path,
 * and the JobDispatcher memoises its core build, so a construction throw caches
 * a rejected promise for the life of the isolate. Telemetry may degrade; money
 * and persistence never do (`docs/DECISIONS.md` §Deliberate limits), so a
 * misconfigured sink must not outrank either.
 *
 * Delivery from a Durable Object is at-most-once — a capture in flight when the
 * isolate dies is lost — which is the posture the Worker path already has.
 */
export function createDurableObjectTelemetry(
  env: TelemetryEnv,
  options: DurableObjectTelemetryOptions = {}
): Telemetry & ScheduleCheckIn {
  try {
    return createRequestTelemetry(env, options);
    // eslint-disable-next-line catch-swallow/no-silent-catch -- not swallowed: the failure is reported on the console sink below. Rethrowing is the single thing this seam exists to prevent (see the docblock).
  } catch {
    const fallback = createConsoleTelemetry(options.consoleSink);
    fallback.error('telemetry sink composition failed, degrading to console');
    return fallback;
  }
}
