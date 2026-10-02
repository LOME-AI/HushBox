import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { DAY_SECONDS } from '@hushbox/shared/durations';
import { TEST_DAY_START, DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS } from '@hushbox/shared/test-time';
import { normalizeHeadCommitDate, describeOutcome } from './normalize-commit-date.js';

/**
 * The rendered offsets a stamp can carry, one per side of UTC. Both signs are
 * present deliberately: the stamp shape accepts `[+-]`, and a suite whose
 * fixtures are all one sign only catches a truncation of that band when the
 * runner's own zone happens to supply the other — a coincidence, not a pin.
 * These are shapes, not recorded instants.
 */
const ZONE_OFFSETS = { utc: '+0000', east: '+0530', west: '-0400' } as const;

/**
 * Seconds past a day start that still sit inside the millisecond carve-out's
 * thousand-unit tolerance. An exact day-multiple test and a tolerance test agree
 * on every other epoch and disagree here, so this is what tells them apart.
 */
const EARLY_DAY_MS = 5 * MINUTE_MS;

/**
 * A UTC day boundary from before the epoch reached ten digits, so a fixture can
 * vary a stamp's digit count. The epoch crossed ten digits in 2001; any day in
 * 2000 is on the short side of it, and a day boundary discloses nothing.
 */
const NINE_DIGIT_DAY_START_MS = Date.UTC(2000, 0, 1);

const SCRIPT_DIRECTORY = import.meta.dirname;
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, '..');
const TSX_BINARY = path.join(REPOSITORY_ROOT, 'node_modules', '.bin', 'tsx');
const NORMALIZER = path.join(SCRIPT_DIRECTORY, 'normalize-commit-date.ts');

let sandbox: string;
let fixtureSequence = 0;

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/');
}

/**
 * The ways a fixture commit's dates can be non-conforming, each selectable on
 * its own. A generator that moves two of them together pins neither: while one
 * produced every date in this suite, four separate mutations of the rule under
 * test survived a fully covered run, because no fixture could disagree with any
 * single one of them.
 */
interface DateShape {
  /** Which side of UTC the stamp is rendered on. */
  readonly zone?: keyof typeof ZONE_OFFSETS;
  /**
   * Where the epoch sits in its UTC day: exactly on the boundary, a few minutes
   * past it (inside the tolerance band), exactly half a day past it, or the
   * middle of the day.
   */
  readonly epoch?: 'day-start' | 'early-day' | 'half-day' | 'mid-day';
  /** Whole UTC days the author stamp sits before the committer stamp. */
  readonly daysApart?: number;
  /** The UTC day the stamps fall on. Varies a stamp's epoch digit count. */
  readonly dayStartMs?: number;
}

interface FixtureDates {
  readonly author: string;
  readonly committer: string;
  /** The seconds between the two stamps' day starts, which the rewrite must keep. */
  readonly gap: number;
}

/**
 * A fixture commit's second, taken from the shared frozen instant rather than
 * the running clock. A clock-derived fixture carries a hidden dependency on when
 * it runs: the epoch it produces lands wherever the day happens to be, so a case
 * meant to sit at a particular point in the day only does so some of the time.
 * Mid-day calls step a sequence, which keeps rebase fixtures in a stable order.
 */
function fixtureSeconds(shape: Required<Pick<DateShape, 'epoch' | 'dayStartMs'>>): number {
  const dayStart = shape.dayStartMs / SECOND_MS;
  const halfDay = (12 * HOUR_MS) / SECOND_MS;
  if (shape.epoch === 'day-start') return dayStart;
  if (shape.epoch === 'early-day') return dayStart + EARLY_DAY_MS / SECOND_MS;
  if (shape.epoch === 'half-day') return dayStart + halfDay;
  const seconds = dayStart + halfDay + fixtureSequence;
  fixtureSequence += 1;
  return seconds;
}

/**
 * Both stamps of one fixture commit. Subtracting whole days from the committer
 * stamp preserves the author stamp's time of day and its standing against the
 * day multiple, so `daysApart` moves the two stamps' days and nothing else.
 */
function fixtureDates(shape: DateShape = {}): FixtureDates {
  const { zone = 'east', epoch = 'mid-day', daysApart = 0, dayStartMs = TEST_DAY_START } = shape;
  const rendered = ZONE_OFFSETS[zone];
  const committerSeconds = fixtureSeconds({ epoch, dayStartMs });
  const gap = (daysApart * DAY_MS) / SECOND_MS;
  return {
    author: `@${String(committerSeconds - gap)} ${rendered}`,
    committer: `@${String(committerSeconds)} ${rendered}`,
    gap,
  };
}

/**
 * The two stamps are set independently, because a cherry-pick carries its author
 * stamp through from the picked commit and mints only a committer one. A helper
 * that could only set them together made per-stamp conformity unreachable.
 */
async function git(
  cwd: string,
  args: readonly string[],
  authorDate?: string,
  committerDate?: string
): Promise<string> {
  const committer = committerDate ?? authorDate;
  const env = {
    ...(authorDate === undefined ? {} : { GIT_AUTHOR_DATE: authorDate }),
    ...(committer === undefined ? {} : { GIT_COMMITTER_DATE: committer }),
  };
  const { stdout } = await execa('git', [...args], { cwd, env });
  return stdout;
}

async function initRepository(name: string): Promise<string> {
  const directory = path.join(sandbox, name);
  await fs.mkdir(directory, { recursive: true });
  await git(directory, ['init', '-q', '-b', 'main']);
  await git(directory, ['config', 'user.name', 'Test Person']);
  await git(directory, ['config', 'user.email', 'test@example.invalid']);
  await git(directory, ['config', 'pull.rebase', 'false']);
  return directory;
}

