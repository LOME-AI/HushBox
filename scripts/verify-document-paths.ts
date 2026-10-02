/**
 * Doc-path conformance: a backticked repository path a document cites and the
 * tree does not hold.
 *
 * The admission test is the whole of the design. A document is prose, and most
 * of what it backticks is a command, a flag, a symbol or a fragment; reading
 * any of those as a claim about the tree turns the gate into noise nobody
 * reads. So a token counts as a citation only when it is root-anchored — its
 * first segment is an entry the repository root holds — and carries no
 * placeholder standing in for a name. The looser test of "contains a slash"
 * was measured against this tree and reports several hundred correct lines.
 * Under-admitting is the safe direction: a claim this misses is a claim
 * nothing checked, while one it invents is a claim nobody can fix.
 *
 * Resolution answers to the worktree rather than to what version control
 * tracks, because a document legitimately names what a build produces: a path
 * an ignore rule covers resolves whether or not this checkout has built it.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { listWorktreePaths } from './lib/privacy/worktree.js';
import type { GateOutcome } from './privacy-gate.js';

/** Documentation directories holding records rather than descriptions of the current system. */
export const RECORD_DIRECTORIES: readonly string[] = [
  'docs/history/',
  'docs/runs/',
  'docs/audits/',
  'docs/plans/',
];

const DOCUMENTATION_TREE = 'docs/';

const INSTRUCTION_FILE = 'CLAUDE.md';

/** A line reference a citation may carry: `scripts/seed.ts:12`, `scripts/seed.ts:12-20`. */
const LINE_REFERENCE = /:\d+(?:-\d+)?$/u;

/** What a token carries when it stands for a shape rather than naming one path. */
const PLACEHOLDER = /[<>{}*]|\.\.\.|…/u;

const BACKTICKED_SPAN = /`[^`\n]+`/g;

/** A path's first segment, which is the entry the repository root would hold. */
function rootSegment(filePath: string): string {
  return filePath.split('/', 1).join('');
}

/** Whether the check reads this file's citations. */
export function isScannedDocument(filePath: string): boolean {
  // An instruction file is loaded wherever it sits, a record directory
  // included, so what it cites is a claim about the current system.
  if (filePath.split('/').at(-1) === INSTRUCTION_FILE) return true;
  if (!filePath.startsWith(DOCUMENTATION_TREE) || !filePath.endsWith('.md')) return false;
  return !RECORD_DIRECTORIES.some((directory) => filePath.startsWith(directory));
}

/** The entries the repository root holds, read off a listing of the paths below them. */
export function rootEntriesOf(paths: readonly string[]): Set<string> {
  return new Set(paths.map((entry) => rootSegment(entry)));
}

/**
 * The path a backticked token claims, or nothing when the token is not a
 * citation. The admission test, stated once for every caller.
 */
export function citedPath(token: string, rootEntries: ReadonlySet<string>): string | null {
  const cited = token.replace(LINE_REFERENCE, '');
  if (!cited.includes('/') || PLACEHOLDER.test(cited)) return null;
  return rootEntries.has(rootSegment(cited)) ? cited : null;
}

export interface Citation {
  readonly file: string;
  readonly line: number;
  /** The token as the document wrote it, line reference included. */
  readonly token: string;
  /** The path the token claims. */
  readonly cited: string;
}

/** Every claim about the tree one document's text makes. */
export function citationsIn(
  file: string,
  text: string,
  rootEntries: ReadonlySet<string>
): Citation[] {
  const citations: Citation[] = [];
  for (const [index, line] of text.split('\n').entries()) {
    for (const span of line.matchAll(BACKTICKED_SPAN)) {
      const token = span[0].slice(1, -1);
      const cited = citedPath(token, rootEntries);
      if (cited !== null) citations.push({ file, line: index + 1, token, cited });
    }
  }
  return citations;
}

/** Which of a set of paths an ignore rule covers. */
export type IgnoreCoverage = (paths: readonly string[]) => Promise<ReadonlySet<string>>;

export interface DocumentPathDependencies {
  /** Every path the worktree holds, ignored entries excluded. */
  readonly listPaths: () => Promise<readonly string[]>;
  readonly ignoreCoverage: IgnoreCoverage;
}

export interface DocumentPathCheck {
  readonly citations: readonly Citation[];
  /** The citations nothing in the tree answers for. */
  readonly findings: readonly Citation[];
}

/** What git answered when it was asked something it could not answer. */
const CHECK_IGNORE_REFUSED = 2;

/**
 * Which of these paths an ignore rule covers, asked of git's own matcher rather
 * than of a pattern reader of ours. `--no-index` answers from the rules alone,
 * so a path this checkout has never built answers the same as one it has.
 */
export function gitIgnoreCoverage(repoRoot: string): IgnoreCoverage {
  return async (paths) => {
    const asked = await execa(
      'git',
      ['-C', repoRoot, 'check-ignore', '--no-index', '-z', '--stdin'],
      { input: paths.join('\0'), reject: false }
    );
    // A run naming none of them exits 1, which is an answer; anything above
    // that is git declining to answer, and a swallowed decline reads as "no
    // rule covers this" on every path at once.
    if ((asked.exitCode ?? CHECK_IGNORE_REFUSED) >= CHECK_IGNORE_REFUSED) {
      throw new Error(`git check-ignore could not answer: ${asked.stderr}`);
    }
    return new Set(asked.stdout.split('\0').filter((entry) => entry.length > 0));
  };
}

/** The worktree and the ignore rules as git reports them. */
export function gitDocumentPathDependencies(repoRoot: string): DocumentPathDependencies {
  return {
    listPaths: () => listWorktreePaths(repoRoot),
    ignoreCoverage: gitIgnoreCoverage(repoRoot),
  };
}

function isDirectory(absolute: string): boolean {
  return statSync(absolute, { throwIfNoEntry: false })?.isDirectory() === true;
}

/**
 * The closest ancestor of a cited path that the tree holds, so a finding can
 * show what is there instead of what was claimed.
 */
export function nearestExistingDirectory(repoRoot: string, cited: string): string {
  let directory = path.posix.dirname(cited);
  while (directory !== '.' && !isDirectory(path.join(repoRoot, directory))) {
    directory = path.posix.dirname(directory);
  }
  return directory;
}

/** The citations no path in the tree and no ignore rule answers for. */
export async function unresolvedCitations(
  repoRoot: string,
  citations: readonly Citation[],
  ignoreCoverage: IgnoreCoverage
): Promise<Citation[]> {
  const missing = citations.filter(({ cited }) => !existsSync(path.join(repoRoot, cited)));
  if (missing.length === 0) return [];
  const covered = await ignoreCoverage(missing.map(({ cited }) => cited));
  return missing.filter(({ cited }) => !covered.has(cited));
}

/**
 * How many neighbours a finding lists. A finding is read to answer "what is
 * there instead", and a directory of two hundred entries answers it in a line
 * nobody reads.
 */
const NEIGHBOURS_LISTED = 20;

export function formatFinding(repoRoot: string, citation: Citation): string {
  const directory = nearestExistingDirectory(repoRoot, citation.cited);
  const holds = readdirSync(path.join(repoRoot, directory)).toSorted((one, other) =>
    one.localeCompare(other)
  );
  const rest = holds.length - NEIGHBOURS_LISTED;
  const unlisted = rest > 0 ? `, and ${String(rest)} more` : '';
  const listed = holds.slice(0, NEIGHBOURS_LISTED).join(', ');
  return [
    `  ${citation.file}:${String(citation.line)}  \`${citation.token}\``,
    `    ${directory} holds: ${listed}${unlisted}`,
  ].join('\n');
}

