import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAuditFixture, FIXTURE_AUDIT_DATE } from '@/test-utils/audit-fixture';
import { fakeRequest, fakeResponse } from '@/test-utils/fake-http';
import { fakeWatchers } from '@/test-utils/fake-watchers';
import { createAuditService } from '@/server/audit-service';
import { createEventHub } from '@/server/events';
import { createRouter } from '@/server/routes';
import {
  auditBriefUrl,
  auditEventsUrl,
  auditSnapshotUrl,
  auditSourceUrl,
  findingWriteUrl,
} from './audit-routes';
import type { AuditFixture } from '@/test-utils/audit-fixture';
import type { FakeResponse } from '@/test-utils/fake-http';
import type { FakeWatchers } from '@/test-utils/fake-watchers';
import type { Router } from '@/server/routes';

const AUDIT = '2026-07-30';

/** What the address bar can hand over: the audit name is taken verbatim from the URL. */
const TRAVERSING = '../secrets';

describe('auditSnapshotUrl', () => {
  it('reads the unaddressed route when the console has not chosen an audit', () => {
    expect(auditSnapshotUrl(null)).toBe('/api/audit');
  });

  it('addresses the named audit', () => {
    expect(auditSnapshotUrl(AUDIT)).toBe('/api/audits/2026-07-30/audit');
  });

  it('encodes the audit name', () => {
    expect(auditSnapshotUrl(TRAVERSING)).toBe('/api/audits/..%2Fsecrets/audit');
  });
});

describe('auditEventsUrl', () => {
  it('addresses the named audit', () => {
    expect(auditEventsUrl(AUDIT)).toBe('/api/audits/2026-07-30/events');
  });

  it('encodes the audit name', () => {
    expect(auditEventsUrl(TRAVERSING)).toBe('/api/audits/..%2Fsecrets/events');
  });
});

describe('auditBriefUrl', () => {
  it('carries the query the caller built', () => {
    const query = new URLSearchParams({ ids: 'A-1,A-2' });

    expect(auditBriefUrl(AUDIT, query)).toBe('/api/audits/2026-07-30/brief?ids=A-1%2CA-2');
  });

  it('encodes the audit name', () => {
    const query = new URLSearchParams({ ids: 'A-1' });

    expect(auditBriefUrl(TRAVERSING, query)).toBe('/api/audits/..%2Fsecrets/brief?ids=A-1');
  });
});

describe('auditSourceUrl', () => {
  it('carries the query the caller built', () => {
    const query = new URLSearchParams({ path: 'apps/docket/src/app.tsx', start: '1', end: '2' });

    expect(auditSourceUrl(AUDIT, query)).toBe(
      '/api/audits/2026-07-30/source?path=apps%2Fdocket%2Fsrc%2Fapp.tsx&start=1&end=2'
    );
  });

  it('encodes the audit name', () => {
    const query = new URLSearchParams({ path: 'a.ts' });

    expect(auditSourceUrl(TRAVERSING, query)).toBe('/api/audits/..%2Fsecrets/source?path=a.ts');
  });
});

describe('findingWriteUrl', () => {
  it('addresses the action on the finding', () => {
    expect(findingWriteUrl(AUDIT, 'AI-1', 'rule')).toBe('/api/audits/2026-07-30/finding/AI-1/rule');
  });

  it('encodes the audit name', () => {
    expect(findingWriteUrl(TRAVERSING, 'AI-1', 'deny')).toBe(
      '/api/audits/..%2Fsecrets/finding/AI-1/deny'
    );
  });

  it('encodes the finding id', () => {
    expect(findingWriteUrl(AUDIT, 'TS-NF/1', 'deny')).toBe(
      '/api/audits/2026-07-30/finding/TS-NF%2F1/deny'
    );
  });
});

/**
 * The other half of the address. Every test above compares a builder against a
 * literal, which is the same evidence the server's own route table already has
 * about itself — two spellings that agree only as long as nobody renames one.
 * These hand each builder's output to the real router, so a route the server
 * stops serving under that name is a red test here rather than a console that
 * loads to a 404.
 */
describe('the addresses the server serves', () => {
  let fixture: AuditFixture;
  let router: Router;
  let watchers: FakeWatchers;

  beforeEach(async () => {
    fixture = await createAuditFixture();
    watchers = fakeWatchers();
    router = createRouter({
      service: createAuditService({ repoRoot: fixture.root, defaultAudit: null }),
      events: createEventHub(watchers.open),
      now: () => '2026-07-31',
    });
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  async function call(method: string, url: string, body?: unknown): Promise<FakeResponse> {
    const res = fakeResponse();
    await router.handle(fakeRequest(method, url, body), res);
    return res;
  }

  it('serves the unaddressed read a console that has chosen no audit asks for', async () => {
    const res = await call('GET', auditSnapshotUrl(null));

    expect(res.statusCode).toBe(200);
    expect((res.json() as { findings: { id: string }[] }).findings.map((f) => f.id)).toEqual([
      'AC-1',
      'AC-2',
    ]);
  });

  it('serves the snapshot of the audit the builder addressed', async () => {
    const res = await call('GET', auditSnapshotUrl(FIXTURE_AUDIT_DATE));

    expect(res.statusCode).toBe(200);
    expect((res.json() as { audit: { date: string } }).audit.date).toBe(FIXTURE_AUDIT_DATE);
  });

  it('serves the event stream at the address the builder addressed', async () => {
    const res = fakeResponse();
    const req = fakeRequest('GET', auditEventsUrl(FIXTURE_AUDIT_DATE));
    await router.handle(req, res);

    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(watchers.opened).toHaveLength(1);
    req.close();
  });

  it('serves the brief at the address the builder addressed', async () => {
    const res = await call(
      'GET',
      auditBriefUrl(FIXTURE_AUDIT_DATE, new URLSearchParams({ ids: 'AC-1' }))
    );

    expect(res.statusCode).toBe(200);
    expect((res.json() as { text: string }).text).toContain('AC-1');
  });

  it('serves the source window at the address the builder addressed', async () => {
    const res = await call(
      'GET',
      auditSourceUrl(FIXTURE_AUDIT_DATE, new URLSearchParams({ path: 'src/inside.ts', start: '2' }))
    );

    expect(res.statusCode).toBe(200);
    expect((res.json() as { lines: string[] }).lines).toContain('two');
  });

  it('takes the write at the address the builder addressed', async () => {
    const res = await call('POST', findingWriteUrl(FIXTURE_AUDIT_DATE, 'AC-1', 'rule'), {
      option: 'A',
    });

    expect(res.statusCode).toBe(200);
    expect((res.json() as { finding: { state: string } }).finding.state).toBe('ruled');
  });
});
