import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execa } from 'execa';
import { TEST_DAY_START, DAY_MS } from '@hushbox/shared/test-time';
import {
  CONSTANTS_PATH,
  LEGAL_DOCUMENTS,
  legalEffectiveDates,
  main,
  revisionIn,
} from './legal-effective-dates.js';
import { claimRef } from './lib/release-references.js';

let sandbox: string;

/** The UTC day an instant falls on, as the answers themselves are rendered. */
function dayOf(instantMs: number): string {
  return new Date(instantMs).toISOString().slice(0, 10);
}

/** A fixture commit's instant: whole UTC days from the shared frozen instant. */
function dayStart(index: number): number {
  return TEST_DAY_START + index * DAY_MS;
}

/** When a fixture commit was authored and when it was committed, as git records them. */
interface CommitStamps {
  readonly authored: string;
  readonly committed: string;
}

/** Both of a commit's dates on the UTC day `dayIndex` names, which is the ordinary case. */
function onDay(dayIndex: number): CommitStamps {
  const instant = new Date(dayStart(dayIndex)).toISOString();
  return { authored: instant, committed: instant };
}

async function git(
  directory: string,
  args: readonly string[],
  stamps?: CommitStamps
): Promise<string> {
  const dates =
    stamps === undefined
      ? {}
      : { GIT_AUTHOR_DATE: stamps.authored, GIT_COMMITTER_DATE: stamps.committed };
  const { stdout } = await execa('git', [...args], { cwd: directory, env: dates });
  return stdout;
}

/**
 * The shape the derivation parses out of a tag: the published constants file as
 * this repository writes it, carrying whichever revisions the case needs.
 */
function constantsSource(revisions: { readonly privacy: number; readonly terms: number }): string {
  return [
    "export const PRIVACY_POLICY_EFFECTIVE_DATE = '2026-01-01';",
    `export const PRIVACY_POLICY_REVISION = ${String(revisions.privacy)};`,
    `export const TERMS_OF_SERVICE_REVISION = ${String(revisions.terms)};`,
    '',
  ].join('\n');
}

/** A constants file from before either revision constant existed. */
const CONSTANTS_WITHOUT_REVISIONS = "export const PRIVACY_POLICY_EFFECTIVE_DATE = '2026-01-01';\n";

async function initRepository(name: string): Promise<string> {
  const directory = path.join(sandbox, name);
  await fs.mkdir(directory, { recursive: true });
  await git(directory, ['init', '-q', '-b', 'main']);
  await git(directory, ['config', 'user.name', 'Test Person']);
  await git(directory, ['config', 'user.email', 'test@example.invalid']);
  return directory;
}

/** Puts `source` at the constants path in the working tree, uncommitted. */
async function writeConstants(repository: string, source: string): Promise<void> {
  const file = path.join(repository, ...CONSTANTS_PATH.split('/'));
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, source);
}

/**
 * Commits `source` at the constants path, on the UTC day `dayIndex` names —
 * unless `stamps` puts the two dates of the commit on different days.
 */
async function commitConstants(
  repository: string,
  source: string,
  dayIndex: number,
  stamps: CommitStamps = onDay(dayIndex)
): Promise<void> {
  await writeConstants(repository, source);
  // Every release moves something, whether or not it moves the legal copy, and a
  // commit whose tree matches its parent's is not a commit git will make.
  await fs.writeFile(path.join(repository, 'release.txt'), String(dayIndex));
  await git(repository, ['add', '.']);
  await git(repository, ['commit', '-q', '-m', 'constants'], stamps);
}

async function tagHead(repository: string, name: string): Promise<void> {
  await git(repository, ['tag', name]);
}

/** The answers keyed by the output each document publishes them under. */
async function datesFrom(repository: string, nowMs: number): Promise<Record<string, string>> {
  const resolved = await legalEffectiveDates({
    repositoryRoot: repository,
    now: new Date(nowMs),
  });
  return Object.fromEntries(resolved.map((entry) => [entry.output, entry.date]));
}

const PRIVACY = 'privacy_policy_effective_date';
const TERMS = 'terms_of_service_effective_date';

beforeEach(async () => {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'legal-effective-dates-'));
  const globalConfig = path.join(sandbox, 'gitconfig');
  await fs.writeFile(globalConfig, '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig);
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await fs.rm(sandbox, { recursive: true, force: true });
});

