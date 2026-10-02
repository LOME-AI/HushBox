import type { FindingAction } from '../finding-actions';

/**
 * Where the console reaches one audit. Every caller builds its URL here rather
 * than spelling the prefix again, because nothing links a client literal to the
 * server's route patterns at compile time: a prefix rename that missed one call
 * site would leave that site and its own test green while the console 404s.
 *
 * The name comes off the address bar verbatim, so the encoding is what keeps a
 * `../` out of the path — one place to hold that rather than a convention every
 * new caller has to remember.
 */
function auditRoute(audit: string, segment: string): string {
  return `/api/audits/${encodeURIComponent(audit)}/${segment}`;
}

/**
 * Where an audit is read. A `null` name is a client that has not chosen one,
 * and the unaddressed route is the only one that can answer which audit it
 * gets — every other read names the audit it wants.
 */
export function auditSnapshotUrl(audit: string | null): string {
  return audit === null ? '/api/audit' : auditRoute(audit, 'audit');
}

/** Where the audit announces which finding moved. */
export function auditEventsUrl(audit: string): string {
  return auditRoute(audit, 'events');
}

/** Where the formatted brief for a set of findings is produced. */
export function auditBriefUrl(audit: string, query: URLSearchParams): string {
  return `${auditRoute(audit, 'brief')}?${query.toString()}`;
}

/** Where a cited window of a source file is read. */
export function auditSourceUrl(audit: string, query: URLSearchParams): string {
  return `${auditRoute(audit, 'source')}?${query.toString()}`;
}

/** Where one action is posted against one finding. */
export function findingWriteUrl(audit: string, findingId: string, action: FindingAction): string {
  return auditRoute(audit, `finding/${encodeURIComponent(findingId)}/${action}`);
}
