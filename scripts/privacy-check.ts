/**
 * The privacy gate over the working tree: the files an agent has just written
 * and nobody has staged.
 *
 * The three enforcing stages all read blobs out of git — the index, a pushed
 * range, a commit's whole tree — because what is about to enter history is what
 * they must judge. Between finishing a task and staging it there is a state none
 * of them can see, and the first thing that judges it today is a human's commit.
 * This stage reads that state, and only that state.
 *
 * It decides nothing. The enumeration is the worktree module's, the scan, the
 * verdict and the report are the gate's, and the batching is the sweep's — this
 * file adds scope resolution for path arguments and a line saying what was
 * examined. A rule, a severity or a finding line defined here would be a second
 * opinion about what discloses, which is the one thing this gate family cannot
 * afford.
 */
import path from 'node:path';
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { formatGateReport, isBlocked, reportablePath, scanBlobs } from './privacy-gate.js';
import { batchEntries, repositoryRoot } from './privacy-sweep.js';
import { PRIVACY_ALLOWLIST_PATH, parsePrivacyAllowlist } from './lib/privacy/allowlist.js';
import { LIVE_RULE_NAMES } from './lib/privacy/rules.js';
import {
  isIgnoredPath,
  listUntrackedPathsUnder,
  listWorktreePaths,
  readWorktreeBlobs,
} from './lib/privacy/worktree.js';
import type { PrivacyAllowlistEntry } from './lib/privacy/allowlist.js';
import type { BinaryOutcome, GateFindings, GateOutcome } from './privacy-gate.js';
import type { PrivacyFinding, TextBlobEntry } from './lib/privacy/rules.js';

/**
 * How many paths one read-and-scan pass covers. The worktree reader bounds the
 * bytes in flight per read but returns every blob it was asked for, so the whole
 * tree in one call is the whole tree in memory. Scanning is per blob and carries
 * nothing between them, so a batch is read, scanned and dropped before the next
 * one is read, and peak memory follows this number rather than the repository.
 */
export const CHECK_BATCH_SIZE = 256;

/**
 * Reads the bytes behind a batch of worktree paths. A parameter rather than a
 * direct call so a test can watch the batches arrive: reading per batch and
 * reading once are indistinguishable from the outside otherwise, and the memory
 * bound is exactly the difference between them.
 */
export type WorktreeReader = (
  repoRoot: string,
  paths: readonly string[]
) => Promise<readonly TextBlobEntry[]>;

export interface ScopeResolution {
  /** The enumerated paths the arguments select, in enumeration order. */
  readonly paths: readonly string[];
  /** Arguments that selected nothing, as the caller typed them. */
  readonly unmatched: readonly string[];
}

export interface BatchScan {
  readonly findings: GateFindings;
  /** Blobs actually read: an enumerated path holding no bytes yields none. */
  readonly examined: number;
}

/**
 * An argument as a repo-relative path with git's separator, so a directory
 * completed by a shell (`docs/`) and one typed on Windows both name the same
 * entries the listing does.
 */
export function normalizeScopeArgument(argument: string): string {
  return path.normalize(argument).split(path.sep).join('/').replace(/\/+$/u, '');
}

/**
 * What {@link normalizeScopeArgument} leaves of an argument naming the
 * repository root — `.`, `./`, an empty argument, and any path that walks back
 * to where it started all collapse to this.
 */
const ROOT_SCOPE = '.';

const withinScope = (filePath: string, scope: string): boolean =>
  // The root selects the whole enumeration rather than the nothing a literal
  // match would find: no enumerated path is spelled `.`, and a tool that refuses
  // `.` while accepting `docs/` reads as broken.
  scope === ROOT_SCOPE || filePath === scope || filePath.startsWith(`${scope}/`);

/**
 * The arguments whose files are examined whether or not git ignores them: those
 * git ignores by their own path, so naming a package directory still leaves its
 * ignored dependencies and build output unread. The root is left out so `.`
 * keeps the no-argument scope.
 */
async function ignoreBypassingScopes(repoRoot: string, args: readonly string[]): Promise<string[]> {
  const scopes = args
    .map((argument) => normalizeScopeArgument(argument))
    .filter((scope) => scope !== ROOT_SCOPE);
  const ignored = await Promise.all(scopes.map(async (scope) => isIgnoredPath(repoRoot, scope)));
  return scopes.filter((_scope, index) => ignored[index]);
}

