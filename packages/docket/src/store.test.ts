import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claim, tryLock } from '../../../scripts/lib/claims/claim.ts';
import { parseFinding } from './parse.ts';
import {
  answerQuestion,
  applyWrite,
  askQuestion,
  denyFinding,
  expectedHash,
  fieldHash,
  listAuditNames,
  loadAudit,
  patchWrite,
  reopenFinding,
  resolveAuditDir,
  ruleFinding,
  unblockFinding,
  undoWrite,
  updateProgress,
  withdrawQuestion,
} from './store.ts';
import type { Finding } from './types.ts';

const FIXTURE_DIR = path.join(import.meta.dirname, '..', 'test-fixtures');
const AT = '2026-08-01';

let root: string;

async function copyFixture(name: string, id: string, auditName = '2026-07-30'): Promise<string> {
  const target = path.join(root, auditName, 'findings', `${id}.md`);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.copyFile(path.join(FIXTURE_DIR, `${name}.md`), target);
  return target;
}

async function makeAudit(name = '2026-07-30'): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(path.join(dir, 'findings'), { recursive: true });
  await fs.copyFile(path.join(FIXTURE_DIR, 'audit.md'), path.join(dir, 'audit.md'));
  return dir;
}

async function readFinding(filePath: string): Promise<Finding> {
  const result = parseFinding(await fs.readFile(filePath, 'utf8'), filePath);
  if (!result.ok) throw new Error(`re-read failed: ${JSON.stringify(result.issues)}`);
  return result.value;
}

async function bodyOf(filePath: string): Promise<string> {
  const text = await fs.readFile(filePath, 'utf8');
  return text.slice(text.indexOf('\n---\n') + 5);
}

async function progressBlockOf(filePath: string): Promise<string> {
  const text = await fs.readFile(filePath, 'utf8');
  return text.slice(text.indexOf('\nprogress:'), text.indexOf('\n---\n'));
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'docket-store-'));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('resolveAuditDir', () => {
  it('picks the lexically newest dated directory holding an audit', async () => {
    await makeAudit('2026-06-01');
    await makeAudit('2026-07-30');
    await makeAudit('2026-01-02');
    expect(await resolveAuditDir(root)).toBe(path.join(root, '2026-07-30'));
  });

  it('ignores a directory with no audit file', async () => {
    await makeAudit('2026-06-01');
    await fs.mkdir(path.join(root, '2026-12-01'), { recursive: true });
    expect(await resolveAuditDir(root)).toBe(path.join(root, '2026-06-01'));
  });

  it('ignores a directory whose name starts with an underscore', async () => {
    await makeAudit('2026-06-01');
    await makeAudit('_2026-12-01');
    expect(await resolveAuditDir(root)).toBe(path.join(root, '2026-06-01'));
  });

  it('ignores a name that is not a date', async () => {
    await makeAudit('2026-06-01');
    await makeAudit('drafts');
    expect(await resolveAuditDir(root)).toBe(path.join(root, '2026-06-01'));
  });

  it('honors a pin', async () => {
    await makeAudit('2026-06-01');
    await makeAudit('2026-07-30');
    expect(await resolveAuditDir(root, '2026-06-01')).toBe(path.join(root, '2026-06-01'));
  });

  it('fails fast when the pinned audit does not exist', async () => {
    await makeAudit('2026-06-01');
    await expect(resolveAuditDir(root, '2026-01-01')).rejects.toThrow(
      /no audit "2026-01-01" under/
    );
  });

  it('fails fast when there is no audit at all', async () => {
    await expect(resolveAuditDir(root)).rejects.toThrow(/no audit directory under/);
  });

  it('fails fast when the audits root is missing', async () => {
    await expect(resolveAuditDir(path.join(root, 'nope'))).rejects.toThrow(
      /no audit directory under/
    );
  });

  it('lists the audit names newest first', async () => {
    await makeAudit('2026-06-01');
    await makeAudit('2026-07-30');
    expect(await listAuditNames(root)).toEqual(['2026-07-30', '2026-06-01']);
  });
});

