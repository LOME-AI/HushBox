import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  ACCESS_LOG_MAX_PAGES,
  ACCESS_LOG_PAGE_SIZE,
  createCloudflareAccessLogReader,
} from './access-log-cloudflare.js';

const WINDOW = {
  since: new Date(TEST_DAY_START + 5 * HOUR_MS),
  until: new Date(TEST_DAY_START + 12 * HOUR_MS),
};

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Answers each successive request with the next body, repeating the last one
 * once the list runs out — so a single full page stands in for an inexhaustible
 * log without materializing one page per request.
 */
function readerWith(
  bodies: readonly unknown[],
  status = 200
): { reader: ReturnType<typeof createCloudflareAccessLogReader>; requests: Request[] } {
  const requests: Request[] = [];
  const reader = createCloudflareAccessLogReader({
    accountId: 'test-account-id',
    apiToken: 'test-token',
    fetch: (input, init) => {
      requests.push(new Request(input, init));
      const body = bodies[Math.min(requests.length - 1, bodies.length - 1)];
      return Promise.resolve(jsonResponse(body, status));
    },
  });
  return { reader, requests };
}

function loginRows(count: number): { user_email: string; action: string; created_at: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    user_email: `admin${String(index)}@hushbox.test`,
    action: 'login',
    created_at: isoAt(TEST_DAY_START + 11 * HOUR_MS),
  }));
}

function page(rows: unknown[]): unknown {
  return { success: true, result: rows };
}

const okBody = page([
  {
    user_email: 'admin@hushbox.test',
    action: 'login',
    allowed: true,
    created_at: isoAt(TEST_DAY_START + 11 * HOUR_MS),
  },
  {
    user_email: 'admin@hushbox.test',
    action: 'registration',
    allowed: true,
    created_at: isoAt(TEST_DAY_START + 11 * HOUR_MS + 30 * MINUTE_MS),
  },
]);

const fullPage = page(loginRows(ACCESS_LOG_PAGE_SIZE));

describe('createCloudflareAccessLogReader', () => {
  it('requests the Access access_requests log with the bearer token and window', async () => {
    const { reader, requests } = readerWith([page([])]);
    await reader.listEvents(WINDOW);
    expect(requests).toHaveLength(1);
    const request = requests[0];
    expect(request?.url).toContain(
      'https://api.cloudflare.com/client/v4/accounts/test-account-id/access/logs/access_requests'
    );
    expect(request?.url).toContain(`since=${encodeURIComponent(WINDOW.since.toISOString())}`);
    expect(request?.url).toContain(`until=${encodeURIComponent(WINDOW.until.toISOString())}`);
    expect(request?.url).toContain(`per_page=${String(ACCESS_LOG_PAGE_SIZE)}`);
    expect(request?.url).toContain(`limit=${String(ACCESS_LOG_PAGE_SIZE)}`);
    expect(request?.url).toContain('page=1');
    expect(request?.headers.get('authorization')).toBe('Bearer test-token');
  });

  it('maps login actions to authentication and everything else to enrollment (fail-closed)', async () => {
    const { reader } = readerWith([okBody, page([])]);
    const read = await reader.listEvents(WINDOW);
    expect(read.events).toEqual([
      {
        email: 'admin@hushbox.test',
        kind: 'authentication',
        occurredAt: isoAt(TEST_DAY_START + 11 * HOUR_MS),
      },
      {
        email: 'admin@hushbox.test',
        kind: 'enrollment',
        occurredAt: isoAt(TEST_DAY_START + 11 * HOUR_MS + 30 * MINUTE_MS),
      },
    ]);
  });

  it('stops on an empty page and reports the page limit was never reached', async () => {
    const { reader, requests } = readerWith([page([])]);
    const read = await reader.listEvents(WINDOW);
    expect(requests).toHaveLength(1);
    expect(read.events).toHaveLength(0);
    expect(read.pageLimitReached).toBe(false);
  });

  it('confirms a short page against a following page before calling the window exhausted', async () => {
    const { reader, requests } = readerWith([okBody, page([])]);
    const read = await reader.listEvents(WINDOW);
    expect(requests).toHaveLength(2);
    expect(read.events).toHaveLength(2);
    expect(read.pageLimitReached).toBe(false);
  });

  it('paginates past pages the source returns shorter than requested', async () => {
    const { reader, requests } = readerWith([
      page(loginRows(25)),
      page(loginRows(25)),
      page(loginRows(7)),
    ]);
    const read = await reader.listEvents(WINDOW);
    expect(requests).toHaveLength(3);
    expect(read.events).toHaveLength(57);
    expect(read.pageLimitReached).toBe(false);
  });

  it('reports the page limit reached when pages shorter than requested run to the page cap', async () => {
    const { reader, requests } = readerWith([page(loginRows(25))]);
    const read = await reader.listEvents(WINDOW);
    expect(requests).toHaveLength(ACCESS_LOG_MAX_PAGES);
    expect(read.events).toHaveLength(25 * ACCESS_LOG_MAX_PAGES);
    expect(read.pageLimitReached).toBe(true);
  });

  it('follows pagination past a full page until one comes back short', async () => {
    const { reader, requests } = readerWith([fullPage, page(loginRows(3))]);
    const read = await reader.listEvents(WINDOW);
    expect(requests).toHaveLength(2);
    expect(requests[1]?.url).toContain('page=2');
    expect(read.events).toHaveLength(ACCESS_LOG_PAGE_SIZE + 3);
  });

  it('reports the page limit reached when any page comes back at the page size', async () => {
    const { reader } = readerWith([fullPage, page(loginRows(3))]);
    const read = await reader.listEvents(WINDOW);
    expect(read.pageLimitReached).toBe(true);
  });

  it('stops at the page cap rather than paginating a flooded window forever', async () => {
    const { reader, requests } = readerWith([fullPage]);
    const read = await reader.listEvents(WINDOW);
    expect(requests).toHaveLength(ACCESS_LOG_MAX_PAGES);
    expect(read.events).toHaveLength(ACCESS_LOG_PAGE_SIZE * ACCESS_LOG_MAX_PAGES);
    expect(read.pageLimitReached).toBe(true);
  });

  it('throws on a non-2xx response, carrying the status code only', async () => {
    const { reader } = readerWith([{ success: false }], 403);
    await expect(reader.listEvents(WINDOW)).rejects.toThrow('403');
  });

  it('throws when the API reports success=false on a 2xx response', async () => {
    const { reader } = readerWith([{ success: false, result: [] }]);
    await expect(reader.listEvents(WINDOW)).rejects.toThrow('success=false');
  });

  it('throws on an unparseable response body', async () => {
    const { reader } = readerWith([{ success: true, result: [{ bogus: true }] }]);
    await expect(reader.listEvents(WINDOW)).rejects.toThrow();
  });
});
