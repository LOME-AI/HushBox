import { CloudflareClient, createTransport } from '@sentry/cloudflare';
import { scrubSentryEvent } from './sentry-scrub.js';
import type { ScheduleCheckIn } from '../check-in.js';
import type { Telemetry } from '../port.js';

export type SentryClientOptions = ConstructorParameters<typeof CloudflareClient>[0];
export type SentryTransportFactory = SentryClientOptions['transport'];

/** Logs and metrics are the console adapter's channel; see `createSentryTelemetry`. */
function noop(): void {
  // Deliberately inert.
}

interface SentryTelemetryOptions {
  /** Sentry DSN. Absent in dev/test by design — see `createSentryTelemetry`. */
  dsn?: string | undefined;
  /** Transport override for tests; production uses the fetch transport. */
  transport?: SentryTransportFactory | undefined;
  /**
   * Receives the client-flush task after each capture; the request pipeline
   * passes `ctx.waitUntil` so the envelope survives the response being
   * returned (Workers freeze the isolate once the response settles).
   * Scheduling per capture — not at a response seam — keeps correctness
   * independent of Hono's compose ordering internals (where `app.onError`
   * runs relative to middleware post-`next()` code is an implementation
   * detail we refuse to couple to), and it covers captures that have no
   * surrounding response seam at all.
   */
  scheduleFlush?: ((task: Promise<unknown>) => void) | undefined;
  /**
   * The crontab the monitor is upserted with, supplied by the cron composition
   * root: the schedule map is composition, which this lib tree may not import.
   */
  monitorCrontab?: string | undefined;
}

/** Sentry's own Workers wrapper flushes with this bound (`withSentry` calls
 * `waitUntil(flush(2000))`); kept identical so behavior matches the SDK's
 * documented posture. */
const FLUSH_TIMEOUT_MS = 2000;

/** The four schedules share one trigger mechanism, so the monitor on the most frequent one reports the whole cron isolate's absence. */
const MONITOR_SLUG = 'jobs-health';

/** Minutes late a check-in may arrive before the monitor calls it missed, and minutes an
 * `in_progress` check-in may run before the monitor calls it timed out. Both are shorter
 * than the schedule's period, so a late or hung pass is reported before the next one starts. */
const CHECK_IN_MARGIN_MINUTES = 5;
const MAX_RUNTIME_MINUTES = 10;

/** Binary envelopes are copied over a fresh ArrayBuffer, satisfying BodyInit
 * (the SDK hands over Uint8Array<ArrayBufferLike>, which the fetch typings
 * reject). */
export function encodeTransportBody(body: string | Uint8Array): string | ArrayBuffer {
  return typeof body === 'string' ? body : new Uint8Array(body).buffer;
}

/**
 * Minimal fetch transport: Workers' global fetch posting serialized
 * envelopes to the DSN ingest URL (auth travels in the URL). `createTransport`
 * supplies buffering and rate-limit handling around the executor.
 */
const makeWorkerFetchTransport: SentryTransportFactory = (transportOptions) =>
  createTransport(transportOptions, async (request) => {
    const response = await fetch(transportOptions.url, {
      method: 'POST',
      body: encodeTransportBody(request.body),
    });
    return {
      statusCode: response.status,
      headers: {
        'x-sentry-rate-limits': response.headers.get('X-Sentry-Rate-Limits'),
        'retry-after': response.headers.get('Retry-After'),
      },
    };
  });

/**
 * The locked-down client configuration. Exported so tests assert the
 * lock-down directly:
 * - `sendDefaultPii: false` plus a fully-off `dataCollection` — no user info,
 *   cookies, headers, bodies, query params, AI inputs/outputs, frame locals,
 *   or source context. `dataCollection` is the operative option (when both
 *   are set the SDK ignores `sendDefaultPii`); the deprecated flag stays as
 *   defense for any code path still reading it;
 * - `integrations: []` — constructing the client directly (never `init()`)
 *   means the SDK's default integrations (RequestData, console/fetch
 *   breadcrumbs, linked errors) never register;
 * - `maxBreadcrumbs: 0` — breadcrumbs are a second content channel with no
 *   operator value here; log lines ride the console adapter and this transport
 *   carries defects only;
 * - `beforeSend` — the allowlist scrub (sentry-scrub.ts) rebuilds every event
 *   and is the only path to the wire;
 * - `stackParser: () => []` — the client's own parse of the raw stack (which
 *   includes the message header) is discarded; the scrub re-derives frames
 *   from the original error with the message-stripping discipline.
 *
 * Sentry-side Advanced Data Scrubbing is additionally configured on the
 * project (server-side defense in depth); this module must stay safe without
 * it.
 */