describe('loadAudit', () => {
  it('returns the audit header, the findings and the other audit names', async () => {
    await makeAudit();
    await makeAudit('2026-06-01');
    await copyFixture('open-two-options', 'AI-1');
    await copyFixture('no-options', 'DT-OWN');

    const loaded = await loadAudit(root);
    expect(loaded.name).toBe('2026-07-30');
    expect(loaded.audit.layout_version).toBe(1);
    const ids = loaded.findings
      .map((entry) => entry.finding.id)
      .toSorted((a, b) => a.localeCompare(b));
    expect(ids).toEqual(['AI-1', 'DT-OWN']);
    expect(loaded.audits).toEqual(['2026-07-30', '2026-06-01']);
    expect(loaded.validation).toEqual([]);
  });

  it('gives every finding a hash of its bytes', async () => {
    await makeAudit();
    await copyFixture('open-two-options', 'AI-1');
    const loaded = await loadAudit(root);
    expect(loaded.findings[0]?.hash).toMatch(/^[\da-f]{64}$/);
  });

  it('reports a malformed file in validation and still loads the rest', async () => {
    await makeAudit();
    await copyFixture('open-two-options', 'AI-1');
    await fs.writeFile(path.join(root, '2026-07-30/findings/BROKEN.md'), 'no frontmatter here');

    const loaded = await loadAudit(root);
    expect(loaded.findings).toHaveLength(1);
    expect(loaded.validation).toHaveLength(1);
    expect(loaded.validation[0]?.id).toBe('BROKEN');
    expect(loaded.validation[0]?.issues[0]?.code).toBe('missing-frontmatter');
  });

  it('reports a structural issue while still returning the finding', async () => {
    await makeAudit();
    await copyFixture('open-two-options', 'RENAMED');

    const loaded = await loadAudit(root);
    expect(loaded.findings).toHaveLength(1);
    expect(loaded.validation[0]?.issues[0]?.code).toBe('id-filename-mismatch');
  });

  it('ignores anything that is not a markdown file', async () => {
    await makeAudit();
    await copyFixture('open-two-options', 'AI-1');
    await fs.writeFile(path.join(root, '2026-07-30/findings/notes.txt'), 'scratch');

    const loaded = await loadAudit(root);
    expect(loaded.findings).toHaveLength(1);
    expect(loaded.validation).toEqual([]);
  });

  it('loads an audit with no findings directory', async () => {
    const dir = await makeAudit();
    await fs.rm(path.join(dir, 'findings'), { recursive: true });
    const loaded = await loadAudit(root);
    expect(loaded.findings).toEqual([]);
  });

  it('fails fast when the audit header is unreadable', async () => {
    const dir = await makeAudit();
    await fs.writeFile(path.join(dir, 'audit.md'), 'not an audit');
    await expect(loadAudit(root)).rejects.toThrow(/audit.md/);
  });

  it('honors a pin', async () => {
    await makeAudit();
    await makeAudit('2026-06-01');
    await copyFixture('no-options', 'DT-OWN', '2026-06-01');
    const loaded = await loadAudit(root, '2026-06-01');
    expect(loaded.findings[0]?.finding.id).toBe('DT-OWN');
  });
});

describe('applyWrite dedication', () => {
  it('lets an agent mark a finding dedicated', async () => {
    const file = await copyFixture('no-options', 'DT-OWN');
    const result = await applyWrite(file, patchWrite('agent', { dedicated: true }));
    expect(result.ok).toBe(true);
    const after = await readFinding(file);
    expect(after.dedicated).toBe(true);
  });

  it('lets an agent clear the mark', async () => {
    const file = await copyFixture('dedicated', 'WF-4');
    const result = await applyWrite(file, patchWrite('agent', { dedicated: false }));
    expect(result.ok).toBe(true);
  });

  it('writes an agent clearing the mark through to the file', async () => {
    const file = await copyFixture('dedicated', 'WF-4');
    await applyWrite(file, patchWrite('agent', { dedicated: false }));
    const after = await readFinding(file);
    expect(after.dedicated).toBe(false);
  });

  it('lets the human clear the mark', async () => {
    const file = await copyFixture('dedicated', 'WF-4');
    const result = await applyWrite(file, patchWrite('human', { dedicated: false }));
    expect(result.ok).toBe(true);
    const after = await readFinding(file);
    expect(after.dedicated).toBe(false);
  });

  it('lets the audit agent clear the mark', async () => {
    const file = await copyFixture('dedicated', 'WF-4');
    const result = await applyWrite(file, patchWrite('audit', { dedicated: false }));
    expect(result.ok).toBe(true);
    const after = await readFinding(file);
    expect(after.dedicated).toBe(false);
  });
});

