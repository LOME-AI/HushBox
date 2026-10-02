import { useState } from 'react';
import { Button } from '@hushbox/ui';
import { TEST_IDS } from '@/test-ids';
import { ConfirmDialog } from '@/components/confirm-dialog';
import {
  PROGRESS_RESET_CONSEQUENCE,
  describeProgressWork,
  hasProgressWork,
} from '@/components/decided-work';
import type { PaneWrites } from './pane-writes';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface ReopenButtonProps {
  readonly finding: FindingJson;
  readonly writes: PaneWrites;
}

export function ReopenButton({ finding, writes }: ReopenButtonProps): JSX.Element {
  const [asking, setAsking] = useState(false);
  const error = writes.errorFor(finding.id);

  function reopen(): void {
    setAsking(false);
    void writes.run(finding, 'reopen', {});
  }

  return (
    <>
      <Button
        variant="outline"
        data-testid={TEST_IDS.reopenFinding}
        onClick={() => {
          // Reopening discards the decision the finding carries, and the
          // button is offered only where it carries one, so the reader is
          // always being asked to give something up. The card asks the same
          // question before re-ruling one.
          setAsking(true);
        }}
      >
        Reopen
      </Button>
      {error !== null && (
        <p data-testid={TEST_IDS.paneError} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      {asking && (
        <ConfirmDialog
          open
          title={`Reopen ${finding.id}?`}
          confirmLabel="Reopen it"
          onConfirm={reopen}
          onClose={() => {
            setAsking(false);
          }}
        >
          {hasProgressWork(finding) && (
            <>
              <p>{describeProgressWork(finding)}</p>
              <p>{PROGRESS_RESET_CONSEQUENCE}</p>
            </>
          )}
          <p>The decision is archived into the finding&apos;s history, not lost.</p>
          {finding.options.length === 0 && (
            <p>It carries no options, so it goes back to the audit for them.</p>
          )}
        </ConfirmDialog>
      )}
    </>
  );
}
