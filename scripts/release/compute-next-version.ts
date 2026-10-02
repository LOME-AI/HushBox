import { fetchAssociatedPrLabels } from '@hushbox/ops/associated-pull-requests';

import { semverToCode, writeGithubOutput } from '../extract-version.js';
import { git as runGit } from '../lib/publication/git.js';
import { CLAIM_NAMESPACE, RELEASE_TAG, claimRef, claimedTag } from '../lib/release-references.js';

interface Semver {
  major: number;
  minor: number;
  patch: number;
}

type BumpType = 'major' | 'minor' | 'patch';

interface ComputeVersionInput {
  latestTag: string | null;
  labels: string[];
}

interface ComputeVersionResult {
  version: string;
  versionName: string;
  versionCode: number;
}

const STRICT_SEMVER = /^v?(\d+)\.(\d+)\.(\d+)$/;

/** Parse a strict semver string (with optional v prefix) into components. */
export function parseSemver(tag: string): Semver {
  const match = STRICT_SEMVER.exec(tag);
  if (!match) {
    throw new Error(`Invalid semver: "${tag}" (expected [v]X.Y.Z)`);
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/** Orders two versions: negative when `a` is lower, zero when equal, positive when higher. */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

/** Determine which semver component to bump based on PR labels. */
export function determineBumpType(labels: string[]): BumpType {
  if (labels.includes('major')) return 'major';
  if (labels.includes('minor')) return 'minor';
  return 'patch';
}

/** Compute the next version from the latest git tag and PR labels. */
export function computeNextVersion(input: ComputeVersionInput): ComputeVersionResult {
  if (input.latestTag === null) {
    const version = '1.0.0';
    return { version, versionName: version, versionCode: semverToCode(version) };
  }

  const current = parseSemver(input.latestTag);
  const bump = determineBumpType(input.labels);

  let next: Semver;
  switch (bump) {
    case 'major': {
      next = { major: current.major + 1, minor: 0, patch: 0 };
      break;
    }
    case 'minor': {
      next = { major: current.major, minor: current.minor + 1, patch: 0 };
      break;
    }
    case 'patch': {
      next = { major: current.major, minor: current.minor, patch: current.patch + 1 };
      break;
    }
  }

  const version = `${String(next.major)}.${String(next.minor)}.${String(next.patch)}`;
  return { version, versionName: version, versionCode: semverToCode(version) };
}

/** Runs one git command in a checkout and answers its standard output, throwing on failure. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

/** A ref that carries a version number: a release tag or a claim. */
interface VersionRef {
  readonly tag: string;
  readonly commit: string;
}

/** The namespace release tags live in. */
export const RELEASE_TAGS = 'refs/tags/';

function versionTagOf(ref: string): string | null {
  if (ref.startsWith(RELEASE_TAGS)) {
    const tag = ref.slice(RELEASE_TAGS.length);
    return RELEASE_TAG.test(tag) ? tag : null;
  }
  return claimedTag(ref);
}

/**
 * Every release tag and claim in the checkout, each with the commit it names.
 * An annotated tag names its tag object, so the peeled object is the commit.
 */
export async function versionReferences(
  git: GitRunner,
  repositoryRoot: string,
  namespaces: readonly string[],
  containing?: string
): Promise<VersionRef[]> {
  const listed = await git(repositoryRoot, [
    'for-each-ref',
    '--format=%(refname) %(objectname) %(*objectname)',
    ...(containing === undefined ? [] : [`--contains=${containing}`]),
    ...namespaces,
  ]);
  return listed
    .split('\n')
    .filter((line) => line !== '')
    .flatMap((line) => {
      const [ref = '', object = '', peeled = ''] = line.split(' ');
      const tag = versionTagOf(ref);
      return tag === null ? [] : [{ tag, commit: peeled === '' ? object : peeled }];
    });
}

/** The highest of the given version tags, or null when there are none. */
function highest(tags: readonly string[]): string | null {
  let best: string | null = null;
  for (const tag of tags) {
    if (best === null || compareSemver(tag, best) > 0) best = tag;
  }
  return best;
}

/** Find the latest stable release tag (vX.Y.Z, no pre-release) in the checkout. */
export async function findLatestStableTag(repositoryRoot: string): Promise<string | null> {
  const tags = await versionReferences(runGit, repositoryRoot, [RELEASE_TAGS]);
  return highest(tags.map((entry) => entry.tag));
}

export interface PushClaimOptions {
  readonly repositoryRoot: string;
  readonly sha: string;
  readonly version: string;
  readonly git?: GitRunner;
}

/**
 * Creates the claim for `version` at `sha` on `origin`, and fails when the remote
 * already carries it. A plain push is not create-only for a ref outside
 * `refs/tags/`: from a descendant commit it fast-forwards an existing claim onto
 * the new commit. The lease expecting no ref at all is what makes it refuse.
 */
export async function pushClaim(options: PushClaimOptions): Promise<void> {
  const git = options.git ?? runGit;
  const ref = claimRef(options.version);
  await git(options.repositoryRoot, [
    'push',
    '--quiet',
    `--force-with-lease=${ref}:`,
    'origin',
    `${options.sha}:${ref}`,
  ]);
}

export interface ClaimOptions {
  readonly repositoryRoot: string;
  readonly sha: string;
  readonly labels: readonly string[];
  readonly git?: GitRunner;
}

export interface ClaimResult extends ComputeVersionResult {
  readonly claimed: boolean;
}

/**
 * Takes the next version number for `sha`: one above every release tag and every
 * claim, bumped by the labels, and claimed on `origin` before anything is built.
 *
 * Correct only inside a critical section every claiming run queues for, so each
 * claim reads every earlier one: create-only alone lets two runs sharing a base
 * with different bump labels give an older commit a higher number than its
 * descendant. A number already taken by a commit that descends from `sha` means
 * a newer commit holds a number, and shipping this one would be a downgrade: the
 * run answers a version for its build and claims none.
 */
export async function claimNextVersion(options: ClaimOptions): Promise<ClaimResult> {
  const git = options.git ?? runGit;
  const root = options.repositoryRoot;
  const claims = `${CLAIM_NAMESPACE}/*`;
  await git(root, ['fetch', '--quiet', '--prune', 'origin', `+${claims}:${claims}`]);

  const namespaces = [RELEASE_TAGS, CLAIM_NAMESPACE];
  const taken = await versionReferences(git, root, namespaces);
  const next = computeNextVersion({
    latestTag: highest(taken.map((entry) => entry.tag)),
    labels: [...options.labels],
  });

  const containing = await versionReferences(git, root, namespaces, options.sha);
  if (containing.some((entry) => entry.commit !== options.sha)) {
    return { ...next, claimed: false };
  }

  await pushClaim({ repositoryRoot: root, sha: options.sha, version: next.version, git });
  return { ...next, claimed: true };
}

export interface RunOptions {
  readonly repositoryRoot: string;
}

/** The environment variable the claiming job sets to put this script in claim mode. */
export const CLAIM_FLAG = 'CLAIM_VERSION';

/** Whether this run claims its number. */
function claimRequested(): boolean {
  const flag = process.env[CLAIM_FLAG];
  if (flag === undefined || flag === '') return false;
  if (flag === 'true') return true;
  throw new Error(`${CLAIM_FLAG} must be 'true' or unset, not "${flag}"`);
}

export async function main(options: RunOptions): Promise<void> {
  const token = process.env['GITHUB_TOKEN'];
  const repository = process.env['GITHUB_REPOSITORY'];
  const sha = process.env['GITHUB_SHA'];

  if (!token) throw new Error('GITHUB_TOKEN is required');
  if (!repository) throw new Error('GITHUB_REPOSITORY is required');
  if (!sha) throw new Error('GITHUB_SHA is required');
  const claim = claimRequested();

  const prLabels = await fetchAssociatedPrLabels({ repository, sha, token });
  if (!prLabels.ok) {
    throw new Error(prLabels.error);
  }
  const labels = [...prLabels.labels];

  const result: ClaimResult = claim
    ? await claimNextVersion({ repositoryRoot: options.repositoryRoot, sha, labels })
    : {
        ...computeNextVersion({
          latestTag: await findLatestStableTag(options.repositoryRoot),
          labels,
        }),
        claimed: false,
      };

  writeGithubOutput([
    `version=${result.version}`,
    `version_name=${result.versionName}`,
    `version_code=${String(result.versionCode)}`,
    `claimed=${String(result.claimed)}`,
  ]);
}

/* v8 ignore start -- CLI wiring; main() is covered via unit tests */
const scriptPath = process.argv[1] ?? '';
const isDirectExecution =
  scriptPath.endsWith('compute-next-version.ts') || scriptPath.endsWith('compute-next-version.js');
if (isDirectExecution) {
  void (async (): Promise<void> => {
    try {
      await main({ repositoryRoot: process.cwd() });
    } catch (error: unknown) {
      console.error(error);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
