import { sanitizeErrorName, stackFrameLines } from './error-scrub.js';
import { pickSafeLogFields } from './safe-log-fields.js';
import type { ScheduleCheckIn } from './check-in.js';
import type { Telemetry } from './port.js';
import type { SafeLogFields } from './safe-log-fields.js';

/**
 * The level-aware emission seam. Defaults to the global console, to which each
 * level writes one JSON line; injectable so tests can record or sabotage
 * emission.
 */
export interface ConsoleSink {
  debug(line: string): void;
  info(line: string): void;
  warn(line: string): void;
  error(line: string): void;
}

type LogLevel = keyof ConsoleSink;

/**
 * Console adapter for the Telemetry port: the structured, allowlisted channel
 * the scrub machinery governs. In production it reaches no one: no watcher,
 * exporter, or query job reads a line of it, and on the Worker's own entry
 * paths `[observability] enabled = false` (`apps/api/wrangler.toml`) means
 * nothing ingests one either. The ingest half is scoped because that flag is
 * the Worker script's, while this factory is also bound inside the Durable
 * Object isolates.
 *
 * Best-effort by contract: every emission is guarded, so a sink or
 * serialization failure is swallowed (one attempt, no fallback channel — there
 * is nowhere safer to report a telemetry failure than not at all).
 *
 * This file is the single allowed `console` caller in backend code (the
 * redaction lint exempts it by filename); everything else logs through the
 * port.
 */
export function createConsoleTelemetry(sink: ConsoleSink = console): Telemetry & ScheduleCheckIn {
  // Payload construction runs inside the guard via the thunk: field objects
  // and Error properties are caller-controlled and can throw from getters,
  // and the port's error channel is `never` (telemetry must not block or
  // fail the request it observes).
  const emit = (level: LogLevel, buildPayload: () => Record<string, unknown>): void => {
    try {
      sink[level](JSON.stringify({ level, ...buildPayload() }));
      // eslint-disable-next-line catch-swallow/no-silent-catch -- best-effort port: one attempt, no fallback channel.
    } catch {
      // Best-effort port: one attempt, no fallback channel — there is nowhere
      // safer to report a telemetry failure than not at all.
    }
  };

  const logAt =
    (level: LogLevel) =>
    (msg: string, fields?: SafeLogFields): void => {
      emit(level, () => ({ msg, ...pickSafeLogFields(fields ?? {}) }));
    };

  const info = logAt('info');

  return {
    debug: logAt('debug'),
    info,
    warn: logAt('warn'),
    error: logAt('error'),
    captureError(error: Error, errorCode: string): void {
      emit('error', () => ({
        msg: 'error.captured',
        errorCode,
        errorName: sanitizeErrorName(error.name),
        stack: stackFrameLines(error).join('\n'),
      }));
    },
    checkIn(status: 'in_progress' | 'ok'): void {
      if (status === 'in_progress') {
        info('cron monitor check-in started');
        return;
      }
      info('cron monitor check-in finished');
    },
  };
}
