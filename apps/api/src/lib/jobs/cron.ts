import { FINGERPRINT_CODES } from '../telemetry/index.js';
import {
  dependencyFailureOf,
  dependencyUnavailableReport,
  isReachabilityFailure,
} from '../context/dependency-failure.js';
import type { ResultAsync } from '../result/index.js';
import type { DomainError } from '../errors/index.js';
import type { Telemetry } from '../telemetry/index.js';

/**
 * One unit of scheduled work. Entries are isolated by the runner: one
 * entry's failure never stops its cadence siblings, and a failure is a
 * telemetry event, never a thrown scheduled-handler error (Workers would
 * retry nothing useful — every entry is idempotent and re-runs next tick).
 */
export interface CronEntry {
  /** Rides the `jobType` structured-log field on failure; content-free. */
  readonly name: string;
  readonly run: () => Promise<void>;
}

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason));
}

/**
 * Runs a pass's entries one at a time, in list order, each settled before the
 * next starts: the pass holds one connection, and an entry waiting on it while
 * another's statement runs would fail at the acquire deadline instead. A failed
 * entry is captured and the next one runs; a hung entry delays the rest of its
 * pass. An entry that settles with a statement still in flight leaves the
 * connection checked out, so the next entry to reach the database is refused.
 *
 * A failure whose cause chain names Postgres or Redis and says it was not
 * reached is captured as the request path captures one, under the dependency
 * code with the classification and nothing of the error. Any other failure (a
 * store's error answer, an overlap refusal, a deadline no dependency claims)
 * names no unreachable dependency and is captured whole under the entry code:
 * the code decides how Sentry titles and groups the event, so only an outage
 * the event can name is filed as one.
 */
export async function runCronEntries(
  entries: readonly CronEntry[],
  telemetry: Telemetry
): Promise<{ readonly anyFailed: boolean }> {
  let anyFailed = false;
  for (const entry of entries) {
    try {
      await entry.run();
    } catch (error) {
      anyFailed = true;
      const classified = dependencyFailureOf(error);
      const named =
        classified.dependency !== 'unknown' && isReachabilityFailure(classified.failure);
      const errorCode = named
        ? FINGERPRINT_CODES.dependencyUnavailable
        : FINGERPRINT_CODES.cronEntryFailed;
      telemetry.error('cron entry failed', { jobType: entry.name, errorCode });
      telemetry.captureError(
        named ? dependencyUnavailableReport(classified) : toError(error),
        errorCode
      );
    }
  }
  return { anyFailed };
}

/**
 * Bridges a domain `Result` into a cron entry's throw-based failure channel.
 * The thrown message is the domain code (codes, never content); the full
 * domain error rides `cause` for the Telemetry port's scrubbed capture.
 */
export async function runOrThrow<T>(result: ResultAsync<T, DomainError>): Promise<T> {
  const settled = await result;
  if (settled.isErr()) {
    throw new Error(settled.error.code, { cause: settled.error });
  }
  return settled.value;
}
