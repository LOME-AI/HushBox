import { useMemo } from 'react';
import { AlertTriangle, Info } from '@hushbox/ui/icons';
import { Notice } from '@hushbox/ui/notice';
import { TEST_IDS } from '@/test-ids';
import { FindingChips } from './finding-chips';
import { groupPartners } from './logic/group-partners';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface FindingBannersProps {
  readonly finding: FindingJson;
  readonly findings: readonly FindingJson[];
  readonly onJump: (id: string) => void;
}

/**
 * The findings that name this one without this one naming them back. `related`
 * is written by hand on one side of a pair, so a reader ruling the other side
 * first is ruling blind to the tie — and the ties run both ways across the
 * corpus, including onto open criticals. Deriving the reverse direction here
 * rather than writing the missing halves into the corpus also covers whatever
 * one-sided links the audit adds next.
 *
 * A link the reader is already being shown is left out: a reciprocated one
 * belongs to the outbound row, and one from a group partner to the group box.
 */
function inboundLinks(finding: FindingJson, findings: readonly FindingJson[]): readonly string[] {
  const shown = new Set([...finding.related, ...groupPartners(finding.group, finding.id)]);
  return findings
    .filter((other) => other.related.includes(finding.id) && !shown.has(other.id))
    .map((other) => other.id);
}

/**
 * Everything that has to be read before the finding itself: that the audit
 * flagged it, that it is one of a set that has to be ruled together, and what
 * else it touches.
 */
export function FindingBanners({ finding, findings, onJump }: FindingBannersProps): JSX.Element {
  const inbound = useMemo(() => inboundLinks(finding, findings), [finding, findings]);

  return (
    <>
      {finding.warning && (
        <Notice tone="warning" icon={AlertTriangle} destructive={false}>
          The audit flagged this one: read this one before ruling it.
        </Notice>
      )}
      {finding.dedicated && (
        <Notice
          tone="neutral"
          icon={Info}
          destructive={false}
          data-testid={TEST_IDS.dedicatedBanner}
        >
          Owed a session of its own: too large for one task, or a design to settle before code.
        </Notice>
      )}
      {finding.group !== null && (
        <div className="border-border bg-muted/30 flex flex-col gap-2 rounded-md border p-3">
          <p className="text-muted-foreground text-sm">
            Grouped as <span className="font-mono">{finding.group}</span>. Rule the group together.
          </p>
          <FindingChips
            label="In this group"
            ids={groupPartners(finding.group, finding.id)}
            findings={findings}
            onJump={onJump}
          />
        </div>
      )}
      <FindingChips label="Links to" ids={finding.related} findings={findings} onJump={onJump} />
      <FindingChips label="Linked from" ids={inbound} findings={findings} onJump={onJump} />
    </>
  );
}