describe('revisionIn', () => {
  it('reads the integer a constants file declares', () => {
    expect(revisionIn(constantsSource({ privacy: 4, terms: 7 }), 'PRIVACY_POLICY_REVISION')).toBe(
      4
    );
  });

  it('reads each document independently', () => {
    expect(revisionIn(constantsSource({ privacy: 4, terms: 7 }), 'TERMS_OF_SERVICE_REVISION')).toBe(
      7
    );
  });

  it('answers null for a file that declares no such constant', () => {
    expect(revisionIn(CONSTANTS_WITHOUT_REVISIONS, 'PRIVACY_POLICY_REVISION')).toBeNull();
  });

  it('answers null for a declaration whose value is not a whole number', () => {
    expect(
      revisionIn('export const PRIVACY_POLICY_REVISION = 1.5;\n', 'PRIVACY_POLICY_REVISION')
    ).toBeNull();
  });

  it('answers null for a declaration written with a numeric separator', () => {
    expect(
      revisionIn('export const PRIVACY_POLICY_REVISION = 1_0;\n', 'PRIVACY_POLICY_REVISION')
    ).toBeNull();
  });

  it('answers null for a declaration written in exponent notation', () => {
    expect(
      revisionIn('export const PRIVACY_POLICY_REVISION = 2e3;\n', 'PRIVACY_POLICY_REVISION')
    ).toBeNull();
  });

  it('does not read a constant whose name merely ends with the one asked for', () => {
    expect(
      revisionIn('export const OLD_PRIVACY_POLICY_REVISION = 9;\n', 'PRIVACY_POLICY_REVISION')
    ).toBeNull();
  });
});

describe('the documents it answers for', () => {
  it('names both published legal documents and nothing else', () => {
    expect(LEGAL_DOCUMENTS.map((document) => document.output)).toEqual([PRIVACY, TERMS]);
  });
});

describe('legalEffectiveDates', () => {
  it('answers today when the repository carries no release tag at all', async () => {
    const repository = await initRepository('no-tags');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);

    expect(await datesFrom(repository, dayStart(9))).toEqual({
      [PRIVACY]: dayOf(dayStart(9)),
      [TERMS]: dayOf(dayStart(9)),
    });
  });

  it('answers the day of the release that first shipped the revision', async () => {
    const repository = await initRepository('already-shipped');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    await commitConstants(repository, constantsSource({ privacy: 2, terms: 2 }), 3);
    await tagHead(repository, 'v1.0.1');

    expect(await datesFrom(repository, dayStart(9))).toEqual({
      [PRIVACY]: dayOf(dayStart(3)),
      [TERMS]: dayOf(dayStart(3)),
    });
  });

  it('answers the day the release commit landed, not the day it was authored', async () => {
    const repository = await initRepository('rebased-release');
    // A release commit authored six weeks before it landed, which is what a
    // rebase or a cherry-pick leaves behind. The authoring day is when someone
    // wrote the copy; the day the document became visible is the day the commit
    // the release tags reached the branch.
    const authored = 0;
    const landed = 42;
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), landed, {
      authored: new Date(dayStart(authored)).toISOString(),
      committed: new Date(dayStart(landed)).toISOString(),
    });
    await tagHead(repository, 'v1.0.0');

    expect(await datesFrom(repository, dayStart(50))).toEqual({
      [PRIVACY]: dayOf(dayStart(landed)),
      [TERMS]: dayOf(dayStart(landed)),
    });
  });

  it('keeps the first release that shipped the revision when a later release ships it again', async () => {
    const repository = await initRepository('unbumped');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    await commitConstants(repository, constantsSource({ privacy: 2, terms: 2 }), 3);
    await tagHead(repository, 'v1.0.1');
    await commitConstants(repository, constantsSource({ privacy: 2, terms: 2 }), 6);
    await tagHead(repository, 'v1.0.2');

    expect(await datesFrom(repository, dayStart(9))).toEqual({
      [PRIVACY]: dayOf(dayStart(3)),
      [TERMS]: dayOf(dayStart(3)),
    });
  });

  it('orders releases by version, so the tenth patch is later than the ninth', async () => {
    const repository = await initRepository('two-digit-patch');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.8');
    await commitConstants(repository, constantsSource({ privacy: 2, terms: 2 }), 3);
    await tagHead(repository, 'v1.0.9');
    await commitConstants(repository, constantsSource({ privacy: 2, terms: 2 }), 6);
    // Sorted as text, this tag precedes the one before it, so a walk ordered
    // that way answers with this release rather than the one that shipped first.
    await tagHead(repository, 'v1.0.10');

    expect(await datesFrom(repository, dayStart(9))).toEqual({
      [PRIVACY]: dayOf(dayStart(3)),
      [TERMS]: dayOf(dayStart(3)),
    });
  });

  it('passes over a v-prefixed tag that is not a release, so a pre-release cannot answer', async () => {
    const repository = await initRepository('pre-release-tag');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    await commitConstants(repository, constantsSource({ privacy: 2, terms: 2 }), 3);
    // A candidate build, not a release: the workflow tags three numbers and
    // nothing else, and the day a candidate was cut is not a day anything was
    // published. Only the shape filter keeps it out of the walk.
    await tagHead(repository, 'v1.1.0-rc1');
    await writeConstants(repository, constantsSource({ privacy: 2, terms: 2 }));

    expect(await datesFrom(repository, dayStart(9))).toEqual({
      [PRIVACY]: dayOf(dayStart(9)),
      [TERMS]: dayOf(dayStart(9)),
    });
  });

  it('answers per document, so a bump to one leaves the other on its own release', async () => {
    const repository = await initRepository('bumped');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    await commitConstants(repository, constantsSource({ privacy: 2, terms: 1 }), 3);
    await tagHead(repository, 'v1.0.1');
    await writeConstants(repository, constantsSource({ privacy: 3, terms: 1 }));

    expect(await datesFrom(repository, dayStart(9))).toEqual({
      [PRIVACY]: dayOf(dayStart(9)),
      [TERMS]: dayOf(dayStart(0)),
    });
  });

  it('passes over a release from before the constants file existed', async () => {
    const repository = await initRepository('older-than-the-file');
    await fs.writeFile(path.join(repository, 'release.txt'), 'first');
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '-q', '-m', 'first'], onDay(0));
    await tagHead(repository, 'v1.0.0');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 3);
    await tagHead(repository, 'v1.0.1');

    expect(await datesFrom(repository, dayStart(9))).toEqual({
      [PRIVACY]: dayOf(dayStart(3)),
      [TERMS]: dayOf(dayStart(3)),
    });
  });

  it('answers today for a revision no release tag has shipped yet', async () => {
    const repository = await initRepository('first-ship');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    await writeConstants(repository, constantsSource({ privacy: 2, terms: 2 }));

    expect(await datesFrom(repository, dayStart(9))).toEqual({
      [PRIVACY]: dayOf(dayStart(9)),
      [TERMS]: dayOf(dayStart(9)),
    });
  });

  // A claim reserves a number for a deploy that may never ship, so the commit it
  // names has not been visible to anyone yet.
  it('answers today for a revision only a version claim carries', async () => {
    const repository = await initRepository('claimed-only');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    await commitConstants(repository, constantsSource({ privacy: 2, terms: 2 }), 3);
    await git(repository, ['update-ref', claimRef('1.0.1'), 'HEAD']);

    expect(await datesFrom(repository, dayStart(9))).toEqual({
      [PRIVACY]: dayOf(dayStart(9)),
      [TERMS]: dayOf(dayStart(9)),
    });
  });
});

