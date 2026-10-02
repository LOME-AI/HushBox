import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  PROGRESS_RESET_CONSEQUENCE,
  describeProgressWork,
  hasProgressWork,
  isDecided,
} from '@/components/decided-work';
import type { RulingInput } from './hooks/use-ruling-actions';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

/** A decision waiting on the reader's word, because taking it discards the current one. */
export type PendingDecision =
  | { readonly kind: 'rule'; readonly input: RulingInput }
  | { readonly kind: 'deny'; readonly reason: string | null }
  | { readonly kind: 'reopen' };

interface DiscardPromptProps {
  readonly finding: FindingJson;
  readonly pending: PendingDecision | null;
  readonly onConfirm: (pending: PendingDecision) => void;
  readonly onClose: () => void;
}

interface Wording {
  readonly title: string;
  readonly confirm: string;
}

/**
 * Reopening is offered only where there is a decision to take back, so it reads
 * the same either way and is named once rather than written into both columns.
 */
const REOPEN: Wording = { title: 'Reopen, and discard the decision on', confirm: 'Reopen it' };

/**
 * Two different things bring this dialog up and it says which. A decision that
 * replaces one archives it, and ruling, denying and reopening all archive it
 * through the same `clearing()` call, so all three ask that question in the same
 * words. A first decision on a finding an agent has already worked on archives
 * nothing and changes no ruling: what it costs is the work, and saying otherwise
 * would make the dialog false in one of the two cases it exists for.
 */
const COPY: Record<PendingDecision['kind'], Record<'superseding' | 'first', Wording>> = {
  rule: {
    superseding: { title: 'Change the ruling on', confirm: 'Change it' },
    first: { title: 'Rule, and discard the work recorded on', confirm: 'Rule on it' },
  },
  deny: {
    superseding: { title: 'Deny, and discard the ruling on', confirm: 'Deny it' },
    first: { title: 'Deny, and discard the work recorded on', confirm: 'Deny it' },
  },
  reopen: { superseding: REOPEN, first: REOPEN },
};

export function DiscardPrompt({
  finding,
  pending,
  onConfirm,
  onClose,
}: DiscardPromptProps): JSX.Element | null {
  if (pending === null) return null;
  const decided = isDecided(finding);
  const copy = COPY[pending.kind][decided ? 'superseding' : 'first'];

  return (
    <ConfirmDialog
      open
      title={`${copy.title} ${finding.id}?`}
      confirmLabel={copy.confirm}
      onConfirm={() => {
        onConfirm(pending);
      }}
      onClose={onClose}
    >
      {/* Most findings carry a decision and no work against it, and
          "no progress notes are recorded against it" reads as an argument for
          going ahead in the one sentence whose job is to give the reader
          pause. The work is named only where there is some. */}
      {hasProgressWork(finding) && (
        <>
          <p>{describeProgressWork(finding)}</p>
          <p>{PROGRESS_RESET_CONSEQUENCE}</p>
        </>
      )}
      {decided && (
        <p>The decision it carries now is archived into the finding&apos;s history, not lost.</p>
      )}
    </ConfirmDialog>
  );
}