async function commitFile(
  directory: string,
  file: string,
  content: string,
  message: string
): Promise<void> {
  const dates = fixtureDates();
  await fs.writeFile(path.join(directory, file), content);
  await git(directory, ['add', file]);
  await git(directory, ['commit', '-q', '-m', message], dates.author, dates.committer);
}

/**
 * Which of the two rebuilds a fixture's commit will take: an unsigned commit is
 * patched in its raw object, a signed one is remade through `commit-tree`.
 */
type RebuildPath = 'unsigned' | 'signed';

async function repositoryOnPath(name: string, rebuildPath: RebuildPath): Promise<string> {
  const repository = await initRepository(`${name}-${rebuildPath}`);
  if (rebuildPath === 'signed') await configureSshSigning(repository);
  return repository;
}

async function commitOnPath(
  directory: string,
  rebuildPath: RebuildPath,
  dates: FixtureDates
): Promise<void> {
  await fs.writeFile(path.join(directory, 'a.txt'), 'a\n');
  await git(directory, ['add', 'a.txt']);
  const signing = rebuildPath === 'signed' ? ['-S'] : [];
  await git(
    directory,
    ['commit', '-q', ...signing, '-m', 'subject'],
    dates.author,
    dates.committer
  );
}

async function rawDates(directory: string, revision = 'HEAD'): Promise<readonly string[]> {
  const output = await git(directory, ['log', '-1', '--format=%ad%n%cd', '--date=raw', revision]);
  return output.split('\n');
}

/** The UTC day start of a `--date=raw` stamp, as the rewrite should pin it. */
function dayStartOf(rawDate: string): number {
  return Math.floor(Number(rawDate.split(' ')[0]) / DAY_SECONDS) * DAY_SECONDS;
}

function isConforming(rawDate: string): boolean {
  const [epoch = '', offset = ''] = rawDate.split(' ');
  return offset === '+0000' && Number(epoch) % DAY_SECONDS === 0;
}

async function expectConforming(directory: string, revision = 'HEAD'): Promise<void> {
  for (const rawDate of await rawDates(directory, revision)) {
    expect({ revision, rawDate, conforming: isConforming(rawDate) }).toMatchObject({
      conforming: true,
    });
  }
}

async function readRawCommit(directory: string): Promise<Buffer> {
  const { stdout } = await execa('git', ['cat-file', 'commit', 'HEAD'], {
    cwd: directory,
    encoding: 'buffer',
    stripFinalNewline: false,
  });
  return Buffer.from(stdout);
}

/** Header lines as latin1 text, which maps bytes one to one. */
async function headerLines(directory: string): Promise<readonly string[]> {
  const raw = await readRawCommit(directory);
  return raw.subarray(0, raw.indexOf('\n\n')).toString('latin1').split('\n');
}

async function headerKeys(directory: string): Promise<readonly string[]> {
  const lines = await headerLines(directory);
  return lines.filter((line) => !line.startsWith(' ')).map((line) => line.split(' ')[0] ?? '');
}

/**
 * The `author` line with its trailing epoch and offset removed, as raw bytes —
 * the identity the rewrite has to carry through untouched.
 */
async function authorIdentityBytes(directory: string): Promise<Buffer> {
  const lines = await headerLines(directory);
  const author = lines.find((line) => line.startsWith('author ')) ?? '';
  return Buffer.from(author.replace(/ -?\d+ [+-]\d{4}$/, ''), 'latin1');
}

/**
 * Installs a hand-built commit object — the only way to mint a header or an
 * identity byte sequence git's own porcelain will not produce.
 */
async function installRawCommit(
  directory: string,
  transform: (headerLines: readonly string[]) => readonly string[]
): Promise<void> {
  const raw = await readRawCommit(directory);
  const separator = raw.indexOf('\n\n');
  const header = raw.subarray(0, separator).toString('latin1').split('\n');
  const rebuilt = Buffer.concat([
    Buffer.from(transform(header).join('\n'), 'latin1'),
    raw.subarray(separator),
  ]);
  const { stdout } = await execa('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd: directory,
    input: rebuilt,
  });
  await git(directory, ['update-ref', 'HEAD', stdout.trim()]);
}

/**
 * A repository shaped like a real clone: a copy of the script and its imports,
 * the package manifest that marks the tree as modules, husky's own dispatcher
 * stubs, and the three tracked hook files verbatim. Nothing here restates the
 * hooks — they are the files that ship.
 */
async function makeCloneShapedRepository(name: string): Promise<string> {
  const directory = await initRepository(name);
  const scripts = path.join(directory, 'scripts');
  await fs.mkdir(scripts, { recursive: true });
  // Copied, not linked: Node reports a linked module by its real path, which
  // would not match the argv path, so the script's command-line branch would
  // never run and every assertion here would pass vacuously.
  await fs.copyFile(
    path.join(SCRIPT_DIRECTORY, 'package.json'),
    path.join(scripts, 'package.json')
  );
  await fs.copyFile(NORMALIZER, path.join(scripts, 'normalize-commit-date.ts'));
  await fs.cp(path.join(SCRIPT_DIRECTORY, 'lib'), path.join(scripts, 'lib'), { recursive: true });
  await fs.symlink(
    path.join(SCRIPT_DIRECTORY, 'node_modules'),
    path.join(scripts, 'node_modules'),
    'junction'
  );
  await fs.symlink(
    path.join(REPOSITORY_ROOT, 'node_modules'),
    path.join(directory, 'node_modules'),
    'junction'
  );
  const stubs = path.join(directory, '.husky', '_');
  await fs.mkdir(stubs, { recursive: true });
  await fs.copyFile(path.join(REPOSITORY_ROOT, '.husky', '_', 'h'), path.join(stubs, 'h'));
  for (const hook of ['post-commit', 'post-merge', 'post-applypatch']) {
    await fs.copyFile(path.join(REPOSITORY_ROOT, '.husky', '_', hook), path.join(stubs, hook));
    await fs.copyFile(
      path.join(REPOSITORY_ROOT, '.husky', hook),
      path.join(directory, '.husky', hook)
    );
  }
  await git(directory, ['config', 'core.hooksPath', stubs]);
  return directory;
}

