import { Stamp } from '@/components/stamp';
import { TEST_IDS } from '@/test-ids';
import type { ProgressNote } from '@hushbox/docket';
import type { JSX } from 'react';

export function ProgressNotes({
  notes,
}: Readonly<{ notes: readonly ProgressNote[] }>): JSX.Element | null {
  if (notes.length === 0) return null;

  return (
    <ol className="flex flex-col gap-1.5">
      {notes.map((note) => (
        <li
          key={`${note.at}-${note.text}`}
          data-testid={TEST_IDS.progressNote}
          className="border-border/60 flex flex-col gap-0.5 border-l pl-2"
        >
          <span className="text-muted-foreground flex gap-2 text-sm">
            <Stamp at={note.at} />
            <span>{note.by}</span>
          </span>
          <span className="text-foreground text-sm break-words">{note.text}</span>
        </li>
      ))}
    </ol>
  );
}