describe('a history it cannot read', () => {
  it('refuses a release tag that names no commit, rather than answering today', async () => {
    const repository = await initRepository('broken-tag');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    await fs.writeFile(
      path.join(repository, '.git', 'refs', 'tags', 'v1.0.1'),
      `${'0'.repeat(39)}1\n`
    );

    await expect(datesFrom(repository, dayStart(9))).rejects.toThrow('v1.0.1');
  });

  it('refuses a release whose tree cannot be read, rather than answering today', async () => {
    const repository = await initRepository('unreadable-tree');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    const tree = await git(repository, ['rev-parse', 'HEAD^{tree}']);
    await fs.rm(path.join(repository, '.git', 'objects', tree.slice(0, 2), tree.slice(2)));

    await expect(datesFrom(repository, dayStart(9))).rejects.toThrow('could not be read');
  });

  it('refuses a committed constants file git cannot produce, rather than answering today', async () => {
    const repository = await initRepository('unreadable-blob');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    const blob = await git(repository, ['rev-parse', `HEAD:${CONSTANTS_PATH}`]);
    await fs.rm(path.join(repository, '.git', 'objects', blob.slice(0, 2), blob.slice(2)));

    await expect(datesFrom(repository, dayStart(9))).rejects.toThrow(CONSTANTS_PATH);
  });

  it('refuses a release tag whose reference is empty, rather than answering today', async () => {
    const repository = await initRepository('empty-tag-ref');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    await fs.writeFile(path.join(repository, '.git', 'refs', 'tags', 'v1.0.0'), '');

    await expect(datesFrom(repository, dayStart(9))).rejects.toThrow('broken ref');
  });

  it('refuses a release tag whose reference is not a hash, rather than answering today', async () => {
    const repository = await initRepository('garbage-tag-ref');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    await fs.writeFile(path.join(repository, '.git', 'refs', 'tags', 'v1.0.0'), 'not-a-hash\n');

    await expect(datesFrom(repository, dayStart(9))).rejects.toThrow('broken ref');
  });

  it('refuses a directory whose tags cannot be listed, rather than answering today', async () => {
    const outsideGit = path.join(sandbox, 'not-a-repository');
    await fs.mkdir(outsideGit, { recursive: true });
    await writeConstants(outsideGit, constantsSource({ privacy: 1, terms: 1 }));

    // The clause only this refusal produces. A word both refusals at that seam
    // share would pass for the other one and leave this guard unpinned.
    await expect(datesFrom(outsideGit, dayStart(9))).rejects.toThrow('could not be listed');
  });

  it('names the spawn failure when the version-control binary cannot be run at all', async () => {
    const repository = await initRepository('no-git-binary');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    // Nothing on the search path, so git never runs and writes nothing to
    // standard error: the spawn failure's own words are the only cause there is.
    vi.stubEnv('PATH', '');

    await expect(datesFrom(repository, dayStart(9))).rejects.toThrow('ENOENT');
  });

  it('refuses when the working tree carries no constants file, rather than answering today', async () => {
    const repository = await initRepository('no-constants-file');
    await fs.writeFile(path.join(repository, 'release.txt'), 'first');
    await git(repository, ['add', '.']);
    await git(repository, ['commit', '-q', '-m', 'first'], onDay(0));

    // The clause only the read's own refusal produces. Naming the file alone
    // would pass for the revision guard below, which names it too.
    await expect(datesFrom(repository, dayStart(9))).rejects.toThrow(
      `${CONSTANTS_PATH} could not be read`
    );
  });

  it('refuses a working tree revision that is not a whole number, rather than answering an old release day', async () => {
    const repository = await initRepository('fractional-revision');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    // A declaration a TypeScript file can really carry: it compiles, and no
    // other gate in this repository constrains the constant's shape.
    await writeConstants(
      repository,
      'export const PRIVACY_POLICY_REVISION = 1.5;\nexport const TERMS_OF_SERVICE_REVISION = 1;\n'
    );

    await expect(datesFrom(repository, dayStart(9))).rejects.toThrow('PRIVACY_POLICY_REVISION');
  });

  it('quotes the declaration when a revision line carries a trailing comment', async () => {
    const repository = await initRepository('commented-revision');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    await writeConstants(
      repository,
      'export const PRIVACY_POLICY_REVISION = 1; // bumped with the retention section\nexport const TERMS_OF_SERVICE_REVISION = 1;\n'
    );

    await expect(datesFrom(repository, dayStart(9))).rejects.toThrow(
      '1; // bumped with the retention section'
    );
  });

  it('states the shape it requires when a revision line carries a trailing comment', async () => {
    const repository = await initRepository('commented-revision-shape');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    await writeConstants(
      repository,
      'export const PRIVACY_POLICY_REVISION = 1; // bumped with the retention section\nexport const TERMS_OF_SERVICE_REVISION = 1;\n'
    );

    await expect(datesFrom(repository, dayStart(9))).rejects.toThrow(
      'must be digits and the closing semicolon'
    );
  });

  it('refuses when the working tree declares no revision, rather than answering today', async () => {
    const repository = await initRepository('no-revision');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    // One document's revision, not the other's: the refusal must name the one
    // that is missing rather than stopping at the first document it looks at.
    await writeConstants(repository, 'export const PRIVACY_POLICY_REVISION = 1;\n');

    await expect(datesFrom(repository, dayStart(9))).rejects.toThrow(
      'declares no TERMS_OF_SERVICE_REVISION'
    );
  });
});

