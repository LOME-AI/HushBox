import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { applyWrite, patchWrite, updateProgress } from '@hushbox/docket';
import {
  createAuditFixture,
  findingFile,
  FIXTURE_AUDIT_DATE,
  FIXTURE_AUDIT_HEADER,
  type AuditFixture,
} from '../test-utils/audit-fixture';
import { fakeRequest, fakeResponse, type FakeResponse } from '../test-utils/fake-http';
import { holdFindingLock } from '../test-utils/hold-lock';
import { fakeWatchers, type FakeWatchers } from '../test-utils/fake-watchers';
import { runList } from '../cli/list';
import { FINDING_ACTIONS } from '../finding-actions';
import { createAuditService } from './audit-service';
import { createEventHub } from './events';
import { createRouter } from './routes';
import type { FindingJson } from '@hushbox/docket';
import type { AuditService, ServiceErrorCode } from './audit-service';
import type { ApiRequest, Router } from './routes';

/** The path prefix every audit-addressed route carries, at the fixture's audit. */
const AUDIT = `/api/audits/${FIXTURE_AUDIT_DATE}`;

let fixture: AuditFixture;
let router: ReturnType<typeof createRouter>;
let hub: ReturnType<typeof createEventHub>;
let watchers: FakeWatchers;

function auditDirOf(name: string): string {
  return path.join(fixture.root, 'docs', 'audits', name);
}

beforeEach(async () => {
  fixture = await createAuditFixture();
  watchers = fakeWatchers();
  hub = createEventHub(watchers.open);
  router = createRouter({
    service: createAuditService({ repoRoot: fixture.root, defaultAudit: null }),
    events: hub,
    now: () => '2026-07-31',
  });
});

afterEach(async () => {
  await fixture.cleanup();
});

async function call(
  method: string,
  url: string,
  body?: unknown
): Promise<{ handled: boolean; res: FakeResponse }> {
  const res = fakeResponse();
  const handled = await router.handle(fakeRequest(method, url, body), res);
  return { handled, res };
}

async function post(id: string, action: string, body: unknown = {}): Promise<FakeResponse> {
  const { res } = await call('POST', `${AUDIT}/finding/${id}/${action}`, body);
  return res;
}

/** A POST whose body is bytes the JSON parser will refuse. */
function rawBody(url: string, text: string): ApiRequest {
  const request = Readable.from([Buffer.from(text, 'utf8')]) as Readable & {
    url: string;
    method: string;
  };
  request.url = url;
  request.method = 'POST';
  return request;
}

function finding(res: FakeResponse): FindingJson {
  return (res.json() as { finding: FindingJson }).finding;
}

function errorCode(res: FakeResponse): string {
  return (res.json() as { error: { code: string } }).error.code;
}

/** The finding as a reader holding the console's snapshot has it. */
async function read(id: string): Promise<FindingJson> {
  const { res } = await call('GET', '/api/audit');
  const found = (res.json() as { findings: FindingJson[] }).findings.find(
    (entry) => entry.id === id
  );
  if (found === undefined) throw new Error(`no finding "${id}" in the snapshot`);
  return found;
}

/**
 * An implementation agent's write, made the way its CLI makes it: straight at
 * the file, outside everything the console has read.
 */
async function agentWrites(
  id: string,
  patch: { status?: 'blocked' | 'in-progress' | 'done'; note?: string }
): Promise<void> {
  const outcome = await applyWrite(
    path.join(fixture.findingsDir, `${id}.md`),
    updateProgress(patch, '2026-07-31', 'agent')
  );
  if (!outcome.ok) throw new Error(`the agent write was refused as ${outcome.error.code}`);
}