async function configureSshSigning(directory: string): Promise<void> {
  const key = path.join(directory, 'signing-key');
  await execa('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', 'signing', '-f', key]);
  const publicKey = await fs.readFile(`${key}.pub`, 'utf8');
  const allowedSigners = path.join(directory, 'allowed-signers');
  await fs.writeFile(allowedSigners, `test@example.invalid ${publicKey}`);
  await git(directory, ['config', 'gpg.format', 'ssh']);
  await git(directory, ['config', 'user.signingkey', `${key}.pub`]);
  await git(directory, ['config', 'gpg.ssh.allowedSignersFile', allowedSigners]);
}

async function installHooks(directory: string): Promise<void> {
  const hooksDirectory = path.join(directory, '..', `${path.basename(directory)}-hooks`);
  await fs.mkdir(hooksDirectory, { recursive: true });
  const body = `#!/bin/sh\n"${toPosixPath(TSX_BINARY)}" "${toPosixPath(NORMALIZER)}"\n`;
  for (const hook of ['post-commit', 'post-merge', 'post-applypatch']) {
    const hookPath = path.join(hooksDirectory, hook);
    await fs.writeFile(hookPath, body);
    await fs.chmod(hookPath, 0o700);
  }
  await git(directory, ['config', 'core.hooksPath', hooksDirectory]);
}

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'normalize-commit-date-'));
  const globalConfig = path.join(sandbox, 'gitconfig');
  await fs.writeFile(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('GIT_EDITOR', 'true');
  fixtureSequence = 0;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('normalizeHeadCommitDate', () => {
  it('normalizes a root commit and leaves it parentless', async () => {
    const repository = await initRepository('root');
    await commitFile(repository, 'a.txt', 'a\n', 'root subject');

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    await expectConforming(repository);
    expect(await git(repository, ['log', '-1', '--format=%P'])).toBe('');
  });

  it('keeps a non-root commit attached to its parent', async () => {
    const repository = await initRepository('parent');
    await commitFile(repository, 'a.txt', 'a\n', 'first');
    const parentSha = await git(repository, ['rev-parse', 'HEAD']);
    await commitFile(repository, 'b.txt', 'b\n', 'second');

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    expect(await git(repository, ['log', '-1', '--format=%P'])).toBe(parentSha);
  });

  it('preserves the author identity recorded on the commit', async () => {
    const repository = await initRepository('identity');
    await commitFile(repository, 'a.txt', 'a\n', 'subject');
    await git(repository, ['config', 'user.name', 'Someone Else']);
    await git(repository, ['config', 'user.email', 'other@example.invalid']);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    expect(await git(repository, ['log', '-1', '--format=%an <%ae>'])).toBe(
      'Test Person <test@example.invalid>'
    );
  });

  it('leaves an already conforming commit untouched', async () => {
    const repository = await initRepository('fixed-point');
    await commitFile(repository, 'a.txt', 'a\n', 'subject');
    await normalizeHeadCommitDate(repository);
    const sha = await git(repository, ['rev-parse', 'HEAD']);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('conforming');
    expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(sha);
  });

  // Cherry-picking an already-normalized commit carries its conforming author
  // stamp through and mints a fresh committer one, so the two stamps disagree
  // about conformity. Every other fixture makes them agree, which cannot tell a
  // check that reads every stamp from one that reads only the first or only the
  // author's — and the stamp such a check skips keeps a second-precision local
  // timestamp on a commit reported as already done.
  it('normalizes a commit whose author stamp conforms while its committer stamp does not', async () => {
    const repository = await initRepository('mixed-stamps');
    await commitFile(repository, 'base.txt', 'base\n', 'base');
    await git(repository, ['checkout', '-q', '-b', 'topic']);
    await commitFile(repository, 't.txt', 't\n', 'picked');
    await normalizeHeadCommitDate(repository);
    const picked = await git(repository, ['rev-parse', 'HEAD']);
    await git(repository, ['checkout', '-q', 'main']);
    await git(repository, ['cherry-pick', picked], undefined, fixtureDates().committer);
    const [authorBefore = '', committerBefore = ''] = await rawDates(repository);
    expect({
      author: isConforming(authorBefore),
      committer: isConforming(committerBefore),
    }).toEqual({ author: true, committer: false });

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    await expectConforming(repository);
  });

  it('skips a HEAD that is already reachable from a remote', async () => {
    const upstream = await initRepository('published-upstream');
    await commitFile(upstream, 'a.txt', 'a\n', 'upstream subject');
    const clone = path.join(sandbox, 'published-clone');
    await execa('git', ['clone', '-q', upstream, clone], { cwd: sandbox });
    const shaBefore = await git(clone, ['rev-parse', 'HEAD']);

    const outcome = await normalizeHeadCommitDate(clone);

    expect(outcome.status).toBe('published');
    expect(await git(clone, ['rev-parse', 'HEAD'])).toBe(shaBefore);
  });

  it('reports no commit when the repository has no HEAD', async () => {
    const repository = await initRepository('empty');

    expect(await normalizeHeadCommitDate(repository)).toEqual({ status: 'no-commit' });
  });

  // Presence and validity are asserted apart because verification alone cannot
  // tell them apart: it exits non-zero with empty output for a commit that
  // carries no signature at all, and writes text whenever a signature is there
  // but does not match. Reading the header first means a failure here names
  // which of the two broke instead of leaving the reader to guess.
  it('keeps an SSH-signed commit verifiable', async () => {
    const repository = await initRepository('signed');
    await configureSshSigning(repository);
    const dates = fixtureDates();
    await fs.writeFile(path.join(repository, 'a.txt'), 'a\n');
    await git(repository, ['add', 'a.txt']);
    await git(
      repository,
      ['commit', '-q', '-S', '-m', 'signed subject'],
      dates.author,
      dates.committer
    );

    await normalizeHeadCommitDate(repository);

    await expectConforming(repository);
    expect(await headerKeys(repository)).toContain('gpgsig');
    await expect(git(repository, ['verify-commit', 'HEAD'])).resolves.toBeDefined();
  });
});

/**
 * Everything the day-pinning rule decides, asserted on both rebuilds. The rule
 * has one implementation but two callers, and a case that ran only one of them
 * left the other free to disagree — which is what let a rewrite that stamped
 * every date with the author's day pass a green suite.
 */
describe.each(['unsigned', 'signed'] as const)('the %s rebuild', (rebuildPath) => {
  // Both rebuilds carry the message, by different means: one copies the bytes
  // inside the object it patches, the other hands them to `commit-tree`. A
  // message asserted on one path leaves the other free to reflow it, so this
  // runs on both, over everything a rebuild could quietly tidy — a
  // comment-shaped line, trailing whitespace, consecutive blanks, non-ASCII
  // bytes, and no newline at the end.
  it('preserves the commit message byte for byte', async () => {
    const repository = await repositoryOnPath('message', rebuildPath);
    const message =
      'subject line\n\n# comment shaped\nbody with `backticks`, $dollar and a\ttab   \n\n\nÜnïcode after two blanks\nTrailer: value\nno trailing newline';
    await fs.writeFile(path.join(repository, 'm.txt'), message);
    await fs.writeFile(path.join(repository, 'a.txt'), 'a\n');
    await git(repository, ['add', 'a.txt']);
    const signing = rebuildPath === 'signed' ? ['-S'] : [];
    await git(
      repository,
      ['commit', '-q', ...signing, '--cleanup=verbatim', '-F', 'm.txt'],
      fixtureDates().author
    );
    const before = await readMessageBytes(repository);
    expect(before.toString('utf8')).toBe(message);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    expect(Buffer.compare(await readMessageBytes(repository), before)).toBe(0);
  });

  it('truncates each date to the UTC day it already fell on', async () => {
    const repository = await repositoryOnPath('truncate', rebuildPath);
    await commitOnPath(repository, rebuildPath, fixtureDates());
    const [authorBefore = ''] = await rawDates(repository);

    await normalizeHeadCommitDate(repository);

    const [authorAfter = ''] = await rawDates(repository);
    expect(Number(authorAfter.split(' ')[0])).toBe(dayStartOf(authorBefore));
  });

  // Stamping both dates alike cannot tell a rewrite that keeps each stamp's own
  // day from one that applies a single day to both.
  it('gives the author and committer stamps their own separate days', async () => {
    const repository = await repositoryOnPath('split-days', rebuildPath);
    const dates = fixtureDates({ daysApart: 3 });
    await commitOnPath(repository, rebuildPath, dates);
    const [authorBefore = '', committerBefore = ''] = await rawDates(repository);

    await normalizeHeadCommitDate(repository);

    const [authorAfter = '', committerAfter = ''] = await rawDates(repository);
    const authorEpoch = Number(authorAfter.split(' ')[0]);
    const committerEpoch = Number(committerAfter.split(' ')[0]);
    expect(authorEpoch).toBe(dayStartOf(authorBefore));
    expect(committerEpoch).toBe(dayStartOf(committerBefore));
    expect(committerEpoch - authorEpoch).toBe(dates.gap);
  });

  // Both halves of the conforming predicate are load-bearing. A commit can
  // already sit on a day multiple and still disclose a location through its
  // rendered offset, and the idempotence check must not wave that through to
  // the push gate.
  it('normalizes a day-boundary epoch that is rendered at a non-UTC offset', async () => {
    const repository = await repositoryOnPath('offset-only', rebuildPath);
    await commitOnPath(repository, rebuildPath, fixtureDates({ epoch: 'day-start' }));
    const [authorBefore = ''] = await rawDates(repository);
    expect(Number(authorBefore.split(' ')[0]) % DAY_SECONDS).toBe(0);
    expect(authorBefore.split(' ')[1]).not.toBe('+0000');

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    await expectConforming(repository);
  });

  // The epoch sits inside the thousand-unit tolerance the millisecond carve-out
  // allows, which is the only place an exact day-multiple test and its tolerance
  // sibling disagree. A commit made in the first minutes of a UTC day is the
  // ordinary way to reach it, and a fixture reading the running clock would only
  // land here during those minutes.
  it('normalizes a UTC-rendered stamp minutes past the day boundary', async () => {
    const repository = await repositoryOnPath('epoch-only', rebuildPath);
    await commitOnPath(repository, rebuildPath, fixtureDates({ zone: 'utc', epoch: 'early-day' }));
    const [authorBefore = ''] = await rawDates(repository);
    const secondsIntoDay = Number(authorBefore.split(' ')[0]) % DAY_SECONDS;
    expect(authorBefore.split(' ')[1]).toBe('+0000');
    expect(secondsIntoDay).not.toBe(0);
    expect(secondsIntoDay).toBeLessThan(1000);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    await expectConforming(repository);
  });

  // Exactly half a day past the boundary and rendered at UTC — the only place a
  // whole-day multiple and a coarser fraction of a day disagree while the
  // offset half of the check is already satisfied. Every other fixture renders
  // east or west of UTC, so without this one a check that accepted half-days
  // would skip this commit silently and let a stamp finer than a day publish.
  it('normalizes a UTC-rendered stamp on the half-day boundary', async () => {
    const repository = await repositoryOnPath('half-day', rebuildPath);
    await commitOnPath(repository, rebuildPath, fixtureDates({ zone: 'utc', epoch: 'half-day' }));
    const [authorBefore = ''] = await rawDates(repository);
    expect(authorBefore.split(' ')[1]).toBe('+0000');
    expect(Number(authorBefore.split(' ')[0]) % DAY_SECONDS).toBe(DAY_SECONDS / 2);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    await expectConforming(repository);
  });

  // The stamp shape accepts either sign of offset. Fixtures east of UTC leave
  // the negative half of that band held only by whatever zone the runner happens
  // to sit in, so the west case is supplied rather than hoped for.
  it('normalizes a stamp rendered at an offset west of UTC', async () => {
    const repository = await repositoryOnPath('west-offset', rebuildPath);
    await commitOnPath(repository, rebuildPath, fixtureDates({ zone: 'west' }));
    const [authorBefore = ''] = await rawDates(repository);
    expect(authorBefore.split(' ')[1]).toMatch(/^-\d{4}$/);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    await expectConforming(repository);
  });

  // A stamp shape bounded to a fixed digit count would stop recognizing an older
  // epoch, and an unrecognized stamp line is carried through untouched rather
  // than refused — so the commit would be reported as normalized with a
  // second-precision date still on it. A rebase or a `git am` of an old patch
  // carries author dates this old.
  it('normalizes a commit whose author stamp predates the ten-digit epoch', async () => {
    const repository = await repositoryOnPath('short-epoch', rebuildPath);
    const old = fixtureDates({ dayStartMs: NINE_DIGIT_DAY_START_MS, epoch: 'day-start' });
    await commitOnPath(repository, rebuildPath, {
      author: old.author,
      committer: fixtureDates().committer,
      gap: 0,
    });
    const [authorBefore = ''] = await rawDates(repository);
    expect(authorBefore.split(' ')[0]).toHaveLength(9);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    await expectConforming(repository);
  });
});

describe('identity bytes', () => {
  const NON_ASCII_NAME = 'Ünïcode Näme';

  it('survives a clone that configures a log output encoding', async () => {
    const repository = await initRepository('log-encoding');
    await git(repository, ['config', 'user.name', NON_ASCII_NAME]);
    // Git re-encodes %an/%ae through this setting, so reading identity with
    // `git log --format` would hand back transcoded bytes.
    await git(repository, ['config', 'i18n.logOutputEncoding', 'ISO-8859-1']);
    await commitFile(repository, 'a.txt', 'a\n', 'subject');
    const before = await authorIdentityBytes(repository);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    expect(Buffer.compare(await authorIdentityBytes(repository), before)).toBe(0);
  });

  it('survives a commit that carries its own encoding header', async () => {
    const repository = await initRepository('commit-encoding');
    await git(repository, ['config', 'user.name', NON_ASCII_NAME]);
    await git(repository, ['config', 'i18n.commitEncoding', 'ISO-8859-1']);
    await commitFile(repository, 'a.txt', 'a\n', 'subject');
    const before = await authorIdentityBytes(repository);
    // Unset, so only the header on the commit itself can drive the rebuild.
    await git(repository, ['config', '--unset', 'i18n.commitEncoding']);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    expect(Buffer.compare(await authorIdentityBytes(repository), before)).toBe(0);
  });

  // The unsigned path claims to preserve identity by construction, and the
  // construction is the byte-transparent latin1 round trip of the header. Only
  // bytes that are not valid UTF-8 can tell that apart from a UTF-8 round trip.
  it('survives an unsigned rewrite when the bytes are not valid utf-8', async () => {
    const repository = await initRepository('latin1-unsigned');
    await commitFile(repository, 'a.txt', 'a\n', 'subject');
    await installRawCommit(repository, (lines) =>
      lines.map((line) => (line.startsWith('author ') ? line.replace('Test', 'Üest') : line))
    );
    const before = await authorIdentityBytes(repository);
    expect(before.toString('utf8')).toContain('�');

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    expect(Buffer.compare(await authorIdentityBytes(repository), before)).toBe(0);
  });

  it('survives an SSH-signed rewrite', async () => {
    const repository = await initRepository('signed-identity');
    await configureSshSigning(repository);
    await git(repository, ['config', 'user.name', NON_ASCII_NAME]);
    await fs.writeFile(path.join(repository, 'a.txt'), 'a\n');
    await git(repository, ['add', 'a.txt']);
    await git(repository, ['commit', '-q', '-S', '-m', 'subject'], fixtureDates().author);
    const before = await authorIdentityBytes(repository);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    expect(Buffer.compare(await authorIdentityBytes(repository), before)).toBe(0);
  });
});

describe('commit headers', () => {
  it('carries the encoding header through the rewrite', async () => {
    const repository = await initRepository('encoding-header');
    await git(repository, ['config', 'i18n.commitEncoding', 'ISO-8859-1']);
    await commitFile(repository, 'a.txt', 'a\n', 'subject');
    expect(await headerKeys(repository)).toContain('encoding');
    // Unset, so a rebuild that re-derived the header from config rather than
    // carrying the commit's own would drop it here.
    await git(repository, ['config', '--unset', 'i18n.commitEncoding']);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    expect(await headerKeys(repository)).toContain('encoding');
  });

  it('refuses a commit carrying a header it does not recognize', async () => {
    const repository = await initRepository('mergetag');
    await commitFile(repository, 'a.txt', 'a\n', 'subject');
    await installRawCommit(repository, (lines) => [...lines, 'mergetag object 0000']);
    const shaBefore = await git(repository, ['rev-parse', 'HEAD']);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome).toMatchObject({ status: 'refused', reason: 'unrecognized-header' });
    expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(shaBefore);
  });

  it('carries the encoding header and parents through a signed rewrite', async () => {
    const repository = await initRepository('signed-encoding');
    await configureSshSigning(repository);
    await git(repository, ['config', 'i18n.commitEncoding', 'ISO-8859-1']);
    await commitFile(repository, 'a.txt', 'a\n', 'base');
    const parentSha = await git(repository, ['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(repository, 'b.txt'), 'b\n');
    await git(repository, ['add', 'b.txt']);
    await git(repository, ['commit', '-q', '-S', '-m', 'child'], fixtureDates().author);
    await git(repository, ['config', '--unset', 'i18n.commitEncoding']);

    await normalizeHeadCommitDate(repository);

    expect(await headerKeys(repository)).toContain('encoding');
    expect(await git(repository, ['log', '-1', '--format=%P'])).toBe(parentSha);
    await expectConforming(repository);
  });

  it('refuses a signed commit whose identity bytes are not valid utf-8', async () => {
    const repository = await initRepository('latin1-identity');
    await configureSshSigning(repository);
    await fs.writeFile(path.join(repository, 'a.txt'), 'a\n');
    await git(repository, ['add', 'a.txt']);
    await git(repository, ['commit', '-q', '-S', '-m', 'subject'], fixtureDates().author);
    // A lone high byte is valid latin1 and invalid utf-8, so it cannot round
    // trip through the environment the signing rebuild has to use.
    await installRawCommit(repository, (lines) =>
      lines.map((line) => (line.startsWith('author ') ? line.replace('Test', 'Üest') : line))
    );
    const shaBefore = await git(repository, ['rev-parse', 'HEAD']);

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome).toMatchObject({
      status: 'refused',
      reason: 'unrepresentable-identity',
      detail: 'author or committer',
    });
    expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(shaBefore);
  });

  // Both formats git recognizes besides ssh, because the refusal is a test
  // against one name rather than a list: a check pinned at a single member
  // reads the same as one that admits every other name that happens to sort
  // below it, and each of these signature formats seals a second-precision
  // creation time the rewrite exists to remove.
  it.each(['openpgp', 'x509'])(
    'refuses a signed commit whose signature format is %s',
    async (format) => {
      const repository = await initRepository(format);
      await configureSshSigning(repository);
      await fs.writeFile(path.join(repository, 'a.txt'), 'a\n');
      await git(repository, ['add', 'a.txt']);
      await git(repository, ['commit', '-q', '-S', '-m', 'subject'], fixtureDates().author);
      await git(repository, ['config', 'gpg.format', format]);
      const shaBefore = await git(repository, ['rev-parse', 'HEAD']);

      const outcome = await normalizeHeadCommitDate(repository);

      expect(outcome).toMatchObject({
        status: 'refused',
        reason: 'non-ssh-signature',
        detail: format,
      });
      expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(shaBefore);
    }
  );
});

describe('the containment guard', () => {
  async function upstreamWithSecondCommit(): Promise<string> {
    const upstream = await initRepository('url-upstream');
    await commitFile(upstream, 'a.txt', 'a\n', 'first');
    return upstream;
  }

  it('skips an upstream commit pulled by url rather than by remote name', async () => {
    const upstream = await upstreamWithSecondCommit();
    const clone = await initRepository('url-clone');
    await git(clone, ['remote', 'add', 'origin', upstream]);
    await git(clone, ['fetch', '-q', 'origin']);
    await git(clone, ['checkout', '-q', '-b', 'main', '--track', 'origin/main']);
    await commitFile(upstream, 'b.txt', 'b\n', 'second');
    // Pulling by path updates no remote-tracking ref, so `--remotes` alone does
    // not see this commit as published.
    await git(clone, ['pull', '-q', upstream, 'main']);
    const shaBefore = await git(clone, ['rev-parse', 'HEAD']);

    const outcome = await normalizeHeadCommitDate(clone);

    expect(outcome.status).toBe('published');
    expect(await git(clone, ['rev-parse', 'HEAD'])).toBe(shaBefore);
  });

  it('still normalizes a local commit while FETCH_HEAD is set', async () => {
    const upstream = await upstreamWithSecondCommit();
    const clone = await initRepository('fetchhead-clone');
    await git(clone, ['remote', 'add', 'origin', upstream]);
    await git(clone, ['fetch', '-q', 'origin']);
    await git(clone, ['checkout', '-q', '-b', 'main', '--track', 'origin/main']);
    await commitFile(clone, 'local.txt', 'local\n', 'local work');
    await git(clone, ['fetch', '-q', upstream, 'main']);

    const outcome = await normalizeHeadCommitDate(clone);

    expect(outcome.status).toBe('normalized');
    await expectConforming(clone);
  });
});

describe('describeOutcome', () => {
  it('names the rewritten sha and the recovery command', () => {
    const line = describeOutcome({ status: 'normalized', sha: 'abc123', previousSha: 'def456' });

    expect(line).toContain('abc123');
    expect(line).toContain('git update-ref HEAD def456 abc123');
  });

  // A recovery command printed after every commit is an instruction, not
  // advice, so it has to be no wider than the harm it repairs. The rewrite
  // moves one reference under an expected-value fence and leaves the tree
  // header of the commit unchanged, so nothing in the index or the working
  // tree ever needs restoring; a command that also restored them would throw
  // away work the rewrite never touched, with no reflog to recover it.
  it('prints a recovery command that only moves the reference back', async () => {
    const repository = await initRepository('recovery');
    await commitFile(repository, 'a.txt', 'a\n', 'subject');
    const shaBefore = await git(repository, ['rev-parse', 'HEAD']);
    await fs.writeFile(path.join(repository, 'staged.txt'), 'staged\n');
    await git(repository, ['add', 'staged.txt']);
    await fs.writeFile(path.join(repository, 'a.txt'), 'a\nunstaged\n');
    await fs.writeFile(path.join(repository, 'untracked.txt'), 'untracked\n');

    const outcome = await normalizeHeadCommitDate(repository);

    expect(outcome.status).toBe('normalized');
    expect(await runPrintedRecovery(repository, describeOutcome(outcome))).toBe(0);
    expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(shaBefore);
    expect(await git(repository, ['status', '--porcelain'])).toBe(
      [' M a.txt', 'A  staged.txt', '?? untracked.txt'].join('\n')
    );
  });

  // The fence is the safety property of the printed line, and it holds only
  // because both sides of it are object names the rewrite itself produced: a
  // reference resolves at the moment the command runs, so a reference in the
  // expected-value position always equals what it is compared against and can
  // never refuse. Pasted later, that shape moves whatever the reference has
  // become onto whatever preceded it.
  it('refuses to move the reference once it has moved on', async () => {
    const repository = await initRepository('recovery-moved-on');
    await commitFile(repository, 'a.txt', 'a\n', 'subject');
    const printed = describeOutcome(await normalizeHeadCommitDate(repository));
    await commitFile(repository, 'b.txt', 'b\n', 'later work');
    const tip = await git(repository, ['rev-parse', 'HEAD']);

    expect(await runPrintedRecovery(repository, printed)).not.toBe(0);

    expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(tip);
  });

  it('refuses a second paste rather than re-applying the rewrite', async () => {
    const repository = await initRepository('recovery-twice');
    await commitFile(repository, 'a.txt', 'a\n', 'subject');
    const shaBefore = await git(repository, ['rev-parse', 'HEAD']);
    const printed = describeOutcome(await normalizeHeadCommitDate(repository));
    expect(await runPrintedRecovery(repository, printed)).toBe(0);

    expect(await runPrintedRecovery(repository, printed)).not.toBe(0);

    expect(await git(repository, ['rev-parse', 'HEAD'])).toBe(shaBefore);
  });

  it('says nothing when no rewrite happened', () => {
    expect(describeOutcome({ status: 'published' })).toBeNull();
  });

  it('names what a refusal was about and that the commit stands', () => {
    const line = describeOutcome({
      status: 'refused',
      reason: 'unrecognized-header',
      detail: 'mergetag',
    });

    expect(line).toContain('mergetag');
    expect(line).toContain('stands as written');
  });
});

describe('the installed hooks', () => {
  it('leaves every commit of a three-commit rebase conforming', async () => {
    const repository = await initRepository('rebase');
    await commitFile(repository, 'base.txt', 'base\n', 'base');
    await git(repository, ['checkout', '-q', '-b', 'topic']);
    await commitFile(repository, 't1.txt', 't1\n', 'topic one');
    await commitFile(repository, 't2.txt', 't2\n', 'topic two');
    await commitFile(repository, 't3.txt', 't3\n', 'topic three');
    await git(repository, ['checkout', '-q', 'main']);
    await commitFile(repository, 'main.txt', 'main\n', 'main moves on');
    await git(repository, ['checkout', '-q', 'topic']);
    await installHooks(repository);

    await git(repository, ['rebase', 'main']);

    for (const revision of ['HEAD', 'HEAD~1', 'HEAD~2']) {
      await expectConforming(repository, revision);
    }
  });

  it('leaves a conflicted rebase resumed with --continue conforming', async () => {
    const repository = await initRepository('conflict');
    await commitFile(repository, 'shared.txt', 'base\n', 'base');
    await git(repository, ['checkout', '-q', '-b', 'topic']);
    await commitFile(repository, 'shared.txt', 'topic\n', 'topic edit');
    await git(repository, ['checkout', '-q', 'main']);
    await commitFile(repository, 'shared.txt', 'main\n', 'main edit');
    await git(repository, ['checkout', '-q', 'topic']);
    const mainSha = await git(repository, ['rev-parse', 'main']);
    await installHooks(repository);

    await expect(git(repository, ['rebase', 'main'])).rejects.toThrow();
    await fs.writeFile(path.join(repository, 'shared.txt'), 'resolved\n');
    await git(repository, ['add', 'shared.txt']);
    await git(repository, ['rebase', '--continue']);

    await expectConforming(repository);
    expect(await git(repository, ['log', '-1', '--format=%P'])).toBe(mainSha);
  });

  it('leaves a no-ff merge commit conforming with both parents', async () => {
    const repository = await initRepository('merge');
    await commitFile(repository, 'base.txt', 'base\n', 'base');
    await git(repository, ['checkout', '-q', '-b', 'topic']);
    await commitFile(repository, 't.txt', 't\n', 'topic');
    await git(repository, ['checkout', '-q', 'main']);
    await commitFile(repository, 'm.txt', 'm\n', 'main');
    const mainSha = await git(repository, ['rev-parse', 'main']);
    const topicSha = await git(repository, ['rev-parse', 'topic']);
    await installHooks(repository);

    await git(repository, ['merge', '--no-ff', '--no-edit', 'topic']);

    await expectConforming(repository);
    expect(await git(repository, ['log', '-1', '--format=%P'])).toBe(`${mainSha} ${topicSha}`);
  });

  // The divergence assertion alone would also hold if the hook never ran, so the
  // second half proves the same live hook normalizes what it does own.
  it('leaves a fast-forward pull at zero divergence yet still normalizes local commits', async () => {
    const upstream = await initRepository('pull-upstream');
    await commitFile(upstream, 'a.txt', 'a\n', 'first');
    const clone = path.join(sandbox, 'pull-clone');
    await execa('git', ['clone', '-q', upstream, clone], { cwd: sandbox });
    await git(clone, ['config', 'user.name', 'Test Person']);
    await git(clone, ['config', 'user.email', 'test@example.invalid']);
    await commitFile(upstream, 'b.txt', 'b\n', 'second');
    await installHooks(clone);

    await git(clone, ['pull', '-q', 'origin', 'main']);

    expect(await git(clone, ['rev-parse', 'HEAD'])).toBe(
      await git(upstream, ['rev-parse', 'HEAD'])
    );
    expect(await git(clone, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).toBe('0');
    await commitFile(clone, 'c.txt', 'c\n', 'local');
    await expectConforming(clone);
  });

  it('leaves a commit applied by git am conforming', async () => {
    const source = await initRepository('am-source');
    await commitFile(source, 'a.txt', 'a\n', 'base');
    await commitFile(source, 'b.txt', 'b\n', 'patched subject');
    await git(source, ['format-patch', '-1', '-o', path.join(sandbox, 'patches')]);
    const target = await initRepository('am-target');
    await commitFile(target, 'a.txt', 'a\n', 'base');
    await installHooks(target);
    const [patch = ''] = await fs.readdir(path.join(sandbox, 'patches'));

    await git(target, ['am', path.join(sandbox, 'patches', patch)]);

    await expectConforming(target);
    expect(await git(target, ['log', '-1', '--format=%s'])).toBe('patched subject');
  });
});

// These run the hook files that actually ship, through husky's own dispatcher,
// in a repository laid out like a real clone — so they pin what no assertion
// about the hook's text can: that the command it names is reachable on husky's
// PATH and that its script path resolves from the working directory git hands a
// hook.
describe('the tracked husky hooks', () => {
  it('normalizes a plain commit through post-commit', async () => {
    const repository = await makeCloneShapedRepository('tracked-commit');

    await commitFile(repository, 'a.txt', 'a\n', 'subject');

    await expectConforming(repository);
  });

  it('normalizes a no-ff merge through post-merge', async () => {
    const repository = await makeCloneShapedRepository('tracked-merge');
    await commitFile(repository, 'base.txt', 'base\n', 'base');
    await git(repository, ['checkout', '-q', '-b', 'topic']);
    await commitFile(repository, 't.txt', 't\n', 'topic');
    await git(repository, ['checkout', '-q', 'main']);
    await commitFile(repository, 'm.txt', 'm\n', 'main');

    await git(repository, ['merge', '--no-ff', '--no-edit', 'topic']);

    await expectConforming(repository);
    expect(await git(repository, ['log', '-1', '--format=%P'])).toContain(' ');
  });

  it('normalizes an applied patch through post-applypatch', async () => {
    const source = await initRepository('tracked-am-source');
    await commitFile(source, 'a.txt', 'a\n', 'base');
    await commitFile(source, 'b.txt', 'b\n', 'patched subject');
    const patches = path.join(sandbox, 'tracked-patches');
    await git(source, ['format-patch', '-1', '-o', patches]);
    const repository = await makeCloneShapedRepository('tracked-am');
    await commitFile(repository, 'a.txt', 'a\n', 'base');
    const [patch = ''] = await fs.readdir(patches);

    await git(repository, ['am', path.join(patches, patch)]);

    await expectConforming(repository);
    expect(await git(repository, ['log', '-1', '--format=%s'])).toBe('patched subject');
  });
});

/**
 * Runs the command the tool printed, exactly as a developer pasting the line
 * would — so what this exercises is the shipped text rather than a restatement
 * of it.
 */
async function runPrintedRecovery(
  directory: string,
  line: string | null
): Promise<number | undefined> {
  const [, command = ''] = (line ?? '').split('undo with: ');
  const [binary = '', ...args] = command.trim().split(' ');
  const { exitCode } = await execa(binary, args, { cwd: directory, reject: false });
  return exitCode;
}

async function readMessageBytes(directory: string): Promise<Buffer> {
  const { stdout } = await execa('git', ['cat-file', 'commit', 'HEAD'], {
    cwd: directory,
    encoding: 'buffer',
    stripFinalNewline: false,
  });
  const raw = Buffer.from(stdout);
  return raw.subarray(raw.indexOf('\n\n') + 2);
}
