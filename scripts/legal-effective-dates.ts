/**
 * The effective date each published legal document carries, derived rather than
 * typed: the date of the earliest release tag whose commit already declared the
 * revision the working tree declares now, and today when no release has shipped
 * that revision yet.
 *
 * A human raises the revision integer when a change to the document's copy is
 * substantive, and that judgement is the only human input. No date is authored
 * anywhere — by a person or by this module — because a date typed at edit time
 * is a prediction about when the text will be visible, and no machine can tell a
 * typo fix from a substantive change.
 *
 * A revision is read out of a tag as a committed STRING. Nothing here loads,
 * imports or evaluates a file from an old commit: the answer must not depend on
 * running code from an arbitrary past revision of this repository.
 *
 * Every way of failing to read the history fails loudly. A repository whose tags
 * cannot be read has not established that no release carries the revision, so
 * answering today there would publish a date on the strength of an unanswered
 * question.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { execa } from 'execa';

import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { RELEASE_TAG } from './lib/release-references.js';
import { writeGithubOutput } from './extract-version.js';

/** Where both revision constants are declared, repository-relative, in git's spelling. */
export const CONSTANTS_PATH = 'packages/shared/src/constants.ts';

/** One published legal document, as this derivation needs to know it. */
export interface LegalDocument {
  /** The constant whose integer a human raises when the copy changes substantively. */
  readonly revisionConstant: string;
  /** The name this document's answer is published under. */
  readonly output: string;
}

export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  { revisionConstant: 'PRIVACY_POLICY_REVISION', output: 'privacy_policy_effective_date' },
  { revisionConstant: 'TERMS_OF_SERVICE_REVISION', output: 'terms_of_service_effective_date' },
];

/** One document's answer. */
export interface EffectiveDate {
  readonly output: string;
  readonly date: string;
}

export interface EffectiveDateOptions {
  readonly repositoryRoot: string;
  /** The instant that stands for today when no release carries the revision. */
  readonly now: Date;
}

/**
 * A revision declaration's whole value: digits and the statement terminator, and
 * nothing else. A value with a numeric prefix — `1.5`, `1_0`, `2e3` — is one a
 * TypeScript file can carry and nothing else in this repository constrains, and
 * reading its prefix as the revision publishes some other release's date.
 */
const DECLARED_REVISION = /^\d+;?$/;

/**
 * The text `constant` is declared with in `source`, or null when the file
 * declares no such constant. The two states a refusal has to tell apart: a tag
 * from before the constant existed declares nothing, while a declaration this
 * derivation cannot read is right there in front of whoever wrote it.
 *
 * Matched against the whole declaration rather than the name alone, so a longer
 * constant ending in the same words is a different constant.
 */
function declaredValueIn(source: string, constant: string): string | null {
  const declaration = `export const ${constant} = `;
  for (const line of source.split('\n')) {
    if (line.startsWith(declaration)) return line.slice(declaration.length).trim();
  }
  return null;
}

/**
 * The integer `constant` is declared with in `source`, or null when the file
 * declares no such constant or declares it as something other than an integer —
 * the first is what a tag from before the constant existed looks like, and is an
 * answer rather than a failure; the second is a refusal, worded by
 * {@link revisionRefusal} so the two are not reported as the same mistake.
 */
export function revisionIn(source: string, constant: string): number | null {
  const value = declaredValueIn(source, constant);
  if (value === null || !DECLARED_REVISION.test(value)) return null;
  return Number.parseInt(value, 10);
}

/** The UTC day an instant falls on. UTC so the answer does not vary by machine. */
function utcDay(instantMs: number): string {
  return new Date(instantMs).toISOString().slice(0, 10);
}

/**
 * What every refusal here says first. A history that cannot be read has not
 * established that no release carries the revision, and today is the answer to
 * that question — so it is never the answer to a question nothing answered.
 */
