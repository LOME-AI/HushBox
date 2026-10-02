import type { AccessLogEvent, AccessLogRead, AccessLogReader } from '../ports/index.js';

/**
 * The local/CI Access-log source: canned events, no network. The real
 * Cloudflare Access API is not locally exercisable, so dev/CI bind this and
 * tests drive the audit rules through it.
 */
export function createFakeAccessLogReader(events: readonly AccessLogEvent[]): AccessLogReader {
  return {
    listEvents(): Promise<AccessLogRead> {
      // Canned events are always the whole window — a fake that claimed a
      // truncated read would page an alert on every local run.
      return Promise.resolve({ events: [...events], pageLimitReached: false });
    },
  };
}
