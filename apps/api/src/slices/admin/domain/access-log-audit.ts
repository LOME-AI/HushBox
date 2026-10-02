import { FINGERPRINT_CODES } from '../../../lib/telemetry/index.js';
import type { AccessLogReader } from '../ports/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';
import type { CronEntry } from '../../../lib/jobs/index.js';

/**
 * The ~6-hourly Access-log auditor (read-only — it never touches domain
 * state; its only outputs are telemetry alerts). Three rules, all pages:
 * an authentication by an email the in-Worker wall would NOT admit — which
 * takes both the actor allowlist and a role-map entry, so an allowlisted
 * address carrying no role pages exactly as a stranger does (the edge wall
 * admitted someone the wall behind it would refuse), ANY
 * enrollment-shaped event — the physical ceremony is the only enrollment
 * path, so an enrollment in the logs is an attacker enrolling a factor —
 * and a read that reached its page limit, because a window dense enough to
 * fill a page is the shape of a flood staged to push older events out of
 * the auditor's reach, and a full page ends the read's proof that it saw
 * everything.
 * Free-tier Access retains logs 24 h; the 6-hour
 * cadence with an overlap-margined lookback gives multiple retries inside
 * that window.
 */

export const ACCESS_LOG_LOOKBACK_MS = 7 * 60 * 60 * 1000;

interface AccessLogAuditEntryDeps {
  /** Resolved inside `run` so a config fault is an isolated entry failure. */
  readonly resolveReader: () => AccessLogReader;
  /**
   * The actors the in-Worker wall admits — the intersection of the two
   * bindings, not either one alone. This auditor's contract is to alert on an
   * authentication that wall would have refused, so this set and the wall's
   * own two refusals are one derivation, `adminAdmittedActors` in
   * `apps/api/src/lib/context/admin-allowlist.ts`.
   */
  readonly admittedActors: () => ReadonlySet<string>;
  readonly telemetry: Telemetry;
  readonly now: () => Date;
}

export function createAccessLogAuditEntry(deps: AccessLogAuditEntryDeps): CronEntry {
  return {
    name: 'admin-access-log-audit',
    run: async (): Promise<void> => {
      const until = deps.now();
      const since = new Date(until.getTime() - ACCESS_LOG_LOOKBACK_MS);
      const read = await deps.resolveReader().listEvents({ since, until });
      if (read.pageLimitReached) {
        deps.telemetry.error('access log read reached its page limit', {
          errorCode: 'admin_access_log_page_limit',
        });
        deps.telemetry.captureError(
          new Error('access log read reached its page limit'),
          FINGERPRINT_CODES.adminAccessLogPageLimit
        );
      }
      const admitted = deps.admittedActors();
      for (const event of read.events) {
        if (event.kind === 'enrollment') {
          deps.telemetry.error('access log shows an enrollment-shaped event', {
            errorCode: 'admin_access_enrollment_event',
          });
          deps.telemetry.captureError(
            new Error('access log shows an enrollment-shaped event'),
            FINGERPRINT_CODES.adminAccessEnrollmentEvent
          );
          continue;
        }
        if (!admitted.has(event.email.toLowerCase())) {
          deps.telemetry.error('access log shows an authentication the wall would refuse', {
            errorCode: 'admin_access_unexpected_actor',
          });
          deps.telemetry.captureError(
            new Error('access log shows an authentication the wall would refuse'),
            FINGERPRINT_CODES.adminAccessUnexpectedActor
          );
        }
      }
    },
  };
}
