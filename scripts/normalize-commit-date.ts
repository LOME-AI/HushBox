/**
 * Rewrites HEAD so its author and committer dates carry day resolution only —
 * the UTC day each already fell on, rendered at `+0000`. Wired to the
 * post-commit, post-merge and post-applypatch hooks, which between them cover
 * every path that mints a commit (`pre-commit` fires for none of merge,
 * cherry-pick, revert or rebase).
 *
 * `git commit --amend` is not usable here: it ignores the date environment
 * variables, and inside a rebase or cherry-pick sequencer it fails while the
 * enclosing operation still reports success. Rebuilding the object is the only
 * mechanism that survives every path.
 *
 * An unsigned commit is rebuilt by patching the two date fields in the raw
 * object and writing it back, so every other byte — identity, message, and any
 * header this file does not itself interpret — is carried through untouched. A
 * signed commit has to go through `commit-tree`, the only porcelain that can
 * remake a signature, which forces identity through the environment.
 */
import { execa } from 'execa';
import { DAY_SECONDS } from '@hushbox/shared/durations';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';

const UTC_OFFSET = '+0000';
const REFLOG_MESSAGE = 'normalize commit date to day resolution';
/**
 * The exact inverse of the change: the rewrite moves the reference forward under
 * an expected-value fence, so the undo moves it back under the same fence. The
 * rebuilt commit carries the original tree header, so the index and the working
 * tree are never involved — a reset that touched them would discard uncommitted
 * work this rewrite never had anything to do with.
 *
 * Both object names are spelled out rather than reached through a reference or a
 * reflog position: git resolves those at the moment the line is pasted, so an
 * expected value written that way always equals what it is compared against and
 * the fence can never refuse. Named explicitly, a paste that arrives after the
 * reference moved on — a later commit, another branch checked out, or a second
 * paste of the same line — refuses instead of moving a reference it was never
 * printed for.
 */
function recoveryCommand(previousSha: string, sha: string): string {
  return `git update-ref HEAD ${previousSha} ${sha}`;
}

/**
 * Every header this rebuild knows how to carry. Anything else is refused rather
 * than dropped or copied: dropping a `mergetag` destroys data, and copying one
 * preserves the second-precision tagger timestamp sealed inside it.
 */
const RECOGNIZED_HEADERS = new Set(['tree', 'parent', 'author', 'committer', 'encoding', 'gpgsig']);

/** `author`/`committer` line: role, identity, epoch, rendered offset. */
export const STAMP_LINE = /^(?:author|committer) .* <.*> -?\d+ [+-]\d{4}$/;

export type RefusalReason =
  | 'unrecognized-header'
  | 'non-ssh-signature'
  | 'unrepresentable-identity';

export type NormalizeOutcome =
  | { status: 'no-commit' }
  | { status: 'published' }
  | { status: 'conforming' }
  | { status: 'refused'; reason: RefusalReason; detail: string }
  | { status: 'normalized'; sha: string; previousSha: string };

interface CommitObject {
  /** Header lines decoded as latin1, which maps bytes one to one. */
  headerLines: readonly string[];
  message: Buffer;
}

interface Stamp {
  role: string;
  /** The identity exactly as stored, so a rebuild can put it back verbatim. */
  ident: string;
  name: string;
  email: string;
  epoch: number;
  offset: string;
}

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execa('git', [...args], { cwd });
  return stdout;
}

async function verifies(cwd: string, revision: string): Promise<boolean> {
  const result = await execa('git', ['rev-parse', '--verify', '--quiet', revision], {
    cwd,
    reject: false,
  });
  return result.exitCode === 0 && result.stdout.trim() !== '';
}

/**
 * Reads the raw commit object and splits it at the first genuinely empty line.
 * Continuation lines of a multi-line header (a signature) are indented by one
 * space, so they never look like that separator.
 */
async function readCommitObject(cwd: string): Promise<CommitObject> {
  const { stdout } = await execa('git', ['cat-file', 'commit', 'HEAD'], {
    cwd,
    encoding: 'buffer',
    stripFinalNewline: false,
  });
  // execa hands back a Uint8Array, whose `indexOf` searches for a single byte
  // value rather than a byte sequence.
  const raw = Buffer.from(stdout);
  const separator = raw.indexOf('\n\n');
  return {
    headerLines: raw.subarray(0, separator).toString('latin1').split('\n'),
    message: raw.subarray(separator + 2),
  };
}

function headerValues(commit: CommitObject, key: string): string[] {
  return commit.headerLines
    .filter((line) => line.startsWith(`${key} `))
    .map((line) => line.slice(key.length + 1));
}