const UNANSWERED = 'No effective date can be derived, and today cannot stand in for one.';

interface GitResult {
  readonly ok: boolean;
  readonly stdout: string;
  /**
   * Why this call failed, in git's own words — and in the spawn failure's own
   * words when git never ran, which is the one failure it writes nothing about.
   */
  readonly detail: string;
  /** What git wrote to standard error, whatever it exited with. */
  readonly stderr: string;
}

async function git(repositoryRoot: string, args: readonly string[]): Promise<GitResult> {
  const result = await execa('git', ['-C', repositoryRoot, ...args], { reject: false });
  const stderr = result.stderr.trim();
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout,
    detail: stderr === '' ? (result.message ?? '') : stderr,
    stderr,
  };
}

/**
 * Every release tag, oldest release first.
 *
 * Ordered by version rather than as text, because as text the tenth patch
 * precedes the ninth — and the answer is the day of the EARLIEST release
 * carrying the revision, so the order is the answer.
 *
 * A tag whose reference git cannot read is left out of the listing with a
 * warning and a zero exit, so the listing's standard error is the only place a
 * missing release is reported — take anything written there as a refusal, since
 * a walk missing a tag has not established that no release carries the revision.
 */
async function releaseTags(repositoryRoot: string): Promise<string[]> {
  const listed = await git(repositoryRoot, ['tag', '--list', 'v*', '--sort=version:refname']);
  if (!listed.ok) {
    throw new Error(`${UNANSWERED} The release tags could not be listed: ${listed.detail}`);
  }
  if (listed.stderr !== '') {
    throw new Error(`${UNANSWERED} Listing the release tags was not clean: ${listed.stderr}`);
  }
  return listed.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => RELEASE_TAG.test(line));
}

/** The commit a release tag names, or a refusal when the tag cannot be read. */
async function commitOf(repositoryRoot: string, tag: string): Promise<string> {
  const resolved = await git(repositoryRoot, ['rev-parse', '--verify', `${tag}^{commit}`]);
  if (!resolved.ok) {
    throw new Error(
      `${UNANSWERED} Release tag ${tag} names no commit this repository can read: ${resolved.detail}`
    );
  }
  return resolved.stdout.trim();
}

/**
 * The constants file as `commit` committed it, null when that release predates
 * the file, and a refusal when a file the release does carry cannot be read.
 *
 * The two are told apart by the commit's own tree rather than by what `git show`
 * says when it fails, because an absent path and an unreadable object both leave
 * it empty — and reading one as the other is how a repository that answered
 * nothing comes to answer today.
 */
async function constantsAt(repositoryRoot: string, commit: string): Promise<string | null> {
  const listed = await git(repositoryRoot, [
    'ls-tree',
    '-r',
    '--name-only',
    commit,
    '--',
    CONSTANTS_PATH,
  ]);
  if (!listed.ok) {
    throw new Error(`${UNANSWERED} Commit ${commit} could not be read: ${listed.detail}`);
  }
  if (listed.stdout.trim() === '') return null;

  const shown = await git(repositoryRoot, ['show', `${commit}:${CONSTANTS_PATH}`]);
  if (!shown.ok) {
    throw new Error(
      `${UNANSWERED} ${CONSTANTS_PATH} at commit ${commit} could not be read: ${shown.detail}`
    );
  }
  return shown.stdout;
}

/**
 * The UTC day a commit was committed on. The committer date rather than the
 * author date: a rebased or cherry-picked release commit keeps the day its copy
 * was written, and the day a document became visible is the day its commit
 * reached the branch the release was cut from.
 */
async function commitDay(repositoryRoot: string, commit: string): Promise<string> {
  const stamped = await git(repositoryRoot, ['show', '-s', '--format=%ct', commit]);
  return utcDay(Number.parseInt(stamped.stdout.trim(), 10) * 1000);
}

/** A document and the revision the working tree declares for it. */
interface Asked {
  readonly document: LegalDocument;
  readonly revision: number;
}

