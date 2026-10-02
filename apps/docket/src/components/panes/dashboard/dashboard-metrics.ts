// The narrow path, never the package barrel: the barrel reaches the store and
// the citation index, whose node imports cannot load in a browser.
import { SEVERITIES } from '@hushbox/docket/types';
import { isBlocked } from '@/components/decided-work';
import { areaOptions } from '@/components/shell/logic/filters';
import { sectionSpec } from '@/components/shell/logic/sections';
import type { AreaOption } from '@/components/shell/logic/filters';
import type { FindingJson, Severity } from '@hushbox/docket';

interface SeverityCount {
  readonly severity: Severity;
  readonly count: number;
}

interface DashboardMetrics {
  readonly total: number;
  /** Undecided: the work that still needs a human. */
  readonly awaiting: number;
  readonly settledByAudit: number;
  readonly decidedByHuman: number;
  readonly blocked: number;
  /** Findings held back for a session of their own rather than an ordinary task. */
  readonly dedicated: number;
  readonly bySeverity: readonly SeverityCount[];
  readonly byArea: readonly AreaOption[];
}

function isAwaiting(finding: FindingJson): boolean {
  return finding.state === 'open';
}

/**
 * A ruling records no author, so the reader's rulings are told from the audit's
 * two ways: the audit only ships `ruled` with `needs_ruling: false`, and
 * reopening archives the outgoing decision into `history`, so a finding that
 * carries any history has been through a human's hands.
 */
function isDecidedByHuman(finding: FindingJson): boolean {
  if (finding.state === 'ruled') return finding.needsRuling || finding.history.length > 0;
  return finding.state === 'denied' && finding.denial?.by === 'human';
}

/**
 * Most of an audit is settled before a human sees it: a finding obvious enough
 * to rule on sight ships `ruled` with `needs_ruling: false`, and a refuted one
 * ships denied by the audit. Both are decided, neither is anyone's progress, so
 * they are counted apart from the decisions this reader made.
 */
function isSettledByAudit(finding: FindingJson): boolean {
  if (finding.state === 'ruled') return !isDecidedByHuman(finding);
  return finding.state === 'denied' && finding.denial?.by === 'audit';
}

export function dashboardMetrics(findings: readonly FindingJson[]): DashboardMetrics {
  const remaining = findings.filter((finding) => isAwaiting(finding));
  return {
    total: findings.length,
    awaiting: remaining.length,
    settledByAudit: findings.filter((finding) => isSettledByAudit(finding)).length,
    decidedByHuman: findings.filter((finding) => isDecidedByHuman(finding)).length,
    // The same predicate the Blocked queue is built from, because this figure is
    // the way into that queue: a second spelling would let the count and the
    // pane it opens disagree.
    blocked: findings.filter((finding) => isBlocked(finding)).length,
    // Read through the Dedicated queue's own predicate, for the reason the
    // blocked count gives: a figure and the queue it names have to agree.
    dedicated: findings.filter((finding) => sectionSpec('dedicated').holds(finding)).length,
    bySeverity: SEVERITIES.map((severity) => ({
      severity,
      count: remaining.filter((finding) => finding.severity === severity).length,
    })),
    byArea: areaOptions(remaining),
  };
}