export function sentryClientOptions(
  dsn: string,
  transport: SentryTransportFactory
): SentryClientOptions {
  return {
    dsn,
    transport,
    stackParser: () => [],
    integrations: [],
    // Deprecated in favor of `dataCollection` (below, the operative
    // lock-down); kept verbatim per the telemetry doctrine as defense for any
    // SDK path still reading it, until its v11 removal.
    sendDefaultPii: false,
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      queryParams: false,
      genAI: { inputs: false, outputs: false },
      stackFrameVariables: false,
      frameContextLines: 0,
    },
    maxBreadcrumbs: 0,
    beforeSend: scrubSentryEvent,
  };
}

/**
 * Sentry adapter for the Telemetry port: the unexpected-error channel
 * (`captureError` only — Sentry receives defects, never logs). The log methods
 * are deliberately inert; they ride the console adapter
 * (`apps/api/src/lib/telemetry/console-adapter.ts`), whose lines nothing reads.
 * This adapter composes on the Worker's own entry paths, where
 * `[observability] enabled = false` (`apps/api/wrangler.toml`) also means no
 * console line is ingested, so there this transport is the only telemetry that
 * reaches anyone.
 *
 * Without a DSN the adapter is constructed inert rather than failing fast:
 * telemetry is best-effort by doctrine (it may degrade; it never blocks a
 * request), and a DSN-less mode is the legal dev/test configuration, not a
 * missing-config defect. The same containment applies when client
 * construction itself fails.
 */
export function createSentryTelemetry(
  options: SentryTelemetryOptions = {}
): Telemetry & ScheduleCheckIn {
  let client: CloudflareClient | undefined;
  try {
    client =
      options.dsn === undefined
        ? undefined
        : new CloudflareClient(
            sentryClientOptions(options.dsn, options.transport ?? makeWorkerFetchTransport)
          );
    // eslint-disable-next-line catch-swallow/no-silent-catch -- best-effort port: an unconstructable Sentry client degrades error reporting, not the request.
  } catch {
    // Best-effort port: a client that cannot be constructed degrades error
    // reporting, never the request path.
    client = undefined;
  }

  let openCheckInId: string | undefined;

  return {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    captureError(error: Error, errorCode: string): void {
      try {
        // The scope-level SDK API normally sets `originalException`; calling
        // the client directly, we set it ourselves — the scrub rebuilds the
        // exception chain from it.
        if (client === undefined) {
          return;
        }
        client.captureException(error, {
          originalException: error,
          captureContext: {
            tags: { errorCode },
            fingerprint: ['{{ default }}', errorCode],
          },
        });
        // `flush` waits for the just-queued envelope (capture increments the
        // client's processing counter synchronously), so a flush started here
        // covers this event.
        options.scheduleFlush?.(client.flush(FLUSH_TIMEOUT_MS));
        // eslint-disable-next-line catch-swallow/no-silent-catch -- best-effort port: nowhere safer to report a telemetry failure.
      } catch {
        // Best-effort port: one attempt, no fallback channel — there is
        // nowhere safer to report a telemetry failure than not at all.
      }
    },
    checkIn(status: 'in_progress' | 'ok'): void {
      try {
        if (client === undefined) {
          return;
        }
        if (status === 'in_progress') {
          openCheckInId = client.captureCheckIn(
            { monitorSlug: MONITOR_SLUG, status },
            options.monitorCrontab === undefined
              ? undefined
              : {
                  schedule: { type: 'crontab', value: options.monitorCrontab },
                  checkinMargin: CHECK_IN_MARGIN_MINUTES,
                  maxRuntime: MAX_RUNTIME_MINUTES,
                  timezone: 'UTC',
                }
          );
        } else {
          if (openCheckInId === undefined) {
            return;
          }
          client.captureCheckIn({ monitorSlug: MONITOR_SLUG, status, checkInId: openCheckInId });
        }
        options.scheduleFlush?.(client.flush(FLUSH_TIMEOUT_MS));
        // eslint-disable-next-line catch-swallow/no-silent-catch -- best-effort port: nowhere safer to report a telemetry failure.
      } catch {
        // Best-effort port: one attempt, no fallback channel — there is
        // nowhere safer to report a telemetry failure than not at all.
      }
    },
  };
}
