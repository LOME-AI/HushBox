import { Button } from '@hushbox/ui';
import { TEST_IDS } from '@/test-ids';
import type { PaneWrites } from '../pane-writes';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface QuestionActionsProps {
  readonly finding: FindingJson;
  readonly writes: PaneWrites;
}

/**
 * What each question is still owed, and the one thing this surface can do about
 * it: withdraw a question the reader has settled themselves. Answering belongs
 * to the implementation agent, so it has no control here — an answer written
 * from this screen would be recorded under the agent's name.
 */
export function QuestionActions({ finding, writes }: QuestionActionsProps): JSX.Element | null {
  const error = writes.errorFor(finding.id);

  if (finding.questions.length === 0) return null;

  return (
    <section aria-label={`Questions on ${finding.id}`} className="flex max-w-prose flex-col gap-3">
      {finding.questions.map((question, index) => (
        <div
          key={`${question.at}-${String(index)}`}
          className="border-border flex flex-col gap-2 rounded-md border p-3 text-base"
        >
          <p className="text-foreground break-words">{question.text}</p>

          {question.answer === null ? (
            <span className="text-muted-foreground italic">waiting on an agent</span>
          ) : (
            <p className="text-foreground break-words">{question.answer}</p>
          )}

          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              data-testid={TEST_IDS.questionWithdraw}
              onClick={() => {
                void writes.run(finding, 'withdraw', { index });
              }}
            >
              Withdraw
            </Button>
          </div>
        </div>
      ))}
      {error !== null && (
        <p data-testid={TEST_IDS.paneError} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
    </section>
  );
}