/** Every claim the documentation makes about the tree, and the ones it cannot keep. */
export async function checkDocumentPaths(
  repoRoot: string,
  dependencies: DocumentPathDependencies
): Promise<DocumentPathCheck> {
  const paths = await dependencies.listPaths();
  const rootEntries = rootEntriesOf(paths);
  const documents = paths.filter(
    (file) => isScannedDocument(file) && existsSync(path.join(repoRoot, file))
  );
  const read = await Promise.all(
    documents.map(async (file) =>
      citationsIn(file, await readFile(path.join(repoRoot, file), 'utf8'), rootEntries)
    )
  );
  const citations = read.flat();
  return {
    citations,
    findings: await unresolvedCitations(repoRoot, citations, dependencies.ignoreCoverage),
  };
}

export async function runDocumentPathCheck(
  repoRoot: string,
  dependencies: DocumentPathDependencies = gitDocumentPathDependencies(repoRoot)
): Promise<GateOutcome> {
  const { citations, findings } = await checkDocumentPaths(repoRoot, dependencies);
  const report = [
    'Doc paths: every backticked repository path the documentation cites.',
    `  citations checked: ${String(citations.length)}`,
    ...(findings.length === 0
      ? ['  no findings']
      : findings.map((finding) => formatFinding(repoRoot, finding))),
  ].join('\n');
  return { report, code: findings.length === 0 ? 0 : 1 };
}

export const COMMAND_LINE = {
  command: 'pnpm verify:doc-paths',
  summary: 'Checks that every repository path the documentation cites exists.',
  flags: [],
  positionals: { kind: 'none' },
  effect: 'reports',
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through the gate */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const outcome = await runDocumentPathCheck(process.cwd());
    console.log(outcome.report);
    return outcome.code;
  });
}
/* v8 ignore stop */
