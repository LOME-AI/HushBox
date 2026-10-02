import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  applyWrite,
  patchWrite,
  reopenFinding,
  ruleFinding,
  updateProgress,
} from '@hushbox/docket';
import {
  createAuditFixture,
  FIXTURE_AUDIT_DATE,
  FIXTURE_AUDIT_HEADER,
  findingFile,
  type AuditFixture,
} from '../test-utils/audit-fixture';
import { holdFindingLock } from '../test-utils/hold-lock';
import { createAuditService } from './audit-service';

const AUDIT_DATE = FIXTURE_AUDIT_DATE;

let fixture: AuditFixture;
let root: string;
let findingsDir: string;

beforeEach(async () => {
  fixture = await createAuditFixture();
  root = fixture.root;
  findingsDir = fixture.findingsDir;
});

afterEach(async () => {
  await fixture.cleanup();
});

function service(defaultAudit: string | null = null): ReturnType<typeof createAuditService> {
  return createAuditService({ repoRoot: root, defaultAudit });
}

describe('snapshot', () => {
  it('returns the audit header, every finding as json and the audit list', async () => {
    const snapshot = await service().snapshot();

    expect(snapshot.audit.date).toBe(AUDIT_DATE);
    expect(snapshot.name).toBe(AUDIT_DATE);
    expect(snapshot.findings.map((finding) => finding.id)).toEqual(['AC-1', 'AC-2']);
    expect(snapshot.audits).toEqual([AUDIT_DATE]);
  });

  it('renders the body to html with citations annotated', async () => {
    const snapshot = await service().snapshot();
    const [first] = snapshot.findings;

    expect(first?.bodyHtml).toContain('<p>');
    expect(first?.bodyHtml).toContain('data-citation');
  });

  it('keeps a malformed finding out of the list and in the validation report', async () => {
    await fs.writeFile(path.join(findingsDir, 'BROKEN.md'), 'no frontmatter here');

    const snapshot = await service().snapshot();

    expect(snapshot.findings.map((finding) => finding.id)).toEqual(['AC-1', 'AC-2']);
    expect(snapshot.validation.map((entry) => entry.id)).toEqual(['BROKEN']);
  });

  it('serves an unchanged finding from the render cache', async () => {
    const shared = service();

    const first = await shared.snapshot();
    const second = await shared.snapshot();

    expect(second.findings[0]).toBe(first.findings[0]);
  });

  it('re-renders a finding whose bytes changed', async () => {
    const shared = service();
    await shared.snapshot();

    await fs.writeFile(
      path.join(findingsDir, 'AC-1.md'),
      findingFile('AC-1', { title: 'Renamed' })
    );

    const reloaded = await shared.snapshot();
    expect(reloaded.findings[0]?.title).toBe('Renamed');
  });

  it('honors the default audit it is given', async () => {
    const older = path.join(root, 'docs', 'audits', '2026-01-01');
    await fs.mkdir(path.join(older, 'findings'), { recursive: true });
    await fs.writeFile(
      path.join(older, 'audit.md'),
      FIXTURE_AUDIT_HEADER.replace(AUDIT_DATE, '2026-01-01')
    );

    const served = await service('2026-01-01').snapshot();
    expect(served.name).toBe('2026-01-01');
  });
});

describe('write', () => {
  it('applies the transition and returns the updated finding', async () => {
    const outcome = await service().write(
      'AC-1',
      ruleFinding({ option: 'A', text: null, note: null }, AUDIT_DATE)
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.finding.state).toBe('ruled');
    expect(outcome.value.finding.ruling?.option).toBe('A');
  });

  it('reports an unknown id rather than writing anything', async () => {
    const outcome = await service().write(
      'NOPE-9',
      ruleFinding({ option: 'A', text: null, note: null }, AUDIT_DATE)
    );

    expect(outcome).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'no finding "NOPE-9" in this audit' },
    });
  });

  it('surfaces a refused transition with the store code intact', async () => {
    const outcome = await service().write('AC-1', reopenFinding(AUDIT_DATE));

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('invalid-transition');
  });

  it('refuses a write built on a version it never served', async () => {
    const shared = service();
    const transition = ruleFinding({ option: 'A', text: null, note: null }, AUDIT_DATE);
    await shared.write('AC-1', transition);

    const outcome = await shared.write('AC-1', transition, 'a-version-nobody-served');

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('conflict');
  });

  it('refuses a write whose own fields moved under it', async () => {
    const shared = service();
    const snapshot = await shared.snapshot();
    const base = snapshot.findings[0]?.hash ?? '';
    // Ruled by someone else, on the very fields a second ruling names.
    await shared.write('AC-1', ruleFinding({ option: 'B', text: null, note: null }, AUDIT_DATE));

    const outcome = await shared.write(
      'AC-1',
      ruleFinding({ option: 'A', text: null, note: null }, AUDIT_DATE),
      base
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('conflict');
  });

  it('takes a write built on a version the fields it names have not moved since', async () => {
    const shared = service();
    const snapshot = await shared.snapshot();
    const base = snapshot.findings[0]?.hash ?? '';
    // A note is the agent write that shares no field with a ruling: the status
    // a ruling resets is the one it would.
    await shared.write(
      'AC-1',
      patchWrite('agent', {
        progress: { notes: [{ at: AUDIT_DATE, by: 'agent', text: 'Reproduced.' }] },
      })
    );

    const outcome = await shared.write(
      'AC-1',
      ruleFinding({ option: 'A', text: null, note: null }, AUDIT_DATE),
      base
    );

    expect(outcome.ok).toBe(true);
  });

  it('refuses a write built on a version the status it resets has moved since', async () => {
    const shared = service();
    const snapshot = await shared.snapshot();
    const base = snapshot.findings[0]?.hash ?? '';
    await shared.write('AC-1', patchWrite('agent', { progress: { status: 'in-progress' } }));

    const outcome = await shared.write(
      'AC-1',
      ruleFinding({ option: 'A', text: null, note: null }, AUDIT_DATE),
      base
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error.code).toBe('conflict');
  });
});

