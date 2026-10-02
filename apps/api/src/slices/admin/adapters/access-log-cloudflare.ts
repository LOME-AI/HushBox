import { z } from 'zod';
import type {
  AccessLogEvent,
  AccessLogRead,
  AccessLogReader,
  AccessLogWindow,
} from '../ports/index.js';

/**
 * The real Cloudflare Access authentication-log adapter. Request shape
 * (Cloudflare API v4, "Access authentication logs"):
 *
 *   GET https://api.cloudflare.com/client/v4/accounts/{account_id}/access/logs/access_requests
 *       ?since=<ISO 8601>&until=<ISO 8601>&per_page=<n>&limit=<n>&page=<n>&direction=desc
 *   Authorization: Bearer <token with the Access: Audit Logs read scope>
 *
 * responding `{ success, result: [{ user_email, action, allowed,
 * created_at, … }] }`. Mapping is fail-closed: `action === 'login'` is an
 * ordinary authentication; ANY other action (registration/enrollment or a
 * future event type) maps to `enrollment` so the audit cron alerts on it.
 * Free-tier Access retains these logs for only 24 hours — the ~6-hourly
 * cadence is load-bearing.
 *
 * Not locally exercisable: dev/CI bind the
 * fake adapter; this client is covered by stubbed-fetch unit tests only.
 */

const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4';

export const ACCESS_LOG_PAGE_SIZE = 1000;

/**
 * The read's own ceiling on pages, so a flooded window costs a bounded number
 * of API calls per pass instead of an unbounded one. Reaching it always
 * reports `pageLimitReached`, whatever size the pages came back at, so a read
 * the ceiling cut short can never look exhaustive — an offset parameter the
 * API ignored, or a server-side page cap below the size we ask for, both land
 * here and both make the auditor alert.
 */
export const ACCESS_LOG_MAX_PAGES = 20;

const accessRequestRowSchema = z.object({
  user_email: z.string(),
  action: z.string(),
  created_at: z.string(),
});

const accessRequestsResponseSchema = z.object({
  success: z.boolean(),
  result: z.array(accessRequestRowSchema),
});

interface CloudflareAccessLogConfig {
  readonly accountId: string;
  readonly apiToken: string;
  readonly fetch: typeof globalThis.fetch;
}

type AccessRequestRow = z.infer<typeof accessRequestRowSchema>;

async function fetchPage(
  config: CloudflareAccessLogConfig,
  window: AccessLogWindow,
  page: number
): Promise<readonly AccessRequestRow[]> {
  const url = new URL(
    `${CLOUDFLARE_API_BASE_URL}/accounts/${config.accountId}/access/logs/access_requests`
  );
  url.searchParams.set('since', window.since.toISOString());
  url.searchParams.set('until', window.until.toISOString());
  // `per_page` and `limit` are two separate documented parameters of this one
  // endpoint and both default to 25, so sending only one leaves the other's
  // default free to shrink the read. Both carry the page size.
  url.searchParams.set('per_page', String(ACCESS_LOG_PAGE_SIZE));
  url.searchParams.set('limit', String(ACCESS_LOG_PAGE_SIZE));
  url.searchParams.set('page', String(page));
  // Newest first, so a window the page cap cuts short keeps the most recent
  // events in view rather than the oldest.
  url.searchParams.set('direction', 'desc');
  const response = await config.fetch(url.toString(), {
    method: 'GET',
    headers: { authorization: `Bearer ${config.apiToken}` },
  });
  if (!response.ok) {
    // Codes only, never response content (it could carry identities).
    throw new Error(`cloudflare access-log request failed with status ${String(response.status)}`);
  }
  const parsed = accessRequestsResponseSchema.parse(await response.json());
  if (!parsed.success) {
    throw new Error('cloudflare access-log request returned success=false');
  }
  return parsed.result;
}

export function createCloudflareAccessLogReader(
  config: CloudflareAccessLogConfig
): AccessLogReader {
  return {
    async listEvents(window: AccessLogWindow): Promise<AccessLogRead> {
      const events: AccessLogEvent[] = [];
      let pageLimitReached = false;
      // The response envelope carries no total, so page fullness is the only
      // exhaustion signal there is — and "shorter than we asked for" does not
      // mean it: the source may cap a page below the requested size, which
      // would read as an exhausted window on page 1. Exhaustion is therefore a
      // page shorter than the largest one the source has actually produced.
      let largestPageSeen = 0;
      for (let page = 1; page <= ACCESS_LOG_MAX_PAGES; page += 1) {
        const rows = await fetchPage(config, window, page);
        events.push(
          ...rows.map((row) => ({
            email: row.user_email,
            kind: row.action === 'login' ? ('authentication' as const) : ('enrollment' as const),
            occurredAt: row.created_at,
          }))
        );
        if (rows.length >= ACCESS_LOG_PAGE_SIZE) {
          pageLimitReached = true;
        }
        if (rows.length === 0 || rows.length < largestPageSeen) {
          return { events, pageLimitReached };
        }
        largestPageSeen = rows.length;
      }
      return { events, pageLimitReached: true };
    },
  };
}