/**
 * Why a document's revision could not be read, in the terms of the mistake
 * actually made. A declaration the shape rule refuses is not an absent
 * constant, and reporting it as one sends the person who just typed the line
 * hunting for something that is already there.
 */
function revisionRefusal(constant: string, declared: string | null): string {
  if (declared === null) {
    return `${UNANSWERED} ${CONSTANTS_PATH} declares no ${constant}.`;
  }
  return (
    `${UNANSWERED} ${CONSTANTS_PATH} declares ${constant} as \`${declared}\`, and the whole ` +
    'declaration is read as the revision. It must be digits and the closing semicolon, so ' +
    'anything after the integer, a trailing comment included, belongs on its own line.'
  );
}

/** What each document's revision is now, which is the question being asked. */
async function asked(repositoryRoot: string): Promise<readonly Asked[]> {
  const file = path.join(repositoryRoot, ...CONSTANTS_PATH.split('/'));
  const source = await fs.readFile(file, 'utf8').catch((error: unknown) => {
    throw new Error(`${UNANSWERED} ${CONSTANTS_PATH} could not be read.`, { cause: error });
  });

  return LEGAL_DOCUMENTS.map((document) => {
    const constant = document.revisionConstant;
    const revision = revisionIn(source, constant);
    if (revision === null) {
      throw new Error(revisionRefusal(constant, declaredValueIn(source, constant)));
    }
    return { document, revision };
  });
}

/** A release: the commit its tag names, and the constants file that commit carried. */
interface Release {
  readonly commit: string;
  readonly source: string | null;
}

/** Every release, oldest first, each with what it committed at the constants path. */
async function releases(repositoryRoot: string): Promise<readonly Release[]> {
  const found: Release[] = [];
  for (const tag of await releaseTags(repositoryRoot)) {
    const commit = await commitOf(repositoryRoot, tag);
    found.push({ commit, source: await constantsAt(repositoryRoot, commit) });
  }
  return found;
}

/**
 * The first release whose commit already declared this revision, or null when no
 * release has. First rather than last: the date is when the revision reached a
 * release, so a later release carrying the same revision must not move it.
 */
function firstCarrying(found: readonly Release[], question: Asked): Release | null {
  return (
    found.find(
      (release) =>
        release.source !== null &&
        revisionIn(release.source, question.document.revisionConstant) === question.revision
    ) ?? null
  );
}

/**
 * Each document's effective date: the day of the earliest release tag whose
 * commit already declared the revision the working tree declares, and the day
 * `now` falls on for a revision no release carries yet.
 */
export async function legalEffectiveDates(
  options: EffectiveDateOptions
): Promise<readonly EffectiveDate[]> {
  const questions = await asked(options.repositoryRoot);
  const found = await releases(options.repositoryRoot);
  const today = utcDay(options.now.getTime());

  const dates: EffectiveDate[] = [];
  for (const question of questions) {
    const release = firstCarrying(found, question);
    dates.push({
      output: question.document.output,
      date: release === null ? today : await commitDay(options.repositoryRoot, release.commit),
    });
  }
  return dates;
}

export const COMMAND_LINE = {
  command: 'tsx scripts/legal-effective-dates.ts',
  summary: "Prints each legal document's effective date, derived from the release tags.",
  flags: [],
  positionals: { kind: 'none' },
  effect: 'reports',
} as const satisfies CommandSpec;

/** Writes each document's answer the way the release workflow's other values are written. */
export async function main(options: EffectiveDateOptions): Promise<void> {
  const dates = await legalEffectiveDates(options);
  writeGithubOutput(dates.map((entry) => `${entry.output}=${entry.date}`));
}

/* v8 ignore start -- CLI wiring; main() is covered via unit tests */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    await main({ repositoryRoot: process.cwd(), now: new Date() });
  });
}
/* v8 ignore stop */