function unrecognizedHeader(commit: CommitObject): string | null {
  for (const line of commit.headerLines) {
    if (line.startsWith(' ')) continue;
    const key = line.slice(0, line.indexOf(' '));
    if (!RECOGNIZED_HEADERS.has(key)) return key;
  }
  return null;
}

/**
 * Splits a stamp line by position rather than by capture group. The shape is
 * already guaranteed by STAMP_LINE, and positional slicing keeps every field a
 * plain string — capture-group indexing would yield optionals whose fallbacks
 * no commit git can write could ever reach.
 */
function parseStamp(line: string): Stamp | null {
  if (!STAMP_LINE.test(line)) return null;
  const head = line.slice(0, -6);
  const role = line.slice(0, line.indexOf(' '));
  const ident = head.slice(role.length + 1, head.lastIndexOf(' '));
  const emailOpen = ident.lastIndexOf(' <');
  return {
    role,
    ident,
    name: ident.slice(0, emailOpen),
    email: ident.slice(emailOpen + 2, -1),
    epoch: Number(head.slice(head.lastIndexOf(' ') + 1)),
    offset: line.slice(-5),
  };
}

function stamps(commit: CommitObject): Stamp[] {
  return commit.headerLines
    .map((line) => parseStamp(line))
    .filter((stamp): stamp is Stamp => stamp !== null);
}

function isConforming(commit: CommitObject): boolean {
  return stamps(commit).every(
    (stamp) => stamp.offset === UTC_OFFSET && stamp.epoch % DAY_SECONDS === 0
  );
}

/**
 * The day-pinning rule, in one place: a stamp's own UTC day start, rendered at
 * UTC. Both rebuilds take their dates from here — the signing path only prefixes
 * git's raw-date marker — so neither can drift from the other, and a stamp is
 * pinned to its own day rather than to any other stamp's.
 */
function pinnedDate(stamp: Stamp): string {
  const dayStart = Math.floor(stamp.epoch / DAY_SECONDS) * DAY_SECONDS;
  return `${String(dayStart)} ${UTC_OFFSET}`;
}

/**
 * Recovers a header value's real characters. The header was decoded as latin1
 * to keep it byte-exact, so the bytes have to be re-read as UTF-8; a value that
 * is not valid UTF-8 cannot survive the environment and is reported as such.
 */
function decodeIdentity(latin1Value: string): string | null {
  const bytes = Buffer.from(latin1Value, 'latin1');
  const text = bytes.toString('utf8');
  return Buffer.from(text, 'utf8').equals(bytes) ? text : null;
}

/** Rewrites only the epoch and offset of each stamp line, byte for byte otherwise. */
function withPinnedDates(commit: CommitObject): string[] {
  return commit.headerLines.map((line) => {
    const stamp = parseStamp(line);
    if (stamp === null) return line;
    return `${stamp.role} ${stamp.ident} ${pinnedDate(stamp)}`;
  });
}

async function writeUnsignedRebuild(cwd: string, commit: CommitObject): Promise<string> {
  const rebuilt = Buffer.concat([
    Buffer.from(withPinnedDates(commit).join('\n'), 'latin1'),
    Buffer.from('\n\n'),
    commit.message,
  ]);
  const { stdout } = await execa('git', ['hash-object', '-t', 'commit', '-w', '--stdin'], {
    cwd,
    input: rebuilt,
  });
  return stdout.trim();
}

function signingEnvironment(commit: CommitObject): Record<string, string> | null {
  const environment: Record<string, string> = {};
  for (const stamp of stamps(commit)) {
    const role = stamp.role.toUpperCase();
    const name = decodeIdentity(stamp.name);
    const email = decodeIdentity(stamp.email);
    if (name === null || email === null) return null;
    environment[`GIT_${role}_NAME`] = name;
    environment[`GIT_${role}_EMAIL`] = email;
    environment[`GIT_${role}_DATE`] = `@${pinnedDate(stamp)}`;
  }
  return environment;
}

async function writeSignedRebuild(
  cwd: string,
  commit: CommitObject,
  environment: Record<string, string>
): Promise<string> {
  // Exactly one tree header exists on every commit, so joining is a total way
  // to read it without an unreachable fallback.
  const tree = headerValues(commit, 'tree').join('');
  const parents = headerValues(commit, 'parent');
  const [encoding] = headerValues(commit, 'encoding');
  // commit-tree has no flag for the encoding header; it emits one from config.
  const configuration = encoding === undefined ? [] : ['-c', `i18n.commitEncoding=${encoding}`];
  const { stdout } = await execa(
    'git',
    [
      ...configuration,
      'commit-tree',
      tree,
      ...parents.flatMap((parent) => ['-p', parent]),
      '-S',
      '-F',
      '-',
    ],
    { cwd, input: commit.message, env: environment }
  );
  return stdout.trim();
}

