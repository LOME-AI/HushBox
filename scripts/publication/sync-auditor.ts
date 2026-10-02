/**
 * The read-only auditor over the publication topology.
 *
 * The topology rests on one invariant — public `main` is always an ancestor of
 * staging `main` — and on one liveness property: the mirror keeps running. Both
 * fail silently. A broken invariant looks like a repository that simply stopped
 * receiving commits, and a wedged mirror looks exactly the same from outside.
 * So something has to look, and say so where a human will see it.
 *
 * It writes nothing to either repository's history. Its only effect is one
 * issue on staging, which it opens when something is wrong and closes when
 * nothing is: an open issue means publication has stalled, and a reader needs
 * no other state to know that.
 *
 * Alerting stops there deliberately. Workflow failure plus that issue are the
 * whole channel; a pager or a mail service would be a new dependency for a
 * condition whose remedy is never urgent enough to need one.
 */
import { HOUR_MS } from '@hushbox/shared/durations';
import { isMainModule } from '../lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from '../lib/cli/command-line.js';
import { runMain } from '../lib/cli/run-main.js';
import { readRepositories } from '../configure-git-clone.js';
import { syncBotToken } from '../lib/publication/sync-bot-credential.js';
import {
  latestSuccessfulRunMillis,
  reconcileIssue,
  type IssueAction,
  type RepositoryApi,
} from '../lib/publication/api.js';
import { MAIN, branchHead, fetchRemoteBranch, isAncestor } from '../lib/publication/git.js';

/** The outbound mirror's pinned schedule, and the file the runs are read from. */
export const MIRROR_CRON = '0 0 * * *';
export const MIRROR_WORKFLOW_FILE = 'publish-mirror.yml';

/** What that schedule means in hours — one firing a day, pinned, never DST-tracking. */
export const MIRROR_PERIOD_HOURS = 24;

/**
 * Slack over a whole period, so a mirror that starts late or runs long is not
 * reported as missing. Two periods would let a whole day's publication go
 * unreported, which is the failure this exists to catch.
 */
const MIRROR_MARGIN_HOURS = 2;

/** A mirror older than this has missed its firing. The boundary itself is fresh. */
export const MIRROR_FRESHNESS_HOURS = MIRROR_PERIOD_HOURS + MIRROR_MARGIN_HOURS;

/** Stable, so the auditor recognises its own issue across passes. */
export const STALL_ISSUE_TITLE = 'Publication stalled';

export type AuditFinding = 'ancestry' | 'freshness';

interface AuditRequest {
  /** A full clone of staging, checked out at the branch that publishes. */
  readonly cwd: string;
  readonly publicUrl: string;
  /** Staging's REST surface: where the mirror's runs are read and the alert is filed. */
  readonly staging: RepositoryApi;
  /**
   * The instant to measure freshness against. A parameter rather than a clock
   * read so the window's boundary is testable; the CLI passes the real clock.
   */
  readonly nowMillis: number;
}

interface AuditResult {
  readonly findings: AuditFinding[];
  readonly issue: IssueAction;
}

async function isStale(request: AuditRequest): Promise<boolean> {
  const lastRun = await latestSuccessfulRunMillis(request.staging, MIRROR_WORKFLOW_FILE);
  if (lastRun === null) return true;
  return request.nowMillis - lastRun > MIRROR_FRESHNESS_HOURS * HOUR_MS;
}

/**
 * Both questions are asked on every pass. Stopping at the first would report a
 * stalled mirror and hide the broken ancestry underneath it, which is the pair
 * that actually occurs: a divergence is what wedges the mirror.
 */
async function findViolations(request: AuditRequest): Promise<AuditFinding[]> {
  const findings: AuditFinding[] = [];
  const stale = await isStale(request);
  const publicHead = await fetchRemoteBranch(request.cwd, request.publicUrl, MAIN);
  // The trunk by name, never the checkout's own head: a run dispatched from a
  // branch built on public's head would otherwise report the invariant intact
  // and close a genuine stall issue.
  const stagingHead = await branchHead(request.cwd, MAIN);
  if (!(await isAncestor(request.cwd, publicHead, stagingHead))) findings.push('ancestry');
  if (stale) findings.push('freshness');
  return findings;
}

const ANCESTRY_TEXT =
  `Public ${MAIN} carries a commit staging ${MAIN} does not, so the invariant the topology ` +
  'rests on is broken and the outbound mirror will refuse every publication as a ' +
  'non-fast-forward. The inbound sync has not carried the public head back. Run it, then ' +
  're-run the mirror. Never resolve this by force-pushing public.';

const FRESHNESS_TEXT =
  `The outbound mirror has not finished successfully within its freshness window of ` +
  `${String(MIRROR_FRESHNESS_HOURS)} hours, so nothing new has reached the public repository. ` +
  'Read the mirror workflow’s latest run in staging: a red run states its own refusal ' +
  'reason.';

export function describeFindings(findings: readonly AuditFinding[]): string {
  if (findings.length === 0) {
    return `Public ${MAIN} descends from staging ${MAIN} and the mirror is inside its window.`;
  }
  const lines = findings.map((finding) =>
    finding === 'ancestry' ? ANCESTRY_TEXT : FRESHNESS_TEXT
  );
  return ['Publication has stalled.', ...lines].join('\n\n');
}

export async function audit(request: AuditRequest): Promise<AuditResult> {
  const findings = await findViolations(request);
  const alert = findings.length > 0 ? describeFindings(findings) : null;
  return {
    findings,
    issue: await reconcileIssue(request.staging, STALL_ISSUE_TITLE, alert),
  };
}

export const COMMAND_LINE = {
  command: 'tsx scripts/publication/sync-auditor.ts',
  summary: 'Reports on the publication topology, changing nothing.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through CI */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const repositories = await readRepositories();
    const token = await syncBotToken(
      'The publication auditor',
      repositories.stagingRepo,
      process.env,
      fetch
    );
    const result = await audit({
      cwd: process.cwd(),
      publicUrl: `https://x-access-token:${token}@github.com/${repositories.publicRepo}.git`,
      staging: { fetchImpl: fetch, token, repository: repositories.stagingRepo },
      nowMillis: Date.now(),
    });
    const report = describeFindings(result.findings);
    if (result.findings.length > 0) {
      console.error(report);
      return 1;
    }
    console.log(report);
    return 0;
  });
}
/* v8 ignore stop */
