/**
 * The pushed range: what git tells a pre-push hook on stdin, turned into the
 * revision spec that names exactly the commits this push would publish. Single
 * source for every push-stage check — a second stdin parser would be a second
 * definition of "what is being pushed".
 *
 * For a ref the destination already has, git's own protocol line carries what it
 * holds. For a ref the destination has never seen, nothing in the protocol says
 * what it already holds, and this clone's remote-tracking refs are not an answer
 * — a clone that fetches from one repository and pushes to another is the shape
 * this repository's own installer creates. So the exclusions for a new ref are
 * asked of the destination, and a caller that cannot ask must refuse rather than
 * guess.
 */
import { execa } from 'execa';

interface PushRef {
  localRef: string;
  localSha: string;
  remoteRef: string;
  remoteSha: string;
}

/** git's all-zeros object id: "this side of the ref does not exist". */
const ZERO_SHA = '0'.repeat(40);

/**
 * Parses the ref lines git feeds a pre-push hook on stdin. Each line is
 * `<local ref> <local sha> <remote ref> <remote sha>`.
 */
export function parsePushReferences(stdin: string): PushRef[] {
  return stdin
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [localRef = '', localSha = '', remoteRef = '', remoteSha = ''] = line.split(/\s+/);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/**
 * One range, in the two renderings its consumers need: argv for the checks that
 * run git themselves, and the `--log-opts` string for gitleaks, which takes its
 * range as one option value. Both are built here so no consumer re-decides what
 * the range is — including the fallback, where the two renderings differ in
 * spelling and not in meaning.
 */
/** One ref's own range, and the tip whose state governs it. */
export interface PushedRefRange {
  readonly ref: string;
  /** The revision whose tree is what this ref would publish. */
  readonly tip: string;
  readonly range: PushedRange;
}

export interface PushedRange {
  /** Revision arguments naming exactly the commits this push publishes. */
  readonly revisions: readonly string[];
  /** The same range as gitleaks' `--log-opts` value. */
  readonly logOptions: string;
}

/**
 * The last commit and nothing before it. `-1` is a `git log` count option that
 * `git rev-list --objects` would read as "one commit's whole tree", so the argv
 * rendering names the commit's own contribution instead — which is what `-1`
 * means to a log and what a gate needs to scan.
 */
const LAST_COMMIT: PushedRange = { revisions: ['HEAD', '--not', 'HEAD^@'], logOptions: '-1' };

/**
 * Builds the revision range covering only the commits being pushed. Returns
 * null when there is nothing to scan (deletions only).
 *
 * `advertised` is what the destination says it already holds, and it is the only
 * thing a new ref may be judged against. An empty set is a legitimate answer — a
 * destination holding nothing — and yields the branch's whole history, which is
 * the safe direction.
 */
export function computePushedRange(
  references: readonly PushRef[],
  advertised: readonly string[]
): PushedRange | null {
  const revisions: string[] = [];
  for (const ref of references) {
    if (ref.localSha === ZERO_SHA) continue;
    // The closing `--not` restores polarity. `--not` toggles the sense of every
    // revision that follows it until the next one, so without the reset a
    // new-branch group turns a following `a..b` inside out and that ref's
    // commits leave the range entirely — measured against git, not reasoned.
    if (ref.remoteSha === ZERO_SHA) {
      revisions.push(ref.localSha, '--not', ...advertised, '--not');
    } else {
      revisions.push(`${ref.remoteSha}..${ref.localSha}`);
    }
  }
  // One argument list holds every ref's range, so an exclusion from one ref
  // applies to all of them. That is the intended reading: a commit the remote
  // already has needs no scanning, whichever ref carried it there.
  return revisions.length > 0 ? { revisions, logOptions: revisions.join(' ') } : null;
}

/**
 * Resolves the range for this push, or null when there is nothing to scan.
 * Empty stdin (e.g. a manual `pnpm pre-push`) falls back to the last commit,
 * matching CI's `--log-opts=-1`.
 */
export function resolvePushedRange(
  stdin: string,
  isTty: boolean,
  advertised: readonly string[]
): PushedRange | null {
  if (isTty || stdin.trim() === '') return LAST_COMMIT;
  return computePushedRange(parsePushReferences(stdin), advertised);
}

/** Whether this push creates a ref the destination has never named. */
export function hasNewRef(references: readonly PushRef[]): boolean {
  return references.some(
    (reference) => reference.localSha !== ZERO_SHA && reference.remoteSha === ZERO_SHA
  );
}

export type DestinationReferences =
  | { readonly established: true; readonly objectIds: string[] }
  | { readonly established: false; readonly reason: string };

/** Long enough for a remote to answer, short enough that a hook never hangs on one. */
const ADVERTISEMENT_TIMEOUT_MS = 30_000;

/**
 * The object ids in an advertisement. A destination names one object under
 * several refs — `HEAD` and the branch it points at, a tag and its peel — and
 * the ids are what excludes, not the names, so they are deduplicated here.
 */
function parseAdvertisement(stdout: string): string[] {
  return [
    ...new Set(
      stdout
        .split('\n')
        .map((line) => line.split('\t')[0] ?? '')
        .filter((objectId) => objectId !== '')
    ),
  ];
}

interface AdvertisementOptions {
  /** The bound on asking. Injected so the refusal path is reachable in a suite. */
  readonly timeoutMs?: number;
}

/**
 * Why the question could not be answered, in words a developer can act on. A
 * destination that accepts a connection and never answers leaves no exit code
 * and no stderr at all, so the timeout flag is the only thing that knows what
 * happened — a reason read from stderr in that case is the empty string, and a
 * refusal whose reason is empty tells nobody anything.
 */
export function advertisementFailure(
  result: { readonly timedOut: boolean; readonly stderr: string },
  boundMs: number
): string {
  if (result.timedOut) return `it did not answer within ${String(boundMs)} ms`;
  const [first = ''] = result.stderr.split('\n');
  return first.trim() === '' ? 'it answered with an error and no diagnosis' : first;
}

export async function advertisedObjectIds(
  cwd: string,
  destination: string,
  options: AdvertisementOptions = {}
): Promise<DestinationReferences> {
  if (destination === '') {
    return { established: false, reason: 'no destination was given to ask' };
  }
  const boundMs = options.timeoutMs ?? ADVERTISEMENT_TIMEOUT_MS;
  const listed = await execa('git', ['-C', cwd, 'ls-remote', destination], {
    reject: false,
    timeout: boundMs,
    env: { GIT_TERMINAL_PROMPT: '0' },
  });
  // An answered question is the narrow branch deliberately: it exits zero, and
  // every other outcome — an error, or a timeout that leaves no exit code at all
  // — falls through to the refusal. Written the other way round, an absent exit
  // code reads as a pass, which is the guess this mechanism exists to refuse.
  if (listed.exitCode === 0) {
    return {
      established: true,
      objectIds: await walkableIds(cwd, parseAdvertisement(listed.stdout)),
    };
  }
  return { established: false, reason: advertisementFailure(listed, boundMs) };
}

/**
 * The advertised ids this clone can walk from. An id the clone does not have
 * cannot exclude anything, and naming it in a revision walk fails the walk
 * outright, so it is dropped — which over-enumerates, the safe direction.
 */
async function walkableIds(cwd: string, advertised: readonly string[]): Promise<string[]> {
  if (advertised.length === 0) return [];
  const known = await execa('git', ['-C', cwd, 'cat-file', '--batch-check'], {
    reject: false,
    input: `${advertised.join('\n')}\n`,
  });
  const present = new Set(
    known.stdout
      .split('\n')
      .filter((line) => !line.endsWith(' missing'))
      .map((line) => line.split(' ')[0] ?? '')
  );
  return advertised.filter((objectId) => present.has(objectId));
}

/**
 * The same push, one entry per ref, each with the range that ref alone
 * publishes and the tip that governs it. A check whose answer depends on the
 * state being published — which allowlist exempts what — has to ask the ref
 * carrying that state rather than a single winner chosen from several.
 *
 * Deletions have no tip and publish nothing, so they yield no entry. Empty
 * stdin is the manual invocation, whose one entry is the last commit.
 */
export function resolvePushedRefRanges(
  stdin: string,
  isTty: boolean,
  advertised: readonly string[]
): PushedRefRange[] {
  if (isTty || stdin.trim() === '') {
    return [{ ref: 'HEAD', tip: 'HEAD', range: LAST_COMMIT }];
  }
  return parsePushReferences(stdin).flatMap((reference) => {
    const range = computePushedRange([reference], advertised);
    return range === null ? [] : [{ ref: reference.localRef, tip: reference.localSha, range }];
  });
}
