import { Badge } from '@hushbox/ui/marks';
import { hasOutstandingQuestion, outstandingQuestions } from '@hushbox/docket/types';
import { TEST_IDS } from '@/test-ids';
import type { FindingJson, Ruling } from '@hushbox/docket';
import type { JSX } from 'react';

/**
 * The id a free-text ruling is filed under. One declaration, because the writer
 * and the reader of a ruling have to agree on it: if they drift, the same
 * ruling is the reader's own words in one place and "Option other" in another.
 */
export const FREE_TEXT_OPTION = 'other';

/**
 * What a ruling settled, in the reader's terms. The option id alone is not an
 * answer to "what was decided" on a finding whose options are further down the
 * card, so the option's own label is pulled in wherever the finding still
 * carries it. Every surface that states a decision reads it from here: a row
 * that named the letter and a card that named the option were the same
 * decision reading as two.
 */
export function decided(ruling: Ruling, finding: FindingJson): string {
  if (ruling.option === FREE_TEXT_OPTION && ruling.text !== null) return ruling.text;
  const chosen = finding.options.find((option) => option.id === ruling.option);
  const named = `Option ${ruling.option}`;
  return chosen === undefined ? named : `${named}: ${chosen.label}`;
}

function replaced(count: number): string {
  return `Replaces ${String(count)} earlier decision${count === 1 ? '' : 's'}`;
}

interface Headline {
  readonly label: string;
  /** Null where the state has nothing dated behind it, which a question can be. */
  readonly at: string | null;
  /** Who denied it; a ruling is always the reader's, so it names nobody. */
  readonly by: string | null;
}

function headlineOf(finding: FindingJson): Headline | null {
  const { ruling, denial } = finding;
  if (ruling !== null) return { label: 'Ruled', at: ruling.at, by: null };
  if (denial !== null) {
    return { label: 'Denied', at: denial.at, by: denial.by === 'audit' ? 'the audit' : 'you' };
  }
  // A question is not a decision, but on an undecided finding it is the one
  // thing said about it, so the card still leads with it.
  if (hasOutstandingQuestion(finding)) {
    return { label: 'Question open', at: finding.questions.at(-1)?.at ?? null, by: null };
  }
  return null;
}

/**
 * What is still outstanding on the finding, stated where its state is stated,
 * so a reader who lands on the card reads the question rather than only a chip
 * saying one exists. Outstanding-ness comes from the one shared reader rather
 * than being filtered again here: a second definition of "still outstanding"
 * would put a question on the card that the questions pane no longer lists.
 */
function HeldQuestions({ finding }: Readonly<{ finding: FindingJson }>): JSX.Element | null {
  const asked = outstandingQuestions(finding);
  if (asked.length === 0) return null;

  return (
    <>
      <p className="text-muted-foreground text-sm">Waiting on the implementation agent.</p>
      {asked.map((question) => (
        <p key={question.index} className="text-foreground text-sm break-words">
          {question.text}
        </p>
      ))}
    </>
  );
}

/** The option a decision settled on, for anything that has to render it as taken. */
export function chosenOption(finding: FindingJson): string | null {
  return finding.ruling === null ? null : finding.ruling.option;
}

/**
 * The state a finding is already in, stated before anything that would change
 * it. Without this the card reads identically whether or not it has been ruled,
 * and the reader supersedes work they cannot see; the same holds for a finding
 * the audit is holding on a question.
 */
export function DecisionSummary({
  finding,
}: Readonly<{ finding: FindingJson }>): JSX.Element | null {
  const { ruling, denial } = finding;
  const headline = headlineOf(finding);
  if (headline === null) return null;

  return (
    <section
      data-testid={TEST_IDS.decisionSummary}
      className="border-border bg-muted/40 flex flex-col gap-1 rounded-md border p-3"
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{headline.label}</Badge>
        {headline.at !== null && (
          <span className="text-muted-foreground text-sm">{headline.at}</span>
        )}
        {headline.by !== null && (
          <span className="text-muted-foreground text-sm">by {headline.by}</span>
        )}
      </div>
      <HeldQuestions finding={finding} />
      {ruling !== null && (
        <>
          <p className="text-foreground text-sm break-words">{decided(ruling, finding)}</p>
          {ruling.note !== null && (
            <p className="text-muted-foreground text-sm break-words">{ruling.note}</p>
          )}
        </>
      )}
      {denial !== null && (
        <p className="text-muted-foreground text-sm break-words">
          {denial.reason ?? 'No reason recorded'}
        </p>
      )}
      {finding.history.length > 0 && (
        <p className="text-muted-foreground text-sm">{replaced(finding.history.length)}</p>
      )}
    </section>
  );
}