describe('routing', () => {
  it('leaves a non-api path for the app to serve', async () => {
    const { handled } = await call('GET', '/index.html');

    expect(handled).toBe(false);
  });

  it('answers an unknown api path with 404 rather than the app shell', async () => {
    const { handled, res } = await call('GET', '/api/nope');

    expect(handled).toBe(true);
    expect(res.statusCode).toBe(404);
  });

  it('refuses the wrong method on a known route', async () => {
    const { res } = await call('GET', `${AUDIT}/finding/AC-1/rule`);

    expect(res.statusCode).toBe(405);
  });

  it('refuses a post to a read route', async () => {
    const { res } = await call('POST', '/api/audit', {});

    expect(res.statusCode).toBe(405);
  });

  it('refuses a get on the undo route', async () => {
    const { res } = await call('GET', '/api/undo');

    expect(res.statusCode).toBe(405);
  });

  it('answers an unknown action on a real finding with 404', async () => {
    const res = await post('AC-1', 'frobnicate');

    expect(res.statusCode).toBe(404);
  });

  it('reads a request with no method as a GET', async () => {
    const res = fakeResponse();
    const req = fakeRequest('GET', '/api/ping');
    delete (req as { method?: string }).method;

    await router.handle(req, res);

    expect(res.statusCode).toBe(200);
  });

  it('stamps its own timestamp when the caller supplies no clock', async () => {
    const own = createRouter({
      service: createAuditService({ repoRoot: fixture.root, defaultAudit: null }),
      events: hub,
    });
    const res = fakeResponse();

    await own.handle(fakeRequest('POST', `${AUDIT}/finding/AC-1/rule`, { option: 'A' }), res);

    const ruled = (res.json() as { finding: FindingJson }).finding;
    expect(ruled.ruling?.at).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('GET /api/ping', () => {
  it('answers so the client can keep a visible tab alive', async () => {
    const { res } = await call('GET', '/api/ping');

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });
});

describe('GET /api/audit', () => {
  it('returns the audit, the findings, the validation report and the audit list', async () => {
    const { res } = await call('GET', '/api/audit');
    const payload = res.json() as {
      audit: { date: string };
      findings: { id: string }[];
      validation: unknown[];
      audits: string[];
    };

    expect(res.statusCode).toBe(200);
    expect(payload.audit.date).toBe('2026-07-30');
    expect(payload.findings.map((entry) => entry.id)).toEqual(['AC-1', 'AC-2']);
    expect(payload.validation).toEqual([]);
    expect(payload.audits).toEqual(['2026-07-30']);
  });
});

describe('POST /api/audits/:audit/finding/:id/rule', () => {
  it('rules the finding and returns it with an undo token', async () => {
    const res = await post('AC-1', 'rule', { option: 'A', text: 'Do it', note: null });

    expect(res.statusCode).toBe(200);
    expect(finding(res).state).toBe('ruled');
    expect(typeof (res.json() as { undoToken: string }).undoToken).toBe('string');
  });

  it('rejects a body with no option', async () => {
    const res = await post('AC-1', 'rule', { text: 'Do it' });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid');
  });

  it('rejects a body that is not json', async () => {
    const res = fakeResponse();

    await router.handle(rawBody(`${AUDIT}/finding/AC-1/rule`, '{ not json'), res);

    expect(res.statusCode).toBe(400);
  });

  it('reports an unknown finding as 404', async () => {
    const res = await post('NOPE-1', 'rule', { option: 'A' });

    expect(res.statusCode).toBe(404);
  });

  it('decodes an id whose characters were escaped in the url', async () => {
    await fixture.writeFinding('EN-3---EN-20');

    const res = await post(encodeURIComponent('EN-3---EN-20'), 'rule', { option: 'A' });

    expect(res.statusCode).toBe(200);
    expect(finding(res).id).toBe('EN-3---EN-20');
  });
});

describe('POST /api/audits/:audit/finding/:id/deny', () => {
  it('denies the finding as the human', async () => {
    const res = await post('AC-1', 'deny', { reason: 'Not worth it' });

    expect(finding(res).state).toBe('denied');
    expect(finding(res).denial).toMatchObject({ by: 'human', reason: 'Not worth it' });
  });

  it('takes a denial with no reason', async () => {
    const res = await post('AC-1', 'deny');

    expect(finding(res).state).toBe('denied');
  });

  it('rejects a reason that is not text', async () => {
    const res = await post('AC-1', 'deny', { reason: 5 });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/audits/:audit/finding/:id/reopen', () => {
  it('reopens a ruled finding and archives the ruling', async () => {
    await post('AC-1', 'rule', { option: 'A' });

    const res = await post('AC-1', 'reopen');

    expect(finding(res).state).toBe('open');
    expect(finding(res).history).toHaveLength(1);
  });

  it('answers 409 when the finding is not decided', async () => {
    const res = await post('AC-1', 'reopen');

    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: { code: string } }).error.code).toBe('invalid-transition');
  });

  it('rejects a base version that is not text', async () => {
    const res = await post('AC-1', 'reopen', { base: 5 });

    expect(res.statusCode).toBe(400);
  });
});

describe('the question routes', () => {
  it('asks without the write moving the finding', async () => {
    const asked = await post('AC-1', 'ask', { text: 'Is this still true?' });

    expect(finding(asked).state).toBe('open');
    expect(finding(asked).questions).toMatchObject([{ text: 'Is this still true?' }]);
  });

  // Answering is the implementation agent's, and the agent writes through the
  // store rather than over HTTP, so there is nothing here to answer with.
  it('offers no answer route', async () => {
    await post('AC-1', 'ask', { text: 'Is this still true?' });

    const res = await post('AC-1', 'answer', { index: 0, text: 'Yes' });

    expect(res.statusCode).toBe(404);
  });

  it('withdraws a question', async () => {
    await post('AC-1', 'ask', { text: 'Is this still true?' });

    const res = await post('AC-1', 'withdraw', { index: 0 });

    expect(finding(res).state).toBe('open');
    expect(finding(res).questions).toEqual([]);
  });

  it('rejects a question with no text', async () => {
    const res = await post('AC-1', 'ask', { text: '' });

    expect(res.statusCode).toBe(400);
  });

  it('rejects a withdrawal of a negative index', async () => {
    const res = await post('AC-1', 'withdraw', { index: -1 });

    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/audits/:audit/finding/:id/progress', () => {
  it('writes a status the reader chose as the reader’s own act', async () => {
    const res = await post('AC-1', 'progress', { status: 'in-progress', note: 'Started' });

    expect(finding(res).progress).toMatchObject({
      status: 'in-progress',
      notes: [{ by: 'human', text: 'Started' }],
    });
  });

  it('leaves the agent’s last report where it was when the reader moves a status', async () => {
    await post('AC-1', 'rule', { option: 'A' });

    const res = await post('AC-1', 'progress', { status: 'blocked' });

    expect(finding(res).progress.updated).toBeNull();
  });

  it('rejects a progress status outside the enum', async () => {
    const res = await post('AC-1', 'progress', { status: 'nearly' });

    expect(res.statusCode).toBe(400);
  });

  it('attributes a note typed in the console to the human', async () => {
    const res = await post('AC-1', 'progress', { note: 'Checked this myself' });

    expect(finding(res).progress).toMatchObject({
      notes: [{ by: 'human', text: 'Checked this myself' }],
    });
  });

  it('records the human verification', async () => {
    const res = await post('AC-1', 'progress', { verified: true });

    expect(finding(res).progress).toMatchObject({ verified: true });
  });

  it('refuses a status and a verification in one call, because they are different claims', async () => {
    const res = await post('AC-1', 'progress', { status: 'done', verified: true });

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { message: string } }).error.message).toContain(
      'separate calls'
    );
  });
});

describe('POST /api/audits/:audit/finding/:id/unblock', () => {
  async function blockAC1(): Promise<void> {
    await post('AC-1', 'rule', { option: 'A' });
    await agentWrites('AC-1', { status: 'blocked', note: 'the schema change has not landed' });
  }

  it('returns the finding to the work queue with the answer attributed to the human', async () => {
    await blockAC1();

    const res = await post('AC-1', 'unblock', { note: 'Ship it against the current schema.' });

    expect(res.statusCode).toBe(200);
    expect(finding(res).progress.status).toBe('not-started');
    expect(finding(res).progress.notes.at(-1)).toMatchObject({
      by: 'human',
      text: 'Ship it against the current schema.',
    });
  });

  it('leaves the ruling the block was raised against standing', async () => {
    await blockAC1();

    const res = await post('AC-1', 'unblock', { note: 'Ship it against the current schema.' });

    expect(finding(res).state).toBe('ruled');
    expect(finding(res).ruling).toMatchObject({ option: 'A' });
  });

  it('rejects an answer with no text', async () => {
    await blockAC1();

    const res = await post('AC-1', 'unblock', { note: '' });

    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('invalid');
  });

  it('answers 409 when the work is not blocked', async () => {
    await post('AC-1', 'rule', { option: 'A' });

    const res = await post('AC-1', 'unblock', { note: 'Nothing to answer.' });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('invalid-transition');
  });

  it('refuses an answer built on a read taken before a further note landed', async () => {
    await blockAC1();
    const before = await read('AC-1');
    await agentWrites('AC-1', { note: 'and the migration is written now' });

    const res = await post('AC-1', 'unblock', {
      note: 'Ship it against the current schema.',
      base: before.hash,
    });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('conflict');
  });
});

describe('POST /api/audits/:audit/finding/:id/dedicate', () => {
  it('marks a finding for a session of its own', async () => {
    const res = await post('AC-1', 'dedicate', { dedicated: true });

    expect(res.statusCode).toBe(200);
    expect(finding(res).dedicated).toBe(true);
  });

  it('clears a mark', async () => {
    await fixture.writeFinding('AC-9', { dedicated: true });

    const res = await post('AC-9', 'dedicate', { dedicated: false });

    expect(res.statusCode).toBe(200);
    expect(finding(res).dedicated).toBe(false);
  });

  it('leaves the ruling and the state where they were', async () => {
    await post('AC-1', 'rule', { option: 'A' });

    const res = await post('AC-1', 'dedicate', { dedicated: true });

    expect(finding(res).state).toBe('ruled');
    expect(finding(res).ruling?.option).toBe('A');
  });

  it('rejects a body that names no mark', async () => {
    const res = await post('AC-1', 'dedicate', {});

    expect(res.statusCode).toBe(400);
    expect(errorCode(res)).toBe('invalid');
  });

  it('refuses a mark built on a read taken before the mark moved', async () => {
    const before = await read('AC-1');
    await post('AC-1', 'dedicate', { dedicated: true });

    const res = await post('AC-1', 'dedicate', { dedicated: false, base: before.hash });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('conflict');
  });

  it('is undone by the same token every other write mints', async () => {
    const marked = await post('AC-1', 'dedicate', { dedicated: true });
    const { undoToken } = marked.json() as { undoToken: string };

    const { res } = await call('POST', '/api/undo', { token: undoToken });

    expect(res.statusCode).toBe(200);
    expect(finding(res).dedicated).toBe(false);
  });
});

/**
 * The mark rides the write that decided it, and only that write. A ruling or an
 * unblock that carries no mark has to fence exactly the fields it fenced before
 * the mark existed, or every ordinary decision would start refusing over a mark
 * nobody was arguing about.
 */
describe('a mark carried on the write that decided it', () => {
  async function markOutOfBand(id: string): Promise<void> {
    const outcome = await applyWrite(
      path.join(fixture.findingsDir, `${id}.md`),
      patchWrite('human', { dedicated: true })
    );
    if (!outcome.ok) throw new Error(`the mark was refused as ${outcome.error.code}`);
  }

  it('rules and marks in one write', async () => {
    const res = await post('AC-1', 'rule', { option: 'A', dedicated: true });

    expect(res.statusCode).toBe(200);
    expect(finding(res).state).toBe('ruled');
    expect(finding(res).dedicated).toBe(true);
  });

  it('takes a ruling that names no mark against a read from before one landed', async () => {
    const before = await read('AC-1');
    await markOutOfBand('AC-1');

    const res = await post('AC-1', 'rule', { option: 'A', base: before.hash });

    expect(res.statusCode).toBe(200);
  });

  it('refuses a ruling that names the mark against that same read', async () => {
    const before = await read('AC-1');
    await markOutOfBand('AC-1');

    const res = await post('AC-1', 'rule', { option: 'A', dedicated: false, base: before.hash });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('conflict');
  });

  it('answers a block and marks in one write', async () => {
    await post('AC-1', 'rule', { option: 'A' });
    await agentWrites('AC-1', { status: 'blocked', note: 'this is bigger than the task' });

    const res = await post('AC-1', 'unblock', {
      note: 'Agreed, it needs a session.',
      dedicated: true,
    });

    expect(res.statusCode).toBe(200);
    expect(finding(res).dedicated).toBe(true);
    expect(finding(res).progress.status).toBe('not-started');
  });

  it('marks nothing when the decision it rode on was refused', async () => {
    const res = await post('AC-1', 'unblock', { note: 'Carry on.', dedicated: true });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('invalid-transition');
    const after = await read('AC-1');
    expect(after.dedicated).toBe(false);
  });

  it('takes an unblock that names no mark against a read from before one landed', async () => {
    await post('AC-1', 'rule', { option: 'A' });
    await agentWrites('AC-1', { status: 'blocked', note: 'this is bigger than the task' });
    const before = await read('AC-1');
    await markOutOfBand('AC-1');

    const res = await post('AC-1', 'unblock', { note: 'Carry on.', base: before.hash });

    expect(res.statusCode).toBe(200);
  });

  it('refuses an unblock that names the mark against that same read', async () => {
    await post('AC-1', 'rule', { option: 'A' });
    await agentWrites('AC-1', { status: 'blocked', note: 'this is bigger than the task' });
    const before = await read('AC-1');
    await markOutOfBand('AC-1');

    const res = await post('AC-1', 'unblock', {
      note: 'Carry on.',
      dedicated: false,
      base: before.hash,
    });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('conflict');
  });
});

describe('the actions the registry declares', () => {
  it('each have a route', async () => {
    for (const action of Object.keys(FINDING_ACTIONS)) {
      const res = await post('AC-1', action);

      expect(res.statusCode, action).not.toBe(404);
    }
  });
});

describe('a finding’s severity, status and area', () => {
  /**
   * The audit's own words, and nothing in the console or the CLI offers to
   * change them, so the route that once could is not served.
   */
  it('are not writable over the api', async () => {
    const res = await post('AC-1', 'meta', { severity: 'high' });

    expect(res.statusCode).toBe(404);
  });
});

describe('the version a write was built on', () => {
  it('refuses a status built from a read taken before an agent blocked the finding', async () => {
    await post('AC-1', 'rule', { option: 'A' });
    const before = await read('AC-1');
    await agentWrites('AC-1', { status: 'blocked', note: 'the schema change has not landed' });

    const res = await post('AC-1', 'progress', { status: 'in-progress', base: before.hash });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('conflict');
    const after = await read('AC-1');
    expect(after.progress.status).toBe('blocked');
  });

  it('refuses a write naming a version it never served', async () => {
    const res = await post('AC-1', 'rule', { option: 'A', base: 'a-version-nobody-served' });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('conflict');
  });

  /**
   * The property the whole design turns on. An agent's note names
   * `progress.notes`; a ruling names `state` and `ruling`, and the two progress
   * fields it resets only when there is work standing against the decision it
   * replaces. So a note and a ruling name nothing in common and must not be told
   * they raced, while a status the agent moved is a real overlap the same fence
   * refuses. A guard over the whole finding rather than the fields each write
   * names would refuse both.
   */
  it('takes a write whose fields an agent left alone, however much else moved', async () => {
    const before = await read('AC-1');
    await agentWrites('AC-1', { note: 'started on it' });

    const res = await post('AC-1', 'rule', { option: 'A', base: before.hash });

    expect(res.statusCode).toBe(200);
    expect(finding(res).state).toBe('ruled');
    expect(finding(res).progress.notes).toHaveLength(1);
  });

  it('refuses a ruling built on a read taken before the agent moved the status it resets', async () => {
    const before = await read('AC-1');
    await agentWrites('AC-1', { status: 'in-progress', note: 'started on it' });

    const res = await post('AC-1', 'rule', { option: 'A', base: before.hash });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('conflict');
  });

  it('still resolves a version two writes back', async () => {
    const before = await read('AC-1');
    await post('AC-1', 'progress', { note: 'one' });
    await post('AC-1', 'progress', { note: 'two' });

    const res = await post('AC-1', 'rule', { option: 'A', base: before.hash });

    expect(res.statusCode).toBe(200);
  });

  it('refuses a version older than the versions it keeps', async () => {
    const before = await read('AC-1');
    await post('AC-1', 'progress', { note: 'one' });
    await post('AC-1', 'progress', { note: 'two' });
    await post('AC-1', 'progress', { note: 'three' });

    const res = await post('AC-1', 'rule', { option: 'A', base: before.hash });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('conflict');
  });

  it('keeps one finding’s versions however many writes another finding takes', async () => {
    const before = await read('AC-1');
    for (const text of ['one', 'two', 'three', 'four', 'five']) {
      await post('AC-2', 'progress', { note: text });
    }

    const res = await post('AC-1', 'rule', { option: 'A', base: before.hash });

    expect(res.statusCode).toBe(200);
  });

  it('reports the store’s own refusal when the write already fails against that version', async () => {
    const before = await read('AC-1');

    const res = await post('AC-1', 'reopen', { base: before.hash });

    expect(res.statusCode).toBe(409);
    expect(errorCode(res)).toBe('invalid-transition');
  });

  it('takes a write that names no version at all', async () => {
    const res = await post('AC-1', 'rule', { option: 'A' });

    expect(res.statusCode).toBe(200);
  });
});

describe('POST /api/undo', () => {
  it('puts the previous bytes back', async () => {
    const ruled = await post('AC-1', 'rule', { option: 'A' });
    const { undoToken } = ruled.json() as { undoToken: string };

    const { res } = await call('POST', '/api/undo', { token: undoToken });

    expect(res.statusCode).toBe(200);
    expect(finding(res).state).toBe('open');
  });

  it('answers 404 for a token it does not hold', async () => {
    const { res } = await call('POST', '/api/undo', { token: 'made-up' });

    expect(res.statusCode).toBe(404);
  });

  it('rejects an undo body that is not json', async () => {
    const res = fakeResponse();

    await router.handle(rawBody('/api/undo', '{ not json'), res);

    expect(res.statusCode).toBe(400);
  });

  it('rejects a body with no token', async () => {
    const { res } = await call('POST', '/api/undo', {});

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/audits/:audit/source', () => {
  it('returns the window around a cited line', async () => {
    const { res } = await call('GET', `${AUDIT}/source?path=src/inside.ts&start=2`);
    const window = res.json() as { lines: string[]; exists: boolean };

    expect(res.statusCode).toBe(200);
    expect(window.exists).toBe(true);
    expect(window.lines.slice(0, 3)).toEqual(['one', 'two', 'three']);
  });

  it('reads a range', async () => {
    const { res } = await call('GET', `${AUDIT}/source?path=src/inside.ts&start=1&end=2`);

    expect((res.json() as { requestedEnd: number }).requestedEnd).toBe(2);
  });

  it('reports a missing file rather than failing', async () => {
    const { res } = await call('GET', `${AUDIT}/source?path=src/gone.ts&start=1`);

    expect(res.statusCode).toBe(200);
    expect((res.json() as { exists: boolean }).exists).toBe(false);
  });

  it('refuses a path outside the repository', async () => {
    const { res } = await call('GET', `${AUDIT}/source?path=../../etc/passwd&start=1`);

    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: { code: string } }).error.code).toBe('outside-root');
  });

  it('rejects a request with no path', async () => {
    const { res } = await call('GET', `${AUDIT}/source?start=1`);

    expect(res.statusCode).toBe(400);
  });

  it('rejects a start line that is not a number', async () => {
    const { res } = await call('GET', `${AUDIT}/source?path=src/inside.ts&start=first`);

    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/audits/:audit/brief', () => {
  it('emits exactly what the CLI emits for the same findings', async () => {
    const lines: string[] = [];
    await runList(
      {
        kind: 'list',
        audit: null,
        brief: true,
        contest: false,
        id: null,
        state: null,
        section: null,
        area: null,
        severity: null,
        progress: null,
      },
      {
        repoRoot: fixture.root,
        out: (line) => lines.push(line),
        err: () => {
          throw new Error('the list command should not have written to stderr');
        },
      }
    );

    const { res } = await call('GET', `${AUDIT}/brief?ids=AC-1,AC-2`);

    expect(res.statusCode).toBe(200);
    expect((res.json() as { text: string }).text).toBe(lines.join('\n'));
  });

  it('emits the briefs in the order the caller asked for', async () => {
    const { res } = await call('GET', `${AUDIT}/brief?ids=AC-2,AC-1`);
    const { text } = res.json() as { text: string };

    expect(text.indexOf('AC-2')).toBeLessThan(text.indexOf('AC-1'));
  });

  it('emits one brief with no separator', async () => {
    const { res } = await call('GET', `${AUDIT}/brief?ids=AC-1`);

    expect((res.json() as { text: string }).text).not.toContain('\n---\n');
  });

  it('reads an id that needed encoding', async () => {
    await fixture.writeFinding('UI-8-CLEAN');
    const { res } = await call('GET', `${AUDIT}/brief?ids=${encodeURIComponent('UI-8-CLEAN')}`);

    expect(res.statusCode).toBe(200);
    expect((res.json() as { text: string }).text).toContain('UI-8-CLEAN');
  });

  it('rejects a request naming no findings', async () => {
    const { res } = await call('GET', `${AUDIT}/brief`);

    expect(res.statusCode).toBe(400);
  });

  it('rejects an ids parameter that is only separators', async () => {
    const { res } = await call('GET', `${AUDIT}/brief?ids=,,`);

    expect(res.statusCode).toBe(400);
  });

  it('names the finding it could not find rather than answering a partial brief', async () => {
    const { res } = await call('GET', `${AUDIT}/brief?ids=AC-1,NOPE-9`);

    expect(res.statusCode).toBe(404);
    expect((res.json() as { error: { message: string } }).error.message).toContain('NOPE-9');
  });

  it('refuses a method other than GET', async () => {
    const { res } = await call('POST', `${AUDIT}/brief?ids=AC-1`);

    expect(res.statusCode).toBe(405);
  });
});

/**
 * A router that holds its event stream where the audit directory is resolved,
 * which is the only await between a client arriving and its subscription
 * existing.
 */
function slowToResolveItsDirectory(): {
  readonly router: Router;
  readonly reached: Promise<(auditDir: string) => void>;
} {
  const service = createAuditService({ repoRoot: fixture.root, defaultAudit: null });
  let announce!: (arrive: (auditDir: string) => void) => void;
  const reached = new Promise<(auditDir: string) => void>((resolve) => {
    announce = resolve;
  });
  const auditDir: AuditService['auditDir'] = () =>
    new Promise<string>((resolve) => {
      announce(resolve);
    });
  return { router: createRouter({ service: { ...service, auditDir }, events: hub }), reached };
}

describe('GET /api/audits/:audit/events', () => {
  it('opens an event stream and forwards what the watcher saw', async () => {
    const res = fakeResponse();
    const req = fakeRequest('GET', `${AUDIT}/events`);
    await router.handle(req, res);

    watchers.send(auditDirOf(FIXTURE_AUDIT_DATE), { type: 'finding', id: 'AC-1' });

    expect(res.headers['Content-Type']).toBe('text/event-stream');
    expect(res.body()).toContain('data: {"type":"finding","id":"AC-1"}');
    req.close();
  });

  it('unsubscribes when the client goes away', async () => {
    const res = fakeResponse();
    const req = fakeRequest('GET', `${AUDIT}/events`);
    await router.handle(req, res);

    req.close();
    const before = res.body();
    watchers.send(auditDirOf(FIXTURE_AUDIT_DATE), { type: 'finding', id: 'AC-1' });

    expect(res.body()).toBe(before);
  });

  it('watches nothing until a stream asks for it', async () => {
    expect(watchers.opened).toEqual([]);

    const req = fakeRequest('GET', `${AUDIT}/events`);
    await router.handle(req, fakeResponse());

    expect(watchers.opened).toEqual([auditDirOf(FIXTURE_AUDIT_DATE)]);
    req.close();
  });

  it('watches an audit that appeared after the console had started', async () => {
    await plantSecondAudit('2099-01-01');

    const req = fakeRequest('GET', '/api/audits/2099-01-01/events');
    await router.handle(req, fakeResponse());

    expect(watchers.opened).toEqual([auditDirOf('2099-01-01')]);
    req.close();
  });

  it('sends a stream only the events of the audit its path named', async () => {
    await plantSecondAudit();
    const here = fakeResponse();
    const elsewhere = fakeResponse();
    const first = fakeRequest('GET', `${AUDIT}/events`);
    const second = fakeRequest('GET', '/api/audits/2026-01-01/events');
    await router.handle(first, here);
    await router.handle(second, elsewhere);

    watchers.send(auditDirOf(FIXTURE_AUDIT_DATE), { type: 'finding', id: 'AC-1' });

    expect(here.body()).toContain('"id":"AC-1"');
    expect(elsewhere.body()).not.toContain('AC-1');
    first.close();
    second.close();
  });

  it('keeps watching an audit a second stream is still reading', async () => {
    const first = fakeRequest('GET', `${AUDIT}/events`);
    const second = fakeRequest('GET', `${AUDIT}/events`);
    await router.handle(first, fakeResponse());
    await router.handle(second, fakeResponse());

    first.close();

    expect(watchers.opened).toEqual([auditDirOf(FIXTURE_AUDIT_DATE)]);
    expect(watchers.closed).toEqual([]);
    second.close();
  });

  it('closes the watcher when the last stream on that audit ends', async () => {
    const first = fakeRequest('GET', `${AUDIT}/events`);
    const second = fakeRequest('GET', `${AUDIT}/events`);
    await router.handle(first, fakeResponse());
    await router.handle(second, fakeResponse());

    first.close();
    second.close();

    expect(watchers.closed).toEqual([auditDirOf(FIXTURE_AUDIT_DATE)]);
  });

  /**
   * The subscription is the only thing holding the watcher open, so a client
   * that gives up while the console is still resolving its directory has to
   * release the watcher its arrival opened.
   */
  it('releases the watcher when the client goes away mid-open', async () => {
    const slow = slowToResolveItsDirectory();
    const req = fakeRequest('GET', `${AUDIT}/events`);
    const handled = slow.router.handle(req, fakeResponse());
    const arrive = await slow.reached;

    req.close();
    arrive(auditDirOf(FIXTURE_AUDIT_DATE));
    await handled;

    expect(watchers.closed).toEqual([auditDirOf(FIXTURE_AUDIT_DATE)]);
  });

  it('releases the watcher for a connection that was already gone', async () => {
    const req = fakeRequest('GET', `${AUDIT}/events`);
    req.destroy();

    await router.handle(req, fakeResponse());

    expect(watchers.closed).toEqual([auditDirOf(FIXTURE_AUDIT_DATE)]);
  });
});

describe('a refusal from the store', () => {
  it('answers a held lock with 503 and a retryable flag, never a hard failure', async () => {
    const release = await holdFindingLock(path.join(fixture.findingsDir, 'AC-1.md'));

    const res = await post('AC-1', 'rule', { option: 'A' });

    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: 'locked', retryable: true } });
    await release();
  }, 20_000);
});

