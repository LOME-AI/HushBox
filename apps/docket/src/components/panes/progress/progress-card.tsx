import { CheckField } from '@hushbox/ui/field';
import { Badge } from '@hushbox/ui/marks';
// The narrow path, never the package barrel: the barrel reaches the store and
// the citation index, whose node imports cannot load in a browser.
import { PROGRESS_STATUSES } from '@hushbox/docket/types';
import { FindingTitle } from '@/components/finding/finding-title';
import { PromptForm } from '@/components/finding/prompt-form';
import { Stamp } from '@/components/stamp';
import { TEST_IDS } from '@/test-ids';
import { SeverityBadge } from '@/components/shell/severity-badge';
import { STATUS_LABELS } from './board-order';
import { ProgressNotes } from './progress-notes';
import type { ProgressActions } from './use-progress-actions';
import type { FindingJson, ProgressStatus } from '@hushbox/docket';
import type { JSX } from 'react';

interface ProgressCardProps {
  readonly finding: FindingJson;
  readonly actions: ProgressActions;
}

const STATUS_VALUES: readonly string[] = PROGRESS_STATUSES;

function isProgressStatus(value: string): value is ProgressStatus {
  return STATUS_VALUES.includes(value);
}

export function ProgressCard({ finding, actions }: ProgressCardProps): JSX.Element {
  const { progress } = finding;
  const statusId = `progress-status-${finding.id}`;
  const verifiedId = `progress-verified-${finding.id}`;
  const error = actions.errorFor(finding.id);

  return (
    <article
      data-testid={TEST_IDS.progressCard}
      className="border-border bg-card flex flex-col gap-2 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-foreground font-mono text-sm">{finding.id}</span>
        <SeverityBadge severity={finding.severity} />
        {progress.verified && <Badge tone="neutral">verified</Badge>}
      </div>
      {/* No display utility beside the clamp: `line-clamp-2` sets its own
          display, and overriding it silently un-clamps the longest titles. */}
      <FindingTitle
        className="text-foreground line-clamp-2 text-sm break-words"
        html={finding.titleHtml}
      />
      <p className="text-muted-foreground font-mono text-sm break-all">{finding.area}</p>
      {/* The agent's own last report, not the reader's: a note or a verification
          typed here leaves it where it was. */}
      {progress.updated !== null && (
        <p className="text-muted-foreground text-sm">
          last reported <Stamp at={progress.updated} />
        </p>
      )}

      <div className="flex flex-col gap-1">
        <label htmlFor={statusId} className="sr-only">
          Status for {finding.id}
        </label>
        <select
          id={statusId}
          data-testid={TEST_IDS.progressStatus}
          value={progress.status}
          onChange={(event) => {
            if (isProgressStatus(event.target.value)) {
              actions.setStatus(finding, event.target.value);
            }
          }}
          className="border-border bg-background text-foreground focus-visible:ring-ring w-full rounded-md border px-2 py-1 text-sm outline-none focus-visible:ring-2"
        >
          {PROGRESS_STATUSES.map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>

      {/* An agent saying it is done is not the same claim as the reader having
          checked it, so verification is offered once the work claims done. It
          stays reachable while it is set, because an agent moving the status off
          `done` cannot clear a human-owned field: without the control the
          reader's judgement would be stranded on work no longer claimed done. */}
      {(progress.status === 'done' || progress.verified) && (
        <CheckField
          id={verifiedId}
          checked={progress.verified}
          onCheckedChange={(checked) => {
            actions.setVerified(finding, checked);
          }}
          label="Verified"
        />
      )}

      <ProgressNotes notes={progress.notes} />

      <PromptForm
        title={`Note on ${finding.id}`}
        placeholder="what is holding this up, or what was found"
        submitLabel="Add note"
        onSubmit={(text) => {
          actions.addNote(finding, text);
        }}
      />

      {error !== null && (
        <p data-testid={TEST_IDS.progressError} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </article>
  );
}