describe('two runs over the same repository', () => {
  it('answer the same thing, and answer it from the release rather than from today', async () => {
    const repository = await initRepository('deterministic');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    await commitConstants(repository, constantsSource({ privacy: 2, terms: 2 }), 3);
    await tagHead(repository, 'v1.0.1');

    const first = await datesFrom(repository, dayStart(9));
    const second = await datesFrom(repository, dayStart(11));

    expect([first, second]).toEqual([
      { [PRIVACY]: dayOf(dayStart(3)), [TERMS]: dayOf(dayStart(3)) },
      { [PRIVACY]: dayOf(dayStart(3)), [TERMS]: dayOf(dayStart(3)) },
    ]);
  });
});

describe('main', () => {
  it("writes each document's answer where the release workflow reads its values", async () => {
    const repository = await initRepository('published');
    await commitConstants(repository, constantsSource({ privacy: 1, terms: 1 }), 0);
    await tagHead(repository, 'v1.0.0');
    const output = path.join(sandbox, 'github-output');
    await fs.writeFile(output, '');
    vi.stubEnv('GITHUB_OUTPUT', output);
    const printed = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main({ repositoryRoot: repository, now: new Date(dayStart(9)) });
    printed.mockRestore();

    expect(await fs.readFile(output, 'utf8')).toBe(
      `${PRIVACY}=${dayOf(dayStart(0))}\n${TERMS}=${dayOf(dayStart(0))}\n`
    );
  });
});