describe('the copy a refusal carries', () => {
  const lockPath = '/srv/hushbox/docs/audits/2026-07-30/findings/AC-1.md.lock';

  /**
   * A held lock costs the store's five-second wait to reach for real, and the
   * message under test is the one the store hands back rather than anything the
   * files decide, so the refusal is handed to the router directly.
   */
  function routerRefusing(refusal: { code: ServiceErrorCode; message: string }): Router {
    const service = createAuditService({ repoRoot: fixture.root, defaultAudit: null });
    const write: AuditService['write'] = () => Promise.resolve({ ok: false, error: refusal });
    return createRouter({ service: { ...service, write }, events: hub });
  }

  async function refused(refusal: { code: ServiceErrorCode; message: string }): Promise<string> {
    const res = fakeResponse();
    await routerRefusing(refusal).handle(
      fakeRequest('POST', `${AUDIT}/finding/AC-1/rule`, { option: 'A' }),
      res
    );
    return (res.json() as { error: { message: string } }).error.message;
  }

  it('keeps the store internal detail out of what the reader is shown', async () => {
    const message = await refused({
      code: 'locked',
      message: `${lockPath} is held by another writer`,
    });

    expect(message).not.toContain(lockPath);
  });

  it('says a refused write saved nothing', async () => {
    const message = await refused({
      code: 'locked',
      message: `${lockPath} is held by another writer`,
    });

    expect(message).toBe(
      'Nothing was saved. Another writer holds this file, so try again in a moment.'
    );
  });

  it('says a refused undo restored nothing', async () => {
    const { res } = await call('POST', '/api/undo', { token: 'made-up' });

    expect((res.json() as { error: { message: string } }).error.message).toBe(
      'Nothing was restored. That undo is spent or unknown.'
    );
  });
});