/**
 * The enumerated paths the arguments select, and the arguments that selected
 * nothing. An argument naming nothing is kept rather than dropped: a scope that
 * matches no file scans zero files, and zero files examined reported as a pass
 * is the silence-as-verdict this gate family refuses.
 */
export function resolveScope(paths: readonly string[], args: readonly string[]): ScopeResolution {
  if (args.length === 0) return { paths, unmatched: [] };
  const scopes = args.map((argument) => ({ argument, prefix: normalizeScopeArgument(argument) }));
  return {
    paths: paths.filter((filePath) => scopes.some((scope) => withinScope(filePath, scope.prefix))),
    unmatched: scopes
      .filter((scope) => !paths.some((filePath) => withinScope(filePath, scope.prefix)))
      .map((scope) => scope.argument),
  };
}

/**
 * The allowlist as the worktree holds it. Every other stage reads this from git,
 * so an unstaged exemption cannot suppress a staged finding; this stage judges
 * worktree state, so the worktree is the matching source. It is advisory only —
 * the three enforcing stages are untouched and still read theirs from git.
 */
export async function readAllowlistFromWorktree(
  repoRoot: string,
  paths: readonly string[]
): Promise<PrivacyAllowlistEntry[]> {
  if (!paths.includes(PRIVACY_ALLOWLIST_PATH)) return [];
  const blobs = await readWorktreeBlobs(repoRoot, [PRIVACY_ALLOWLIST_PATH]);
  return blobs.flatMap((blob) =>
    parsePrivacyAllowlist(Buffer.from(blob.bytes).toString('utf8'), LIVE_RULE_NAMES)
  );
}

/** Both gates over the scope, one batch read, scanned and dropped at a time. */
export async function scanInBatches(
  repoRoot: string,
  paths: readonly string[],
  allowlist: readonly PrivacyAllowlistEntry[],
  read: WorktreeReader
): Promise<BatchScan> {
  const text: PrivacyFinding[] = [];
  const binary: BinaryOutcome[] = [];
  let examined = 0;
  for (const batch of batchEntries(paths, CHECK_BATCH_SIZE)) {
    const batchBlobs = await read(repoRoot, batch);
    const blobs = batchBlobs.map((blob) => ({
      path: reportablePath(blob.path),
      bytes: blob.bytes,
    }));
    examined += blobs.length;
    const findings = scanBlobs(blobs, allowlist);
    text.push(...findings.text);
    binary.push(...findings.binary);
  }
  return { findings: { text, binary }, examined };
}

function scopeLine(args: readonly string[], examined: number): string {
  const where =
    args.length === 0
      ? 'across the whole working tree'
      : `in the working tree under ${args.map((argument) => reportablePath(argument)).join(', ')}`;
  return `Privacy check: ${String(examined)} file(s) examined ${where}, staged or not.`;
}

function unmatchedReport(unmatched: readonly string[]): string {
  return [
    `Privacy check: ${String(unmatched.length)} argument(s) named nothing the working tree holds.`,
    'A scope matching no file examines no file, which is a stop rather than a pass.',
    '',
    ...unmatched.map((argument) => `  ${reportablePath(argument)}`),
  ].join('\n');
}

export async function runPrivacyCheck(
  repoRoot: string,
  args: readonly string[]
): Promise<GateOutcome> {
  const enumerated = await listWorktreePaths(repoRoot);
  const named = await listUntrackedPathsUnder(
    repoRoot,
    await ignoreBypassingScopes(repoRoot, args)
  );
  const scope = resolveScope([...new Set([...enumerated, ...named])], args);
  if (scope.unmatched.length > 0) return { report: unmatchedReport(scope.unmatched), code: 1 };
  // The allowlist is looked up over the whole enumeration rather than the scope:
  // an exemption stays in force when a run is narrowed to a subdirectory.
  const allowlist = await readAllowlistFromWorktree(repoRoot, enumerated);
  const scan = await scanInBatches(repoRoot, scope.paths, allowlist, readWorktreeBlobs);
  return {
    report: [scopeLine(args, scan.examined), formatGateReport(scan.findings)].join('\n\n'),
    code: isBlocked(scan.findings) ? 1 : 0,
  };
}

/* v8 ignore start -- CLI entry point, exercised through the pnpm script */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const outcome = await runPrivacyCheck(
      repositoryRoot(import.meta.dirname),
      process.argv.slice(2)
    );
    console.log(outcome.report);
    return outcome.code;
  });
}
/* v8 ignore stop */