describe('applyWrite ownership', () => {
  it('rejects a write naming a field the writer does not own', async () => {
    const file = await copyFixture('no-options', 'DT-OWN');
    const result = await applyWrite(file, patchWrite('agent', { state: 'ruled', ruling: null }));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'not-owned', fields: ['state', 'ruling'] },
    });
  });

  it('refuses an agent claiming a finding is verified', async () => {
    const file = await copyFixture('no-options', 'DT-OWN');
    const result = await applyWrite(file, updateProgress({ verified: true }, AT, 'agent'));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'not-owned', fields: ['progress.verified'] },
    });
  });

  it('lets the human record verification', async () => {
    const file = await copyFixture('no-options', 'DT-OWN');
    const result = await applyWrite(file, updateProgress({ verified: true }, AT, 'human'));
    expect(result.ok).toBe(true);
    const after = await readFinding(file);
    expect(after.progress.verified).toBe(true);
  });

  it('lets the human move progress status, so an unblock is not recorded as an agent action', async () => {
    const file = await copyFixture('no-options', 'DT-OWN');
    const result = await applyWrite(file, updateProgress({ status: 'in-progress' }, AT, 'human'));
    expect(result.ok).toBe(true);
    const after = await readFinding(file);
    expect(after.progress.status).toBe('in-progress');
  });

  it('refuses a human rewriting the status note', async () => {
    const file = await copyFixture('no-options', 'DT-OWN');
    const result = await applyWrite(file, patchWrite('human', { status_note: 'mine now' }));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'not-owned', fields: ['status_note'] },
    });
  });

  it('lets the audit agent write the status note', async () => {
    const file = await copyFixture('no-options', 'DT-OWN');
    const result = await applyWrite(file, patchWrite('audit', { status_note: 'only latent' }));
    expect(result.ok).toBe(true);
    const after = await readFinding(file);
    expect(after.status_note).toBe('only latent');
  });

  it('refuses an agent rewriting question text', async () => {
    const file = await copyFixture('question-open', 'WL-23-B');
    const result = await applyWrite(file, askQuestion({ text: 'mine now' }, AT, 'agent'));
    expect(result).toMatchObject({ ok: false, error: { code: 'not-owned' } });
  });

  it('refuses a human answering a question', async () => {
    const file = await copyFixture('question-open', 'WL-23-B');
    const result = await applyWrite(file, answerQuestion({ index: 0, text: 'mine' }, AT, 'human'));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'not-owned', fields: ['questions.answers'] },
    });
  });

  it('refuses the audit agent seeding a question', async () => {
    const file = await copyFixture('question-open', 'WL-23-B');
    const result = await applyWrite(file, askQuestion({ text: 'mine now' }, AT, 'audit'));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'not-owned', fields: ['questions'] },
    });
  });
});

describe('applyWrite mechanics', () => {
  it('re-reads from disk, so a change made after the caller read still stands', async () => {
    const file = await copyFixture('no-options', 'DT-OWN');
    const before = await readFinding(file);

    await applyWrite(file, patchWrite('human', { area: 'apps/web' }));
    // The caller below computes its patch from `before`, which is now stale.
    await applyWrite(file, (current) => {
      expect(current.area).toBe('apps/web');
      return updateProgress({ status: 'done' }, AT, 'agent')(current);
    });

    const after = await readFinding(file);
    expect(after.area).toBe('apps/web');
    expect(after.progress.status).toBe('done');
    expect(before.area).toBe('apps/api');
  });

  it('preserves the body bytes exactly', async () => {
    const file = await copyFixture('ruled-history', 'BILL-12');
    const body = await bodyOf(file);
    await applyWrite(file, updateProgress({ note: 'a note' }, AT, 'agent'));
    expect(await bodyOf(file)).toBe(body);
  });

  it('leaves no temporary file behind', async () => {
    const file = await copyFixture('no-options', 'DT-OWN');
    await applyWrite(file, updateProgress({ status: 'done' }, AT, 'agent'));
    // The lock file is the one thing that stays: unlinking one lets a waiter
    // hold a deleted inode while the next writer locks a fresh one, so the
    // primitive never removes it and its presence claims nothing.
    const entries = await fs.readdir(path.dirname(file));
    expect(entries.toSorted((a, b) => a.localeCompare(b))).toEqual(['DT-OWN.md', 'DT-OWN.md.lock']);
  });

  it('returns the finding it wrote, its bytes and a fresh hash', async () => {
    const file = await copyFixture('no-options', 'DT-OWN');
    const result = await applyWrite(file, updateProgress({ status: 'done' }, AT, 'agent'));
    if (!result.ok) throw new Error('expected the write to land');
    expect(result.value.finding.progress.status).toBe('done');
    expect(result.value.text).toBe(await fs.readFile(file, 'utf8'));
    expect(result.value.hash).toMatch(/^[\da-f]{64}$/);
  });

  it('reports an unreadable file rather than writing over it', async () => {
    const file = path.join(root, '2026-07-30/findings/GONE.md');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, 'not a finding');
    const result = await applyWrite(file, updateProgress({ status: 'done' }, AT, 'agent'));
    expect(result).toMatchObject({ ok: false, error: { code: 'unreadable' } });
    expect(await fs.readFile(file, 'utf8')).toBe('not a finding');
  });

  it('reports a directory that is gone, which the lock cannot be placed in either', async () => {
    const missing = path.join(root, 'nowhere/findings/GONE.md');
    const result = await applyWrite(missing, updateProgress({ status: 'done' }, AT, 'agent'));
    expect(result).toMatchObject({ ok: false, error: { code: 'unreadable' } });
  });

  it('reports a missing file rather than creating one', async () => {
    const missing = path.join(root, '2026-07-30/findings/GONE.md');
    await fs.mkdir(path.dirname(missing), { recursive: true });
    const result = await applyWrite(missing, updateProgress({ status: 'done' }, AT, 'agent'));
    expect(result).toMatchObject({ ok: false, error: { code: 'unreadable' } });
    expect(await fs.readdir(path.dirname(missing))).toEqual(['GONE.md.lock']);
  });

  it('reports a transition the finding does not admit', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    const result = await applyWrite(file, reopenFinding(AT));
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-transition' } });
  });

  it('refuses an agent blocking on a decision that no longer stands', async () => {
    const file = await copyFixture('denied', 'SEC-LOCK');
    const result = await applyWrite(file, updateProgress({ status: 'blocked' }, AT, 'agent'));
    if (result.ok) throw new Error('expected the write to be refused');
    expect(result.error.code).toBe('invalid');
    expect(result.error.issues?.[0]?.message).toContain('console');
    const after = await readFinding(file);
    expect(after.progress.status).toBe('not-started');
  });

  it('refuses a write that would break a structural invariant', async () => {
    const file = await copyFixture('no-options', 'DT-OWN');
    const result = await applyWrite(file, patchWrite('human', { state: 'ruled' }));
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid' } });
    const after = await readFinding(file);
    expect(after.state).toBe('open');
  });
});

