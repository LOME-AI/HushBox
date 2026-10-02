import { utcDayKey } from '../utils/date.ts';
import { DAY_MS } from '../utils/durations.ts';

/** The admin SPA's audit trail route; its search params are the filters below. */
export const ADMIN_AUDIT_PATH = '/audit';

/**
 * A filtered view of the audit trail. The keys are the audit route's own search
 * params, which the route's tests parse back through its `validateSearch`.
 */
export type AdminAuditLinkFilter =
  | { readonly targetId: string }
  | { readonly from: string; readonly to: string }
  | { readonly action: string; readonly from: string; readonly to: string };

/** A link to the admin audit trail on `adminUrl`, filtered as given. */
export function adminAuditLink(adminUrl: string, filter: AdminAuditLinkFilter): string {
  const url = new URL(ADMIN_AUDIT_PATH, adminUrl);
  for (const [key, value] of Object.entries(filter)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

export interface UtcDayBounds {
  readonly start: Date;
  readonly end: Date;
}

/** A UTC day, `YYYY-MM-DD`, as its midnight and the next midnight. */
export function utcDayBounds(day: string): UtcDayBounds {
  const start = new Date(`${day}T00:00:00.000Z`);
  return { start, end: new Date(start.getTime() + DAY_MS) };
}

/**
 * The audit-trail filter covering a whole UTC day: the day to the next day as bare
 * dates, which the audit route reads as those two midnights. The audit read is
 * inclusive at both bounds, so a row at exactly the next midnight shows in both
 * days' links and no row falls in neither.
 */
export function adminAuditDayFilter(day: string): { readonly from: string; readonly to: string } {
  const { start, end } = utcDayBounds(day);
  return { from: utcDayKey(start), to: utcDayKey(end) };
}
