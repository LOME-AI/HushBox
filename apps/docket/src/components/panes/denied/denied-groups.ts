// The narrow path, never the package barrel: the barrel reaches the store and
// the citation index, whose node imports cannot load in a browser.
import { DENIAL_AUTHORS } from '@hushbox/docket/types';
import { orderByMostRecentAction } from '../decided-order';
import type { DenialAuthor, FindingJson } from '@hushbox/docket';

interface DeniedGroup {
  readonly by: DenialAuthor;
  readonly label: string;
  readonly findings: readonly FindingJson[];
}

/**
 * The reader's own refusals first, the audit's refutations after: one is a
 * record of decisions taken here, the other is what the audit already ruled out
 * before anybody opened the console.
 */
const LABELS: Record<DenialAuthor, string> = {
  human: 'Denied by you',
  audit: 'Refuted by the audit',
};

// Reading order is this map, not the registry's declaration order, so nothing
// re-sorts the pane by editing a domain constant. The set still comes from the
// registry, so a new author cannot be silently left out of the pane.
const RANK: Record<DenialAuthor, number> = { human: 0, audit: 1 };

const ORDER: readonly DenialAuthor[] = DENIAL_AUTHORS.toSorted(
  (left, right) => RANK[left] - RANK[right]
);

export function deniedGroups(findings: readonly FindingJson[]): readonly DeniedGroup[] {
  return ORDER.map((by) => ({
    by,
    label: LABELS[by],
    findings: orderByMostRecentAction(findings.filter((finding) => finding.denial?.by === by)),
  })).filter((group) => group.findings.length > 0);
}