describe('applyWrite concurrency', () => {
  it('lands both writers when a human ruling and an agent note race', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');

    const [ruling, note] = await Promise.all([
      applyWrite(file, ruleFinding({ option: 'A', text: 'Do it.', note: null }, AT)),
      applyWrite(file, updateProgress({ note: 'Started.', status: 'in-progress' }, AT, 'agent')),
    ]);

    expect(ruling.ok).toBe(true);
    expect(note.ok).toBe(true);
    const after = await readFinding(file);
    expect(after.ruling?.option).toBe('A');
    expect(after.progress.status).toBe('in-progress');
    expect(after.progress.notes).toHaveLength(1);
  });

  it('lands both writers in the other order too', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');

    const [note, ruling] = await Promise.all([
      applyWrite(file, updateProgress({ note: 'Started.', status: 'in-progress' }, AT, 'agent')),
      applyWrite(file, ruleFinding({ option: 'B', text: null, note: null }, AT)),
    ]);

    expect(note.ok).toBe(true);
    expect(ruling.ok).toBe(true);
    const after = await readFinding(file);
    expect(after.ruling?.option).toBe('B');
    expect(after.progress.notes).toHaveLength(1);
  });

  it('keeps both notes when two note writers race', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');

    await Promise.all([
      applyWrite(file, updateProgress({ note: 'first' }, AT, 'agent')),
      applyWrite(file, updateProgress({ note: 'second' }, AT, 'human')),
    ]);

    const after = await readFinding(file);
    const texts = after.progress.notes
      .map((entry) => entry.text)
      .toSorted((a, b) => a.localeCompare(b));
    expect(texts).toEqual(['first', 'second']);
  });

  it('rejects a same-field write carrying a stale field hash', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    const second = ruleFinding({ option: 'B', text: null, note: null }, AT);
    const stale = expectedHash(await readFinding(file), second);
    if (stale === null) throw new Error('expected a hash for a legal transition');

    await applyWrite(file, ruleFinding({ option: 'A', text: null, note: null }, AT));
    const result = await applyWrite(file, second, { expect: stale });

    expect(result).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const after = await readFinding(file);
    expect(after.ruling?.option).toBe('A');
  });

  it('admits a write whose own fields are untouched, however stale the file is', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    const note = updateProgress({ status: 'in-progress' }, AT, 'agent');
    const stale = expectedHash(await readFinding(file), note);
    if (stale === null) throw new Error('expected a hash for a legal transition');

    await applyWrite(file, ruleFinding({ option: 'A', text: null, note: null }, AT));

    const second = await applyWrite(file, note, { expect: stale });
    expect(second.ok).toBe(true);
  });

  it('has no hash to expect for a transition the finding does not admit', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    expect(expectedHash(await readFinding(file), reopenFinding(AT))).toBeNull();
  });

  it('hashes only the fields a write names', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    const finding = await readFinding(file);
    expect(fieldHash(finding, ['state'])).not.toBe(fieldHash(finding, ['state', 'ruling']));
    expect(fieldHash(finding, ['state', 'ruling'])).toBe(fieldHash(finding, ['ruling', 'state']));
  });
});

