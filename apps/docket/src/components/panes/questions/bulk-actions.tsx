import { useState } from 'react';
import { Button } from '@hushbox/ui';
import { TEST_IDS } from '@/test-ids';
import { ConfirmDialog } from '@/components/confirm-dialog';
import type { FindingAction } from '@/api/finding-writes';
import type { PaneWrites } from '../pane-writes';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface BulkActionsProps {
  /** Exactly what the filters admit: a bulk action never reaches past the pane. */
  readonly findings: readonly FindingJson[];
  readonly writes: PaneWrites;
  /**
   * Says when a plan is working its way down the queue. Required rather than
   * optional so that a caller which stops reporting is a compile error: an
   * unreported plan leaves the controls that wait on it looking correct and
   * doing nothing.
   */
  readonly onBulkRunning: (running: boolean) => void;
}

type BulkKind = 'deny' | 'approve';

interface BulkWrite {
  readonly finding: FindingJson;
  readonly action: FindingAction;
  readonly body: object;
}

interface Plan {
  readonly kind: BulkKind;
  readonly title: string;
  readonly confirmLabel: string;
  readonly verb: string;
  /** Each target carries the write it takes, so no target can lack one. */
  readonly targets: readonly BulkWrite[];
}

function recommendedOption(finding: FindingJson): string | null {
  return finding.options.find((option) => option.recommended)?.id ?? null;
}

function approvals(findings: readonly FindingJson[]): readonly BulkWrite[] {
  return findings.flatMap((finding) => {
    const option = recommendedOption(finding);
    return option === null ? [] : [{ finding, action: 'rule' as const, body: { option } }];
  });
}

function plans(findings: readonly FindingJson[]): readonly Plan[] {
  return [
    {
      kind: 'deny',
      title: 'Deny every finding below?',
      confirmLabel: 'Deny them',
      verb: 'Denied',
      targets: findings
        .filter((finding) => finding.state !== 'denied')
        .map((finding) => ({ finding, action: 'deny' as const, body: {} })),
    },
    {
      kind: 'approve',
      title: 'Rule every finding below as its recommended option?',
      confirmLabel: 'Approve them',
      verb: 'Approved',
      targets: approvals(findings),
    },
  ];
}

const LABELS: Record<BulkKind, string> = {
  deny: 'Deny all',
  approve: 'Approve recommended',
};

/**
 * Two sweeps over the filtered set. The confirmation names every id rather than
 * a count, because the set is whatever the filters happen to admit and a reader
 * who has lost track of that is exactly who this guards.
 */
export function BulkActions({ findings, writes, onBulkRunning }: BulkActionsProps): JSX.Element {
  const [pending, setPending] = useState<Plan | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  async function apply(plan: Plan): Promise<void> {
    setRunning(true);
    onBulkRunning(true);
    let landed = 0;
    for (const target of plan.targets) {
      if (await writes.run(target.finding, target.action, target.body)) landed += 1;
    }
    setRunning(false);
    onBulkRunning(false);
    setPending(null);
    setOutcome(`${plan.verb} ${String(landed)} of ${String(plan.targets.length)}`);
  }

  return (
    <section
      aria-label="Bulk actions"
      data-testid={TEST_IDS.bulkActions}
      className="flex flex-wrap items-center gap-2"
    >
      {plans(findings).map((plan) => (
        <Button
          key={plan.kind}
          variant="outline"
          disabled={plan.targets.length === 0}
          onClick={() => {
            setOutcome(null);
            setPending(plan);
          }}
        >
          {LABELS[plan.kind]} {plan.targets.length}
        </Button>
      ))}
      {outcome !== null && <span className="text-muted-foreground text-sm">{outcome}</span>}

      {pending !== null && (
        <ConfirmDialog
          open
          title={pending.title}
          confirmLabel={pending.confirmLabel}
          busy={running}
          onConfirm={() => {
            void apply(pending);
          }}
          onClose={() => {
            setPending(null);
          }}
        >
          <p>This writes to every one of them, and each write is undoable only one at a time.</p>
          <p className="text-foreground font-mono break-all">
            {pending.targets.map((target) => target.finding.id).join(', ')}
          </p>
        </ConfirmDialog>
      )}
    </section>
  );
}
