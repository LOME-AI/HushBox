/**
 * API liveness watchdog for the E2E run.
 *
 * Playwright watches a `webServer` only until its readiness URL first answers;
 * nothing observes it again. A worker that stops answering mid-run therefore
 * costs the whole remaining budget in cascade failures, with two matrix
 * projects left unrun and no line in the report naming the cause.
 *
 * This closes that gap from the one place that already owns run-level
 * observation — the custom reporter — by sampling the API's static `/health`
 * route and, after a fixed run of failures, recording the reason as a run-level
 * error and interrupting the run.
 *
 * Each sample carries its own deadline. That is the load-bearing detail rather
 * than a defensive habit: a failing sample need not fail fast — wrangler's dev
 * proxy holds a GET it means to retry, and a worker that took the request and
 * stalled answers nothing at all — so a probe that merely awaited the response
 * would wedge beside the run it exists to stop.
 */
import { API_LIVENESS } from '../e2e/config/timeouts.js';

/** One sample: the worker answered 200, or it did not and this is why. */
export interface ProbeOutcome {
  ok: boolean;
  detail: string;
}

export type ApiLivenessProbe = () => Promise<ProbeOutcome>;

export interface ApiLivenessWatchdog {
  start(): void;
  stop(): void;
}

interface ApiLivenessWatchdogOptions {
  /** Probed URL, quoted in the reason so a reader knows what went unanswered. */
  endpoint: string;
  probe: ApiLivenessProbe;
  onTrip: (reason: string) => void;
}

/** Enough of a non-200 body to identify who answered. */
const BODY_EXCERPT_CHARS = 120;

const seconds = (ms: number): string => `${String(Math.round(ms / 1000))}s`;

// `String(error)` rather than a narrowed `.message`: a rejection can carry any
// value, and the class name an Error stringifies with belongs in the reason
// anyway.
const errorDetail = String;

/**
 * Sample `GET <healthUrl>` under its own deadline. A failed sample can arrive as
 * an HTTP answer rather than a transport error, so any non-200 counts as a
 * failure and carries its status and a body excerpt into the reason.
 */
export function createHealthProbe(
  healthUrl: string,
  timeoutMs: number = API_LIVENESS.PROBE_TIMEOUT
): ApiLivenessProbe {
  return async (): Promise<ProbeOutcome> => {
    try {
      const response = await fetch(healthUrl, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await response.text();
      const body = text.trim().slice(0, BODY_EXCERPT_CHARS);
      if (response.status === 200) return { ok: true, detail: '200' };
      const status = `HTTP ${String(response.status)}`;
      return { ok: false, detail: body === '' ? status : `${status} ${body}` };
    } catch (error) {
      // `AbortSignal.timeout` rejects with a TimeoutError; everything else is a
      // transport failure, whose message is the useful part.
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return { ok: false, detail: timedOut ? 'timeout' : errorDetail(error) };
    }
  };
}

function buildReason(fields: {
  endpoint: string;
  details: string[];
  spanMs: number;
  sinceLastSuccessMs: number | null;
  runningMs: number;
}): string {
  const { endpoint, details, spanMs, sinceLastSuccessMs, runningMs } = fields;
  const lastSeen =
    sinceLastSuccessMs === null
      ? `that endpoint never answered 200 in the ${seconds(runningMs)} since probing started`
      : `the last 200 was ${seconds(sinceLastSuccessMs)} before the abort`;
  return [
    `API liveness: ${String(details.length)} consecutive probes of GET ${endpoint}`,
    ` failed over ${seconds(spanMs)} (${details.join('; ')});`,
    ` ${lastSeen}.`,
    ' The run was interrupted rather than continued against a dead API.',
  ].join('');
}

/**
 * A trip is terminal: the watchdog stops itself before calling back, so an
 * abort that takes a moment to unwind cannot be reported twice.
 */
export function createApiLivenessWatchdog(
  options: ApiLivenessWatchdogOptions
): ApiLivenessWatchdog {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let startedMs = 0;
  let lastSuccessMs: number | null = null;
  let failures: string[] = [];
  let streakStartMs = 0;

  const schedule = (delayMs: number): void => {
    timer = setTimeout(() => {
      void cycle();
    }, delayMs);
    // The watchdog must never be the reason the runner process stays alive.
    timer.unref();
  };

  const sample = async (): Promise<ProbeOutcome> => {
    try {
      return await options.probe();
    } catch (error) {
      return { ok: false, detail: errorDetail(error) };
    }
  };

  const cycle = async (): Promise<void> => {
    const startedAt = Date.now();
    const outcome = await sample();
    if (!running) return;

    if (outcome.ok) {
      lastSuccessMs = Date.now();
      failures = [];
    } else {
      if (failures.length === 0) streakStartMs = startedAt;
      failures.push(outcome.detail);
      if (failures.length >= API_LIVENESS.TRIP_FAILURES) {
        running = false;
        const now = Date.now();
        options.onTrip(
          buildReason({
            endpoint: options.endpoint,
            details: failures,
            spanMs: now - streakStartMs,
            sinceLastSuccessMs: lastSuccessMs === null ? null : now - lastSuccessMs,
            runningMs: now - startedMs,
          })
        );
        return;
      }
    }

    // Measured from the sample's start, so a sample that consumed the whole
    // period is followed immediately: the trip window stays bounded by
    // `TRIP_FAILURES` periods whether samples fail fast or hang to their budget.
    schedule(Math.max(0, API_LIVENESS.PROBE_CADENCE - (Date.now() - startedAt)));
  };

  return {
    start(): void {
      running = true;
      startedMs = Date.now();
      lastSuccessMs = null;
      failures = [];
      schedule(API_LIVENESS.PROBE_CADENCE);
    },
    stop(): void {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