describe('write locking', () => {
  /**
   * Bytes with nothing behind them. A lock file outlives every holder, so one
   * left by a writer that died says nothing about whether it is held.
   */
  async function abandonLock(filePath: string): Promise<void> {
    await fs.writeFile(`${filePath}.lock`, 'a writer that is long gone');
  }

  async function lockIsFree(filePath: string): Promise<boolean> {
    const probe = await tryLock(`${filePath}.lock`);
    return !probe.held;
  }

  /**
   * Holds the file's lock the way a second writer would, and hands back the
   * release. A second descriptor conflicts with the first even inside one
   * process, which is what lets a refusal be observed without a second one.
   */
  async function holdLock(filePath: string): Promise<() => Promise<void>> {
    const acquired = Promise.withResolvers<null>();
    const released = Promise.withResolvers<null>();

    const holding = claim(
      { name: path.basename(filePath), lockPath: `${filePath}.lock` },
      { onHeld: 'refuse', holder: 'another writer' },
      async () => {
        acquired.resolve(null);
        await released.promise;
      }
    );
    await Promise.race([acquired.promise, holding]);

    return async () => {
      released.resolve(null);
      await holding;
    };
  }

  it('holds a lock file while the write runs', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    let heldDuring = false;

    await applyWrite(file, (finding) => {
      heldDuring = existsSync(`${file}.lock`);
      return { ok: true, value: { writer: 'human', patch: { area: finding.area } } };
    });

    expect(heldDuring).toBe(true);
  });

  it('holds nothing once a write has landed', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    await applyWrite(file, ruleFinding({ option: 'A', text: null, note: null }, AT));
    expect(await lockIsFree(file)).toBe(true);
  });

  it('holds nothing once a write is refused', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    await applyWrite(file, patchWrite('agent', { state: 'ruled' }));
    expect(await lockIsFree(file)).toBe(true);
  });

  it('writes past a lock file a dead writer left behind', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    await abandonLock(file);

    const result = await applyWrite(file, ruleFinding({ option: 'A', text: null, note: null }, AT));

    expect(result.ok).toBe(true);
    const after = await readFinding(file);
    expect(after.ruling?.option).toBe('A');
  });

  it('refuses a write rather than proceed past a lock a live writer holds', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    const before = await fs.readFile(file, 'utf8');
    const release = await holdLock(file);

    // Only the clock is faked, so the write really does retry against a lock
    // another writer holds; moving the clock past the wait budget is what ends
    // it. Nothing about that writer is read from a clock — the budget bounds
    // how long this one queues, not how long the other is believed alive.
    const start = Date.now();
    vi.useFakeTimers({ toFake: ['Date'] });
    const pending = applyWrite(file, ruleFinding({ option: 'A', text: null, note: null }, AT));
    await new Promise((resolve) => setTimeout(resolve, 50));
    vi.setSystemTime(start + 10_000);
    const result = await pending;
    vi.useRealTimers();
    await release();

    expect(result).toMatchObject({ ok: false, error: { code: 'locked' } });
    expect(await fs.readFile(file, 'utf8')).toBe(before);
  });

  it('takes the lock for an undo', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    const first = await applyWrite(file, ruleFinding({ option: 'A', text: null, note: null }, AT));
    if (!first.ok) throw new Error('expected the ruling to land');
    await abandonLock(file);

    const undone = await undoWrite(file, first.value.previousText, first.value.hash);
    expect(undone.ok).toBe(true);
    expect(await lockIsFree(file)).toBe(true);
  });
});

describe('undoWrite', () => {
  it('puts the previous frontmatter back', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    const first = await applyWrite(file, ruleFinding({ option: 'A', text: null, note: null }, AT));
    if (!first.ok) throw new Error('expected the ruling to land');

    const undone = await undoWrite(file, first.value.previousText, first.value.hash);
    expect(undone.ok).toBe(true);
    const after = await readFinding(file);
    expect(after.state).toBe('open');
    expect(after.ruling).toBeNull();
  });

  it('keeps the body bytes when it reverts', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    const body = await bodyOf(file);
    const first = await applyWrite(file, ruleFinding({ option: 'A', text: null, note: null }, AT));
    if (!first.ok) throw new Error('expected the ruling to land');

    await undoWrite(file, first.value.previousText, first.value.hash);
    expect(await bodyOf(file)).toBe(body);
  });

  it('reports a missing target rather than recreating it', async () => {
    const missing = path.join(root, '2026-07-30/findings/GONE.md');
    const file = await copyFixture('open-two-options', 'AI-1');
    const previous = await fs.readFile(file, 'utf8');
    expect(await undoWrite(missing, previous, 'any-hash')).toMatchObject({
      ok: false,
      error: { code: 'unreadable' },
    });
  });

  it('reports a target that is no longer a finding', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    const previous = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, 'not a finding');
    expect(await undoWrite(file, previous, 'any-hash')).toMatchObject({
      ok: false,
      error: { code: 'unreadable' },
    });
  });

  it('reports unreadable previous bytes rather than writing them', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    const result = await undoWrite(file, 'not a finding', 'any-hash');
    expect(result).toMatchObject({ ok: false, error: { code: 'unreadable' } });
  });

  it('refuses when the finding moved after the write being undone', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    const first = await applyWrite(file, ruleFinding({ option: 'A', text: null, note: null }, AT));
    if (!first.ok) throw new Error('expected the ruling to land');
    const noted = await applyWrite(file, updateProgress({ note: 'looking at it' }, AT, 'agent'));
    if (!noted.ok) throw new Error('expected the note to land');

    const undone = await undoWrite(file, first.value.previousText, first.value.hash);

    expect(undone).toMatchObject({ ok: false, error: { code: 'conflict' } });
    expect(await fs.readFile(file, 'utf8')).toBe(noted.value.text);
  });
});