/**
 * HEAD counts as published when it is reachable from a remote-tracking ref or
 * from a verifying FETCH_HEAD. The second half matters because a fast-forward
 * pull that names a URL rather than a remote — `git pull <url> main`, or a
 * `git fetch <url> <ref>` finished with `git merge FETCH_HEAD` — updates no
 * remote-tracking ref at all, and rewriting what it brought in would silently
 * diverge this clone and publish a rewritten copy of someone else's commit on
 * the next push.
 *
 * Deliberately not widened to everything locally reachable: fast-forwarding a
 * local branch onto a non-conforming tip still normalizes, and that is the
 * point rather than a gap — those commits are this developer's own, minted
 * through some path that bypassed the hook, and normalizing them is the whole
 * job. Excluding them would let a bypassed commit escape to the push gate.
 */
async function isPublished(cwd: string): Promise<boolean> {
  const excluded = ['--not', '--remotes'];
  if (await verifies(cwd, 'FETCH_HEAD')) excluded.push('FETCH_HEAD');
  const unpublished = await git(cwd, ['rev-list', '-1', 'HEAD', ...excluded]);
  return unpublished.trim() === '';
}

async function rebuild(
  cwd: string,
  commit: CommitObject,
  previousSha: string
): Promise<NormalizeOutcome> {
  if (headerValues(commit, 'gpgsig').length === 0) {
    return { status: 'normalized', sha: await writeUnsignedRebuild(cwd, commit), previousSha };
  }
  // An OpenPGP signature packet seals a second-precision creation time inside
  // the commit, which would put back the disclosure this rewrite removes.
  const format = await git(cwd, ['config', '--default', 'openpgp', '--get', 'gpg.format']);
  if (format !== 'ssh') {
    return { status: 'refused', reason: 'non-ssh-signature', detail: format };
  }
  const environment = signingEnvironment(commit);
  if (environment === null) {
    return { status: 'refused', reason: 'unrepresentable-identity', detail: 'author or committer' };
  }
  return {
    status: 'normalized',
    sha: await writeSignedRebuild(cwd, commit, environment),
    previousSha,
  };
}

export async function normalizeHeadCommitDate(cwd: string): Promise<NormalizeOutcome> {
  if (!(await verifies(cwd, 'HEAD'))) return { status: 'no-commit' };
  const oldSha = await git(cwd, ['rev-parse', 'HEAD']);
  if (await isPublished(cwd)) return { status: 'published' };

  const commit = await readCommitObject(cwd);
  if (isConforming(commit)) return { status: 'conforming' };

  // This refusal has to stay ahead of the rebuild. A SHA-256 repository names
  // its signature `gpgsig-sha256`, which is unrecognized here and so never
  // reaches the rebuild's `gpgsig` lookup — which is the only reason that lookup
  // can match the key exactly rather than by prefix.
  const unrecognized = unrecognizedHeader(commit);
  if (unrecognized !== null) {
    return { status: 'refused', reason: 'unrecognized-header', detail: unrecognized };
  }

  const outcome = await rebuild(cwd, commit, oldSha);
  if (outcome.status !== 'normalized') return outcome;
  await git(cwd, ['update-ref', '-m', REFLOG_MESSAGE, 'HEAD', outcome.sha, oldSha]);
  return outcome;
}

const REFUSALS: Record<RefusalReason, string> = {
  'unrecognized-header': 'it carries a header this rewrite cannot preserve',
  'non-ssh-signature': 'it is signed under a format whose signature embeds a timestamp',
  'unrepresentable-identity': 'its identity bytes cannot survive a signing rebuild',
};

export function describeOutcome(outcome: NormalizeOutcome): string | null {
  if (outcome.status === 'refused') {
    return `refusing to normalize the commit date: ${REFUSALS[outcome.reason]} (${outcome.detail}). The commit stands as written and the push gate will reject it.`;
  }
  if (outcome.status !== 'normalized') return null;
  return `${REFLOG_MESSAGE}: ${outcome.sha}\nundo with: ${recoveryCommand(outcome.previousSha, outcome.sha)}`;
}

export const COMMAND_LINE = {
  command: 'tsx scripts/normalize-commit-date.ts',
  summary: 'Rewrites HEAD so its dates carry day resolution only.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point */
if (isMainModule(import.meta.url)) {
  void runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const outcome = await normalizeHeadCommitDate(process.cwd());
    const line = describeOutcome(outcome);
    if (outcome.status === 'refused') {
      console.error(line);
      return 1;
    }
    if (line !== null) console.log(line);
    return 0;
  });
}
/* v8 ignore stop */
