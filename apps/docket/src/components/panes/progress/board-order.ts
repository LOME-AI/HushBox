import type { FindingJson, ProgressStatus } from '@hushbox/docket';

/**
 * Attention order rather than pipeline order: what is stuck, what is moving,
 * what has not started, what is finished. Blocked work is the only column that
 * needs someone today, so it is the first thing the board says.
 */
export const COLUMN_ORDER: readonly ProgressStatus[] = [
  'blocked',
  'in-progress',
  'not-started',
  'done',
];

export const STATUS_LABELS: Record<ProgressStatus, string> = {
  blocked: 'Blocked',
  'in-progress': 'In progress',
  'not-started': 'Not started',
  done: 'Done',
};

interface BoardColumn {
  readonly status: ProgressStatus;
  readonly findings: readonly FindingJson[];
}

export function boardColumns(findings: readonly FindingJson[]): readonly BoardColumn[] {
  return COLUMN_ORDER.map((status) => ({
    status,
    findings: findings.filter((finding) => finding.progress.status === status),
  }));
}