describe('the state machine', () => {
  async function transition(
    fixture: string,
    id: string,
    change: Parameters<typeof applyWrite>[1]
  ): Promise<Finding> {
    const file = await copyFixture(fixture, id);
    const result = await applyWrite(file, change);
    if (!result.ok) throw new Error(`transition refused: ${JSON.stringify(result.error)}`);
    return result.value.finding;
  }

  it('rules an open finding', async () => {
    const after = await transition(
      'open-two-options',
      'AI-1',
      ruleFinding({ option: 'A', text: 'Do it.', note: 'Carefully.' }, AT)
    );
    expect(after.state).toBe('ruled');
    expect(after.ruling).toEqual({ option: 'A', text: 'Do it.', note: 'Carefully.', at: AT });
  });

  it('leaves an unanswered question outstanding, because a ruling does not answer it', async () => {
    const after = await transition(
      'question-open',
      'WL-23-B',
      ruleFinding({ option: 'A', text: null, note: null }, AT)
    );
    expect(after.state).toBe('ruled');
    expect(after.questions).toHaveLength(1);
    expect(after.questions[0]?.answer).toBeNull();
  });

  it('archives the outgoing ruling when a ruling changes', async () => {
    const after = await transition(
      'ruled-history',
      'BILL-12',
      ruleFinding({ option: 'A', text: null, note: null }, AT)
    );
    expect(after.ruling?.option).toBe('A');
    expect(after.history.at(-1)).toEqual({
      at: '2026-07-30',
      kind: 'ruling',
      superseded_at: AT,
      option: 'B',
      text: 'Charge the estimate and flag it, but raise one Sentry event so a human resolves it. “Estimated” must never be silent.',
      note: 'Keep fee application at the port seam.',
    });
  });

  it('keeps the progress notes when a ruling changes', async () => {
    const after = await transition(
      'ruled-history',
      'BILL-12',
      ruleFinding({ option: 'A', text: null, note: null }, AT)
    );
    expect(after.progress.notes).toHaveLength(2);
  });

  it('archives the denial when a denied finding is ruled', async () => {
    const after = await transition(
      'denied',
      'SEC-LOCK',
      ruleFinding({ option: 'A', text: null, note: null }, AT)
    );
    expect(after.state).toBe('ruled');
    expect(after.denial).toBeNull();
    expect(after.history.at(-1)).toMatchObject({ kind: 'denial', superseded_at: AT, by: 'human' });
  });

  it('denies an open finding', async () => {
    const after = await transition(
      'open-two-options',
      'AI-1',
      denyFinding({ reason: 'Out of scope.' }, AT)
    );
    expect(after.state).toBe('denied');
    expect(after.denial).toEqual({ by: 'human', reason: 'Out of scope.', at: AT });
  });

  it('archives the ruling when a ruled finding is denied', async () => {
    const after = await transition('ruled-history', 'BILL-12', denyFinding({ reason: null }, AT));
    expect(after.state).toBe('denied');
    expect(after.ruling).toBeNull();
    expect(after.history.at(-1)).toMatchObject({ kind: 'ruling', superseded_at: AT, option: 'B' });
  });

  it('refuses to deny a finding that is already denied', async () => {
    const file = await copyFixture('denied', 'SEC-LOCK');
    const result = await applyWrite(file, denyFinding({ reason: 'again' }, AT));
    expect(result).toMatchObject({ ok: false, error: { code: 'invalid-transition' } });
  });

  it('reopens a ruled finding and archives its ruling', async () => {
    const after = await transition('ruled-history', 'BILL-12', reopenFinding(AT));
    expect(after.state).toBe('open');
    expect(after.ruling).toBeNull();
    expect(after.history.at(-1)).toMatchObject({ kind: 'ruling', superseded_at: AT });
  });

  it('reopens a denied finding and archives its denial', async () => {
    const after = await transition('denied', 'SEC-LOCK', reopenFinding(AT));
    expect(after.state).toBe('open');
    expect(after.denial).toBeNull();
    expect(after.history.at(-1)).toMatchObject({ kind: 'denial', superseded_at: AT });
  });

  it('asks for options when reopening a finding that has none', async () => {
    const after = await transition('denied-at-emission', 'CLEAN-1', reopenFinding(AT));
    expect(after.needs_options).toBe(true);
  });

  it('leaves needs_options alone when reopening a finding that has options', async () => {
    const after = await transition('ruled-history', 'BILL-12', reopenFinding(AT));
    expect(after.needs_options).toBe(false);
  });

  it('refuses to reopen an open finding', async () => {
    const file = await copyFixture('open-two-options', 'AI-1');
    expect(await applyWrite(file, reopenFinding(AT))).toMatchObject({
      ok: false,
      error: { code: 'invalid-transition' },
    });
  });

  it('asks a question without moving the finding', async () => {
    const after = await transition(
      'open-two-options',
      'AI-1',
      askQuestion({ text: 'Which slice owns this?' }, AT, 'human')
    );
    expect(after.state).toBe('open');
    expect(after.questions.at(-1)).toEqual({
      at: AT,
      text: 'Which slice owns this?',
      answer: null,
      answered_at: null,
    });
  });

  it('asks a question of a ruled finding, which stays ruled', async () => {
    const after = await transition(
      'ruled-history',
      'BILL-12',
      askQuestion({ text: 'Which slice owns this?' }, AT, 'human')
    );
    expect(after.state).toBe('ruled');
    expect(after.questions.at(-1)?.text).toBe('Which slice owns this?');
  });

  it('records an answer without moving the finding', async () => {
    const after = await transition(
      'question-open',
      'WL-23-B',
      answerQuestion({ index: 0, text: 'The conversation slice.' }, AT, 'agent')
    );
    expect(after.state).toBe('open');
    expect(after.questions[0]?.answer).toBe('The conversation slice.');
    expect(after.questions[0]?.answered_at).toBe(AT);
  });

  it('leaves progress untouched when an agent answers a question', async () => {
    const file = await copyFixture('question-open', 'WL-23-B');
    const before = await readFinding(file);
    const result = await applyWrite(
      file,
      answerQuestion({ index: 0, text: 'The conversation slice.' }, AT, 'agent')
    );
    expect(result.ok).toBe(true);
    const after = await readFinding(file);
    expect(after.progress).toEqual(before.progress);
  });

  it('refuses an answer to a question that does not exist', async () => {
    const file = await copyFixture('question-open', 'WL-23-B');
    expect(
      await applyWrite(file, answerQuestion({ index: 7, text: 'x' }, AT, 'agent'))
    ).toMatchObject({
      ok: false,
      error: { code: 'unknown-question' },
    });
  });

  it('refuses an answer to a question already answered', async () => {
    const file = await copyFixture('ruled-history', 'BILL-12');
    expect(
      await applyWrite(file, answerQuestion({ index: 0, text: 'x' }, AT, 'agent'))
    ).toMatchObject({
      ok: false,
      error: { code: 'unknown-question' },
    });
  });

  it('withdraws a question', async () => {
    const after = await transition('question-open', 'WL-23-B', withdrawQuestion({ index: 0 }));
    expect(after.state).toBe('open');
    expect(after.questions).toEqual([]);
  });

  it('refuses to withdraw a question that does not exist', async () => {
    const file = await copyFixture('question-open', 'WL-23-B');
    expect(await applyWrite(file, withdrawQuestion({ index: 3 }))).toMatchObject({
      ok: false,
      error: { code: 'unknown-question' },
    });
  });

  it('records progress without touching the state', async () => {
    const after = await transition(
      'question-open',
      'WL-23-B',
      updateProgress({ status: 'in-progress', note: 'Reproduced.' }, AT, 'agent')
    );
    expect(after.state).toBe('open');
    expect(after.progress.status).toBe('in-progress');
    expect(after.progress.updated).toBe(AT);
    expect(after.progress.notes.at(-1)).toEqual({ at: AT, by: 'agent', text: 'Reproduced.' });
  });

  it('attributes a human progress note to the human', async () => {
    const after = await transition(
      'open-two-options',
      'AI-1',
      updateProgress({ note: 'Ship it first.' }, AT, 'human')
    );
    expect(after.progress.notes.at(-1)?.by).toBe('human');
  });

  describe('the work recorded against the decision a new one replaces', () => {
    const RULE = ruleFinding({ option: 'A', text: null, note: null }, AT);

    async function withProgress(
      input: Parameters<typeof updateProgress>[0],
      writer: 'human' | 'agent' = 'human'
    ): Promise<string> {
      const file = await copyFixture('ruled-history', 'BILL-12');
      const result = await applyWrite(file, updateProgress(input, AT, writer));
      if (!result.ok) throw new Error(`setup refused: ${JSON.stringify(result.error)}`);
      return file;
    }

    async function decide(
      file: string,
      change: Parameters<typeof applyWrite>[1]
    ): Promise<Finding> {
      const result = await applyWrite(file, change);
      if (!result.ok) throw new Error(`transition refused: ${JSON.stringify(result.error)}`);
      return result.value.finding;
    }

    it('returns a blocked finding to not-started when a new ruling supersedes the old one', async () => {
      const after = await decide(await withProgress({ status: 'blocked' }), RULE);
      expect(after.progress.status).toBe('not-started');
    });

    it('returns a blocked finding to not-started when it is denied', async () => {
      const after = await decide(
        await withProgress({ status: 'blocked' }),
        denyFinding({ reason: null }, AT)
      );
      expect(after.progress.status).toBe('not-started');
    });

    it('returns a blocked finding to not-started when it is reopened', async () => {
      const after = await decide(await withProgress({ status: 'blocked' }), reopenFinding(AT));
      expect(after.progress.status).toBe('not-started');
    });

    it('does not resurrect the block when a reopened finding is ruled again', async () => {
      const file = await withProgress({ status: 'blocked' });
      await decide(file, reopenFinding(AT));
      const after = await decide(file, RULE);
      expect(after.progress.status).toBe('not-started');
    });

    it('keeps the notes of a blocked finding a ruling resets', async () => {
      const file = await withProgress({ status: 'blocked' });
      const before = await readFinding(file);
      const after = await decide(file, RULE);
      expect(after.progress.notes).toEqual(before.progress.notes);
    });

    it("keeps the agent's last-reported stamp when a ruling resets the status", async () => {
      const file = await withProgress({ status: 'blocked' });
      const before = await readFinding(file);
      const after = await decide(file, RULE);
      expect(after.progress.updated).toBe(before.progress.updated);
    });

    it('clears verification when a new ruling supersedes the decision it was recorded against', async () => {
      const after = await decide(await withProgress({ verified: true }), RULE);
      expect(after.progress.verified).toBe(false);
    });

    it('clears verification when the finding is denied', async () => {
      const after = await decide(
        await withProgress({ verified: true }),
        denyFinding({ reason: null }, AT)
      );
      expect(after.progress.verified).toBe(false);
    });

    it('clears verification when the finding is reopened', async () => {
      const after = await decide(await withProgress({ verified: true }), reopenFinding(AT));
      expect(after.progress.verified).toBe(false);
    });

    it('clears verification standing on a finding whose status never moved', async () => {
      const after = await decide(
        await withProgress({ status: 'not-started', verified: true }),
        RULE
      );
      expect(after.progress.verified).toBe(false);
    });

    it('fences a reset ruling on the two progress fields it resets and nothing else', async () => {
      const before = await readFinding(await withProgress({ status: 'blocked' }));
      // `fieldHash` covers exactly the paths named, so equality with this list is
      // what proves the patch reaches neither `progress.notes` nor `progress.updated`.
      expect(expectedHash(before, RULE)).toBe(
        fieldHash(before, ['history', 'progress.status', 'progress.verified', 'ruling', 'state'])
      );
    });

    it('fences a first ruling on no progress field at all', async () => {
      const file = await copyFixture('open-two-options', 'AI-1');
      const before = await readFinding(file);
      expect(expectedHash(before, RULE)).toBe(fieldHash(before, ['ruling', 'state']));
    });

    it('leaves the progress block byte-identical when a pristine finding is first ruled', async () => {
      const file = await copyFixture('open-two-options', 'AI-1');
      const before = await progressBlockOf(file);
      await decide(file, RULE);
      expect(await progressBlockOf(file)).toBe(before);
    });
  });

  describe('the answer to a block', () => {
    const ANSWERED_AT = '2026-08-02';
    const ANSWER = 'Charge the estimate; the flag ships first.';
    const UNBLOCK = unblockFinding({ note: ANSWER }, ANSWERED_AT);

    async function blocked(): Promise<string> {
      const file = await copyFixture('ruled-history', 'BILL-12');
      const result = await applyWrite(
        file,
        updateProgress({ status: 'blocked', note: 'Which cost does a zero mean?' }, AT, 'agent')
      );
      if (!result.ok) throw new Error(`setup refused: ${JSON.stringify(result.error)}`);
      return file;
    }

    async function answer(file: string): Promise<Finding> {
      const result = await applyWrite(file, UNBLOCK);
      if (!result.ok) throw new Error(`transition refused: ${JSON.stringify(result.error)}`);
      return result.value.finding;
    }

    it('returns the finding to the work queue', async () => {
      const after = await answer(await blocked());
      expect(after.progress.status).toBe('not-started');
    });

    it('appends the answer as the human’s note after the account it answers', async () => {
      const file = await blocked();
      const before = await readFinding(file);
      const after = await answer(file);
      expect(after.progress.notes).toEqual([
        ...before.progress.notes,
        { at: ANSWERED_AT, by: 'human', text: ANSWER },
      ]);
    });

    it('leaves the ruling the block was raised against standing', async () => {
      const file = await blocked();
      const before = await readFinding(file);
      const after = await answer(file);
      expect(after.state).toBe('ruled');
      expect(after.ruling).toEqual(before.ruling);
    });

    it('refuses a ruled finding whose work is not blocked', async () => {
      const file = await copyFixture('ruled-history', 'BILL-12');
      expect(await applyWrite(file, UNBLOCK)).toMatchObject({
        ok: false,
        error: { code: 'invalid-transition' },
      });
    });

    it('refuses a finding that carries no ruling to be blocked on', async () => {
      const file = await copyFixture('open-two-options', 'AI-1');
      expect(await applyWrite(file, UNBLOCK)).toMatchObject({
        ok: false,
        error: { code: 'invalid-transition' },
      });
    });

    it('fences on the status it moves and the notes it appends, and nothing else', async () => {
      const before = await readFinding(await blocked());
      // `fieldHash` covers exactly the paths named, so equality with this list is
      // what proves the patch reaches neither `progress.updated` nor
      // `progress.verified`, both of which a human write may not or must not move.
      expect(expectedHash(before, UNBLOCK)).toBe(
        fieldHash(before, ['progress.notes', 'progress.status'])
      );
    });
  });
});
