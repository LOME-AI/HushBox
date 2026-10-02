import { describe, expect, it } from 'vitest';
import { HOUR_MS, MINUTE_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import {
  ACCESS_LOG_PAGE_SIZE,
  createCloudflareAccessLogReader,
  createFakeAccessLogReader,
} from '../index.js';
import { ACCESS_LOG_LOOKBACK_MS, createAccessLogAuditEntry } from './access-log-audit.js';
import type { AccessLogEvent, AccessLogReader, AccessLogWindow } from '../ports/index.js';
import type { Telemetry } from '../../../lib/telemetry/index.js';

const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);
/** What the wall admits: an address in the actor allowlist that the role map
 * also gives a role to. */
const ADMITTED = new Set(['admin@hushbox.test', 'ops@hushbox.test']);

function createLogger(): { logger: Telemetry; capturedCodes: string[] } {
  const capturedCodes: string[] = [];
  const noop = (): void => undefined;
  return {
    capturedCodes,
    logger: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
      captureError: (_error, errorCode) => {
        capturedCodes.push(errorCode);
      },
    },
  };
}

function entryWithReader(reader: AccessLogReader): {
  run: () => Promise<void>;
  capturedCodes: string[];
  windows: AccessLogWindow[];
} {
  const { logger, capturedCodes } = createLogger();
  const windows: AccessLogWindow[] = [];
  const entry = createAccessLogAuditEntry({
    resolveReader: () => ({
      listEvents: (window) => {
        windows.push(window);
        return reader.listEvents(window);
      },
    }),
    admittedActors: () => ADMITTED,
    telemetry: logger,
    now: () => NOW,
  });
  expect(entry.name).toBe('admin-access-log-audit');
  return { run: entry.run, capturedCodes, windows };
}

function entryWith(events: readonly AccessLogEvent[]): ReturnType<typeof entryWithReader> {
  return entryWithReader(createFakeAccessLogReader(events));
}

describe('createAccessLogAuditEntry', () => {
  it('alerts on an authentication by an email the wall does not admit', async () => {
    const { run, capturedCodes } = entryWith([
      {
        email: 'intruder@example.com',
        kind: 'authentication',
        occurredAt: isoAt(TEST_DAY_START + 11 * HOUR_MS),
      },
    ]);
    await run();
    expect(capturedCodes).toEqual(['admin_access_unexpected_actor']);
  });

  it('alerts on every enrollment-shaped event, allowlisted or not', async () => {
    const { run, capturedCodes } = entryWith([
      {
        email: 'admin@hushbox.test',
        kind: 'enrollment',
        occurredAt: isoAt(TEST_DAY_START + 11 * HOUR_MS),
      },
    ]);
    await run();
    expect(capturedCodes).toEqual(['admin_access_enrollment_event']);
  });

  it('stays silent on authentications by admitted actors', async () => {
    const { run, capturedCodes } = entryWith([
      {
        email: 'Admin@hushbox.test',
        kind: 'authentication',
        occurredAt: isoAt(TEST_DAY_START + 11 * HOUR_MS),
      },
      {
        email: 'ops@hushbox.test',
        kind: 'authentication',
        occurredAt: isoAt(TEST_DAY_START + 11 * HOUR_MS + 5 * MINUTE_MS),
      },
    ]);
    await run();
    expect(capturedCodes).toEqual([]);
  });

  it('alerts when the read hit its page limit, since events may lie beyond view', async () => {
    const { run, capturedCodes } = entryWithReader({
      listEvents: () => Promise.resolve({ events: [], pageLimitReached: true }),
    });
    await run();
    expect(capturedCodes).toEqual(['admin_access_log_page_limit']);
  });

  it('still applies both rules to the events a page-limited read did return', async () => {
    const { run, capturedCodes } = entryWithReader({
      listEvents: () =>
        Promise.resolve({
          events: [
            {
              email: 'intruder@example.com',
              kind: 'authentication',
              occurredAt: isoAt(TEST_DAY_START + 11 * HOUR_MS),
            },
          ],
          pageLimitReached: true,
        }),
    });
    await run();
    expect(capturedCodes).toEqual(['admin_access_log_page_limit', 'admin_access_unexpected_actor']);
  });

  it('carries a flooded Cloudflare read all the way to the alert', async () => {
    const rows = Array.from({ length: ACCESS_LOG_PAGE_SIZE }, () => ({
      user_email: 'admin@hushbox.test',
      action: 'login',
      created_at: isoAt(TEST_DAY_START + 11 * HOUR_MS),
    }));
    const { run, capturedCodes } = entryWithReader(
      createCloudflareAccessLogReader({
        accountId: 'test-account-id',
        apiToken: 'test-token',
        // Every page comes back full: the window holds more than the read can
        // reach, which is exactly the flood the auditor must not pass over.
        fetch: () => Promise.resolve(Response.json({ success: true, result: rows })),
      })
    );
    await run();
    expect(capturedCodes).toEqual(['admin_access_log_page_limit']);
  });

  it('pulls the overlap-margined lookback window ending now', async () => {
    const { run, windows } = entryWith([]);
    await run();
    expect(windows).toHaveLength(1);
    expect(windows[0]?.until).toEqual(NOW);
    expect(windows[0]?.since).toEqual(new Date(NOW.getTime() - ACCESS_LOG_LOOKBACK_MS));
  });
});