describe('undo', () => {
  it('puts the previous bytes back', async () => {
    const shared = service();
    const written = await shared.write(
      'AC-1',
      ruleFinding({ option: 'A', text: null, note: null }, AUDIT_DATE)
    );
    if (!written.ok) throw new Error('expected the write to land');

    const undone = await shared.undo(written.value.undoToken);

    expect(undone.ok).toBe(true);
    if (!undone.ok) return;
    expect(undone.value.finding.state).toBe('open');
    expect(undone.value.finding.ruling).toBeNull();
  });

  it('mints a fresh token so an undo can itself be undone', async () => {
    const shared = service();
    const written = await shared.write(
      'AC-1',
      ruleFinding({ option: 'A', text: null, note: null }, AUDIT_DATE)
    );
    if (!written.ok) throw new Error('expected the write to land');
    const undone = await shared.undo(written.value.undoToken);
    if (!undone.ok) throw new Error('expected the undo to land');

    const redone = await shared.undo(undone.value.undoToken);

    expect(redone.ok).toBe(true);
    if (!redone.ok) return;
    expect(redone.value.finding.state).toBe('ruled');
  });

  it('spends a token once', async () => {
    const shared = service();
    const written = await shared.write(
      'AC-1',
      patchWrite('agent', { progress: { status: 'done' } })
    );
    if (!written.ok) throw new Error('expected the write to land');
    await shared.undo(written.value.undoToken);

    const replay = await shared.undo(written.value.undoToken);

    expect(replay).toEqual({
      ok: false,
      error: { code: 'not-found', message: 'that undo token is spent or unknown' },
    });
  });

  it('forgets the oldest token once the undo history is full', async () => {
    const shared = createAuditService({ repoRoot: root, defaultAudit: null, maxUndoTokens: 1 });
    const first = await shared.write('AC-1', patchWrite('agent', { progress: { status: 'done' } }));
    if (!first.ok) throw new Error('expected the write to land');
    await shared.write('AC-2', patchWrite('agent', { progress: { status: 'done' } }));

    const replay = await shared.undo(first.value.undoToken);

    expect(replay.ok).toBe(false);
  });

  it('reports a finding that vanished between the write and the undo', async () => {
    const shared = service();
    const written = await shared.write(
      'AC-1',
      patchWrite('agent', { progress: { status: 'done' } })
    );
    if (!written.ok) throw new Error('expected the write to land');
    await fs.rm(path.join(findingsDir, 'AC-1.md'));

    const undone = await shared.undo(written.value.undoToken);

    expect(undone.ok).toBe(false);
    if (undone.ok) return;
    expect(undone.error.code).toBe('unreadable');
  });

  it('reports an unknown token', async () => {
    const outcome = await service().undo('made-up');

    expect(outcome.ok).toBe(false);
  });

  it('refuses an undo whose finding moved after the write, keeping the note that moved it', async () => {
    const shared = service();
    const written = await shared.write(
      'AC-1',
      ruleFinding({ option: 'A', text: null, note: null }, AUDIT_DATE)
    );
    if (!written.ok) throw new Error('expected the write to land');
    const noted = await applyWrite(
      path.join(findingsDir, 'AC-1.md'),
      updateProgress({ note: 'started on it' }, AUDIT_DATE, 'agent')
    );
    if (!noted.ok) throw new Error('expected the note to land');

    const undone = await shared.undo(written.value.undoToken);

    expect(undone.ok).toBe(false);
    if (undone.ok) return;
    expect(undone.error.code).toBe('conflict');
    const after = await fs.readFile(path.join(findingsDir, 'AC-1.md'), 'utf8');
    expect(after).toContain('started on it');
  });

  it('spends the token when the finding moved, because that undo is no longer safe', async () => {
    const shared = service();
    const written = await shared.write(
      'AC-1',
      ruleFinding({ option: 'A', text: null, note: null }, AUDIT_DATE)
    );
    if (!written.ok) throw new Error('expected the write to land');
    const noted = await applyWrite(
      path.join(findingsDir, 'AC-1.md'),
      updateProgress({ note: 'started on it' }, AUDIT_DATE, 'agent')
    );
    if (!noted.ok) throw new Error('expected the note to land');
    await shared.undo(written.value.undoToken);

    const retried = await shared.undo(written.value.undoToken);

    expect(retried).toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('keeps the token when a held lock refuses the attempt', async () => {
    const shared = service();
    const written = await shared.write(
      'AC-1',
      ruleFinding({ option: 'A', text: null, note: null }, AUDIT_DATE)
    );
    if (!written.ok) throw new Error('expected the write to land');
    const file = path.join(findingsDir, 'AC-1.md');
    const release = await holdFindingLock(file);

    // Only the clock is faked, so the undo really does retry against a lock
    // another writer holds; moving the clock past the wait budget is what ends
    // it.
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    const pending = shared.undo(written.value.undoToken);
    await new Promise((resolve) => setTimeout(resolve, 50));
    vi.setSystemTime(start + 10_000);
    const refused = await pending;
    vi.useRealTimers();
    expect(refused).toMatchObject({ ok: false, error: { code: 'locked' } });

    await release();
    const retried = await shared.undo(written.value.undoToken);

    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.finding.state).toBe('open');
  });
});

describe('source', () => {
  it('reads a window around the cited line', async () => {
    const outcome = await service().source({ path: 'src/inside.ts', start: 2 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.lines.slice(0, 3)).toEqual(['one', 'two', 'three']);
  });

  it('refuses a path outside the repository', async () => {
    const outcome = await service().source({ path: '../secrets.txt', start: 1 });

    expect(outcome).toEqual({ ok: false, error: 'outside-root' });
  });

  it('dates staleness from the audit being served', async () => {
    const outcome = await service().source({ path: 'src/inside.ts', start: 1 });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stale).toBe(true);
  });
});

describe('auditDir', () => {
  it('resolves the directory the watcher has to watch', async () => {
    expect(await service().auditDir()).toBe(path.join(root, 'docs', 'audits', AUDIT_DATE));
  });

  it('resolves the directory of the audit it is given', async () => {
    await writeSecondAudit('2026-01-01');

    expect(await service().auditDir('2026-01-01')).toBe(
      path.join(root, 'docs', 'audits', '2026-01-01')
    );
  });
});

/** A second audit on disk, so a named one can be told from the default. */
async function writeSecondAudit(name: string, ids: readonly string[] = []): Promise<string> {
  const dir = path.join(root, 'docs', 'audits', name);
  await fs.mkdir(path.join(dir, 'findings'), { recursive: true });
  await fs.writeFile(path.join(dir, 'audit.md'), FIXTURE_AUDIT_HEADER.replace(AUDIT_DATE, name));
  for (const id of ids) {
    await fs.writeFile(path.join(dir, 'findings', `${id}.md`), findingFile(id));
  }
  return dir;
}

describe('auditNames', () => {
  it('lists the dated audits holding an audit file, newest first', async () => {
    const older = path.join(root, 'docs', 'audits', '2026-01-01');
    await fs.mkdir(older, { recursive: true });
    await fs.writeFile(
      path.join(older, 'audit.md'),
      FIXTURE_AUDIT_HEADER.replace(AUDIT_DATE, '2026-01-01')
    );
    await fs.mkdir(path.join(root, 'docs', 'audits', 'scratch-notes'), { recursive: true });

    expect(await service().auditNames()).toEqual([AUDIT_DATE, '2026-01-01']);
  });
});

describe('resolving the audit per call', () => {
  it('snapshots the audit the caller names rather than the default', async () => {
    await writeSecondAudit('2026-01-01', ['ZZ-1']);

    const named = await service().snapshot('2026-01-01');

    expect(named.name).toBe('2026-01-01');
    expect(named.findings.map((entry) => entry.id)).toEqual(['ZZ-1']);
  });

  it('briefs the finding in the audit the caller names', async () => {
    await writeSecondAudit('2026-01-01', ['ZZ-1']);

    const outcome = await service().brief(['ZZ-1'], '2026-01-01');

    expect(outcome.ok).toBe(true);
  });

  it('writes into the audit the caller names', async () => {
    const dir = await writeSecondAudit('2026-01-01', ['ZZ-1']);

    const outcome = await service().write(
      'ZZ-1',
      ruleFinding({ option: 'A', text: null, note: null }, AUDIT_DATE),
      undefined,
      '2026-01-01'
    );

    expect(outcome.ok).toBe(true);
    expect(await fs.readFile(path.join(dir, 'findings', 'ZZ-1.md'), 'utf8')).toContain('ruled');
  });

  it('dates a source window from the audit the caller names', async () => {
    await writeSecondAudit('2099-01-01');

    const outcome = await service(AUDIT_DATE).source(
      { path: 'src/inside.ts', start: 1 },
      '2099-01-01'
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.stale).toBe(false);
  });

  it('falls back to the served default when the caller names no audit', async () => {
    await writeSecondAudit('2026-11-11');

    const served = await service(AUDIT_DATE).snapshot();

    expect(served.name).toBe(AUDIT_DATE);
  });
});
