import { hasOutstandingQuestion } from '@hushbox/docket/types';
import { FindingTitle } from '@/components/finding/finding-title';
import { usePaneWrites } from '../pane-writes';
import { BulkActions } from './bulk-actions';
import { CompiledBlock } from './compiled-block';
import { QuestionActions } from './question-actions';
import type { ApiDeps } from '@/api/finding-writes';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface QuestionsLeadProps {
  /** The questioned findings the filters admit. */
  readonly findings: readonly FindingJson[];
  readonly put: (finding: FindingJson) => void;
  /** Passed straight to the bulk sweeps, which are the only thing here that runs a plan. */
  readonly onBulkRunning: (running: boolean) => void;
  readonly api?: ApiDeps;
}

/**
 * The pane's working surface, above the queue: what each finding still owes an
 * answer on, the one brief that covers all of it, and the two sweeps over the
 * whole filtered set. The queue below stays the ruling loop, so a questioned
 * finding is still ruled the same way as any other.
 */
export function QuestionsLead({
  findings,
  put,
  onBulkRunning,
  api,
}: QuestionsLeadProps): JSX.Element {
  const writes = usePaneWrites(api === undefined ? { put } : { put, api });
  // The card repeats the thread read-only, so this is the only place a question
  // can be withdrawn.
  const open = findings.filter((finding) => hasOutstandingQuestion(finding));

  return (
    <div className="border-border flex flex-col gap-5 border-b p-4">
      {open.length > 0 && (
        <section className="flex flex-col gap-3">
          <h2 className="text-muted-foreground flex items-baseline gap-2 text-sm font-semibold uppercase">
            Open questions
            <span className="font-mono tabular-nums">{open.length}</span>
          </h2>
          {open.map((finding) => (
            <div key={finding.id} className="flex flex-col gap-2">
              <h3 className="text-foreground flex max-w-prose flex-wrap items-baseline gap-2 text-sm">
                <span className="font-mono">{finding.id}</span>
                <FindingTitle
                  as="span"
                  className="text-muted-foreground break-words"
                  html={finding.titleHtml}
                />
              </h3>
              <QuestionActions finding={finding} writes={writes} />
            </div>
          ))}
        </section>
      )}

      <CompiledBlock findings={findings} />
      <BulkActions findings={findings} writes={writes} onBulkRunning={onBulkRunning} />
    </div>
  );
}