/**
 * An audit the console does not serve, planted one level above the audits root
 * so an escaping name has something real to reach. It holds an `audit.md`, so
 * only the allowlist keeps it unreadable.
 */
async function plantAuditAboveTheRoot(): Promise<void> {
  const dir = path.join(fixture.root, 'docs', 'outside');
  await fs.mkdir(path.join(dir, 'findings'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'audit.md'),
    FIXTURE_AUDIT_HEADER.replace(FIXTURE_AUDIT_DATE, '2026-02-02')
  );
}

async function plantSecondAudit(name = '2026-01-01'): Promise<void> {
  const dir = path.join(fixture.root, 'docs', 'audits', name);
  await fs.mkdir(path.join(dir, 'findings'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'audit.md'),
    FIXTURE_AUDIT_HEADER.replace(FIXTURE_AUDIT_DATE, name)
  );
  await fs.writeFile(path.join(dir, 'findings', 'ZZ-1.md'), findingFile('ZZ-1'));
}

describe('an addressed audit', () => {
  it('serves the snapshot of the audit the path names', async () => {
    await plantSecondAudit();

    const { res } = await call('GET', '/api/audits/2026-01-01/audit');
    const payload = res.json() as { name: string; findings: { id: string }[] };

    expect(res.statusCode).toBe(200);
    expect(payload.name).toBe('2026-01-01');
    expect(payload.findings.map((entry) => entry.id)).toEqual(['ZZ-1']);
  });

  it('briefs a finding that exists only in the audit the path names', async () => {
    await plantSecondAudit();

    const { res } = await call('GET', '/api/audits/2026-01-01/brief?ids=ZZ-1');

    expect(res.statusCode).toBe(200);
  });

  it('writes to a finding that exists only in the audit the path names', async () => {
    await plantSecondAudit();

    const { res } = await call('POST', '/api/audits/2026-01-01/finding/ZZ-1/rule', {
      option: 'A',
      text: null,
      note: null,
    });

    expect(res.statusCode).toBe(200);
    expect(finding(res).state).toBe('ruled');
  });

  it('dates a source window from the audit the path names', async () => {
    // Staleness is the observable that tells the audits apart: the planted one
    // postdates the fixture file, and being newer it is also what a window
    // resolved from the default would be dated from.
    await plantSecondAudit('2099-01-01');

    const { res } = await call(
      'GET',
      `/api/audits/${FIXTURE_AUDIT_DATE}/source?path=src/inside.ts&start=2`
    );

    expect(res.statusCode).toBe(200);
    expect((res.json() as { stale: boolean }).stale).toBe(true);
  });

  it('opens an event stream under the audit the path names', async () => {
    const res = fakeResponse();
    const req = fakeRequest('GET', `/api/audits/${FIXTURE_AUDIT_DATE}/events`);

    await router.handle(req, res);

    expect(res.statusCode).toBe(200);
    expect(res.chunks[0]).toBe(': connected\n\n');
  });
});

