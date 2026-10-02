/**
 * The Cloudflare Access authentication-log read port: the ~6-hourly pull
 * cron audits these events — the ceremony is the only enrollment path, so
 * any enrollment-shaped event is an alert, and an authentication outside
 * the actor allowlist is a compromised edge wall. Behind a port because the
 * real Cloudflare API is not locally exercisable: tests and dev/CI bind the
 * fake adapter.
 */

export interface AccessLogEvent {
  readonly email: string;
  /**
   * `authentication` = an ordinary Access login. `enrollment` = anything
   * that is NOT a plain login — adapters map unknown event shapes here
   * fail-closed, so a new Cloudflare event type alerts instead of passing
   * silently.
   */
  readonly kind: 'authentication' | 'enrollment';
  /** ISO timestamp as reported by the log source. */
  readonly occurredAt: string;
}

export interface AccessLogWindow {
  readonly since: Date;
  readonly until: Date;
}

export interface AccessLogRead {
  readonly events: readonly AccessLogEvent[];
  /**
   * True when the read could not prove it reached the end of the window: a
   * page came back at the size the read asked for, or the read stopped at its
   * own page ceiling — which reports unconditionally, since a source capping
   * pages below the size asked for never fills one. The auditor alerts on it,
   * because a window dense enough to keep the read paging is also the shape of
   * a flood staged to push older events past that ceiling. A legitimately busy
   * window trips it too; that false positive is the accepted cost of never
   * missing events silently.
   */
  readonly pageLimitReached: boolean;
}

export interface AccessLogReader {
  listEvents(window: AccessLogWindow): Promise<AccessLogRead>;
}
