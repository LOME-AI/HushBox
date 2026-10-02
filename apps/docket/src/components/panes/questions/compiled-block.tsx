import { useState } from 'react';
import { Button, useCopyToClipboard } from '@hushbox/ui';
import { formatQuestionsBrief } from '@hushbox/docket/brief';
import { hasOutstandingQuestion } from '@hushbox/docket/types';
import { TEST_IDS } from '@/test-ids';
import type { FindingJson } from '@hushbox/docket';
import type { JSX } from 'react';

interface CompiledBlockProps {
  /** The pane's findings, already narrowed by the active filters. */
  readonly findings: readonly FindingJson[];
}

/**
 * Every outstanding question in one document, to be handed to an implementation
 * agent whole rather than one finding at a time. The block is rendered as
 * selectable text rather than held only in a copy handler, so a reader whose
 * clipboard is refused still has a way to take it.
 */
export function CompiledBlock({ findings }: CompiledBlockProps): JSX.Element {
  const { copy, copied } = useCopyToClipboard();
  const [refused, setRefused] = useState(false);
  const block = formatQuestionsBrief(findings);
  const covered = findings.filter((finding) => hasOutstandingQuestion(finding)).length;

  if (block === null) {
    return <p className="text-muted-foreground text-sm">No question is waiting on an agent yet</p>;
  }

  return (
    <section aria-label="Questions brief" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-muted-foreground text-sm font-semibold uppercase">
          Waiting on an agent
        </h2>
        <span className="text-muted-foreground text-sm">
          {covered} {covered === 1 ? 'finding' : 'findings'}
        </span>
        <Button
          variant="outline"
          data-testid={TEST_IDS.compiledQuestionsCopy}
          onClick={() => {
            void (async (): Promise<void> => {
              setRefused(!(await copy(block)));
            })();
          }}
        >
          {copied ? 'Copied' : 'Copy questions brief'}
        </Button>
      </div>
      {refused && (
        <p role="alert" className="text-destructive text-sm">
          The clipboard refused. Select the block and copy it by hand.
        </p>
      )}
      <pre
        data-testid={TEST_IDS.compiledQuestions}
        className="border-border bg-muted text-foreground max-h-80 overflow-auto rounded-md border p-3 text-sm whitespace-pre-wrap"
      >
        <code>{block}</code>
      </pre>
    </section>
  );
}