describe('an audit name this console does not serve', () => {
  it('refuses a well-formed name with no audit behind it', async () => {
    const { res } = await call('GET', '/api/audits/2026-12-31/audit');

    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('not-found');
  });

  it('refuses a name that escapes the audits root through an encoded separator', async () => {
    await plantAuditAboveTheRoot();

    const { res } = await call('GET', '/api/audits/..%2Foutside/audit');

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ error: { code: 'not-found' } });
  });

  it('refuses a climb out of the repository altogether', async () => {
    const { res } = await call('GET', '/api/audits/..%2F..%2Fetc/audit');

    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('not-found');
  });

  it('refuses a dated directory that holds no audit file', async () => {
    await fs.mkdir(path.join(fixture.root, 'docs', 'audits', '2026-03-03'), { recursive: true });

    const { res } = await call('GET', '/api/audits/2026-03-03/audit');

    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('not-found');
  });

  it('refuses a name whose escapes decode to nothing at all', async () => {
    const { res } = await call('GET', '/api/audits/%E0%A4%A/audit');

    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('not-found');
  });

  it('refuses a write addressed to it, leaving the finding where it was', async () => {
    const { res } = await call('POST', '/api/audits/..%2Foutside/finding/AC-1/rule', {
      option: 'A',
      text: null,
      note: null,
    });

    const untouched = await read('AC-1');
    expect(res.statusCode).toBe(404);
    expect(untouched.state).toBe('open');
  });

  it('refuses an unknown read under an audit it does serve', async () => {
    const { res } = await call('GET', `${AUDIT}/nope`);

    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('not-found');
  });

  it('refuses a sub-route named after a property every object inherits', async () => {
    const { res } = await call('GET', `${AUDIT}/constructor`);

    expect(res.statusCode).toBe(404);
    expect(errorCode(res)).toBe('not-found');
  });
});
