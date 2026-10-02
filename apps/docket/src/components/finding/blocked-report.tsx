// The narrow path, never the package barrel: the barrel reaches the store and
// the citation index, whose node imports cannot load in a browser.
import { accountAndReplies } from '@hushbox/docket/types';
import { isBlocked } from '@/components/decided-work';
import { ProgressNotes } from '@/components/panes/progress/progress-notes';
import { Stamp } from '@/components/stamp';
import { TEST_IDS } from '@/test-ids';
import type { FindingJson, ProgressNote } from '@hushbox/docket';
import type { JSX } from 'react';

/** One half of the exchange, or nothing where that half is empty. */
function NoteBlock({
  testId,
  heading,
  notes,
}: Readonly<{
  testId: string;
  heading: string;
  notes: readonly ProgressNote[];
}>): JSX.Element | null {
  if (notes.length === 0) return null;

  return (
    <section
      data-testid={testId}
      className="border-border bg-muted/40 mx-4 flex flex-col gap-1 rounded-md border p-3"
    >
      <h3 className="text-muted-foreground text-sm font-semibold uppercase">{heading}</h3>
      <ProgressNotes notes={notes} />
    </section>
  );
}

/**
 * Where a stopped ruling got to, put where the ruling can be changed. The reason
 * and the controls that answer it used to sit in different panes, so resolving
 * one meant carrying the reason across from memory.
 *
 * Three independent facts, because any of them can be missing without the
 * others: an agent can block through the CLI without writing a reason, which
 * stamps the report time and appends no note. Binding the stamp to the note
 * would leave that finding — the one with least on screen — showing neither,
 * which is the case that most needs "when did this last move" answered.
 *
 * Both halves of the thread are shown whole. There is room for them here, and
 * the reader is writing the reply against them: a run trimmed to its last note
 * hides the work the agent did before it stopped.
 */
export function BlockedReport({ finding }: Readonly<{ finding: FindingJson }>): JSX.Element | null {
  const { progress } = finding;
  if (!isBlocked(finding)) return null;
  const { account, replies } = accountAndReplies(progress.notes);

  return (
    <>
      {progress.updated !== null && (
        <p data-testid={TEST_IDS.blockedStamp} className="text-muted-foreground mx-4 text-sm">
          last reported <Stamp at={progress.updated} />
        </p>
      )}
      <NoteBlock testId={TEST_IDS.blockingNote} heading="Why the work stopped" notes={account} />
      <NoteBlock testId={TEST_IDS.blockingReplies} heading="Answered since" notes={replies} />
    </>
  );
}
