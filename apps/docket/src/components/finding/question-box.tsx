import { PromptForm } from './prompt-form';
import type { Question } from '@hushbox/docket';
import type { JSX } from 'react';

export interface QuestionBoxProps {
  readonly questions: readonly Question[];
  /** The request that sent the caret here, because a shortcut asked to ask something. */
  readonly focused: number | null;
  readonly onAsk: (text: string) => void;
  /** A question written and not yet sent, which the console's keyboard stays out of. */
  readonly onDrafting: (drafting: boolean) => void;
}

/**
 * What has been asked of an implementation agent about this finding, and the
 * box the next question is written in. Asking is offered whatever state the
 * finding is in: a question is a request for information, not a decision, so a
 * ruled finding takes one without the ruling being taken back.
 *
 * The thread is shown unconditionally. The card renders only in focus mode, and
 * focus mode scrolls the card to the top of the pane, so any pane above it is
 * off screen by the time the reader arrives: there is no arrangement in which
 * these questions are already visible somewhere else.
 */
export function QuestionBox({
  questions,
  focused,
  onAsk,
  onDrafting,
}: QuestionBoxProps): JSX.Element {
  return (
    <section aria-label="Questions" className="flex flex-col gap-2">
      <h3 className="text-muted-foreground text-sm font-semibold uppercase">Questions</h3>
      {questions.map((entry, index) => (
        <div
          key={`${entry.at}-${String(index)}`}
          className="border-border flex flex-col gap-1 rounded-md border p-2 text-base"
        >
          <p className="text-foreground break-words">{entry.text}</p>
          {entry.answer === null ? (
            <span className="text-muted-foreground italic">waiting for an answer</span>
          ) : (
            <p className="text-foreground break-words">{entry.answer}</p>
          )}
        </div>
      ))}
      <PromptForm
        title="Ask the implementation agent"
        placeholder="what do you need the agent to find out?"
        submitLabel="Ask the agent"
        focus={focused}
        onSubmit={onAsk}
        onDrafting={onDrafting}
      />
    </section>
  );
}
