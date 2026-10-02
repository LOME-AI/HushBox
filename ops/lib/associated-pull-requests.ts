/**
 * The commit → pull-request lookup the release pipeline runs on, shared by the
 * deploy job's ops-script resolution (`resolve-pr-scripts.ts`) and the release
 * version bump (`scripts/release/compute-next-version.ts`). Both read the same GitHub
 * endpoint and must reach the same conclusion about the same commit, so the
 * endpoint, its headers, its error handling and its ambiguity rule live here
 * once rather than once per caller.
 */

interface GitHubLabel {
  readonly name: string;
}

export interface AssociatedPullRequest {
  readonly number: number;
  readonly labels: readonly GitHubLabel[];
}

export type PullRequestLabelsResult =
  | { ok: true; labels: readonly string[] }
  | { ok: false; error: string };

interface PullRequestLookup {
  /** "owner/repo", as GitHub Actions provides it. */
  readonly repository: string;
  readonly sha: string;
  readonly token: string;
}

/**
 * Reduce the pull requests GitHub associates with a commit to the single label
 * set the release pipeline acts on.
 *
 * A commit can map to more than one pull request (e.g. a squash-merged branch
 * that was also cherry-picked). The labels drive decisions that deploy and
 * mutate infrastructure, and no pull request is authoritative over another, so
 * taking the first one's labels is a coin flip with a wrong deploy on the other
 * side of it. Ambiguity is a hard failure the caller must surface.
 */
export function resolveAssociatedPrLabels(
  prs: readonly AssociatedPullRequest[]
): PullRequestLabelsResult {
  if (prs.length > 1) {
    const numbers = prs.map((p) => `#${String(p.number)}`).join(', ');
    return {
      ok: false,
      error:
        `Commit is associated with ${String(prs.length)} pull requests (${numbers}). ` +
        `No pull request is authoritative over another, so the release pipeline ` +
        `cannot decide which one's labels apply. Resolve the ambiguity ` +
        `(close/relabel the extra PRs) before deploying.`,
    };
  }

  return { ok: true, labels: prs.flatMap((pr) => pr.labels.map((l) => l.name)) };
}

/** Fetch the pull requests associated with a commit and reduce them to labels. */
export async function fetchAssociatedPrLabels(
  lookup: PullRequestLookup
): Promise<PullRequestLabelsResult> {
  const url = `https://api.github.com/repos/${lookup.repository}/commits/${lookup.sha}/pulls`;
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${lookup.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'hushbox-release-pipeline',
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '<unreadable body>');
    throw new Error(
      `GitHub API listPullRequestsAssociatedWithCommit returned ${String(response.status)}: ${body}`
    );
  }

  const prs = (await response.json()) as readonly AssociatedPullRequest[];

  return resolveAssociatedPrLabels(prs);
}
