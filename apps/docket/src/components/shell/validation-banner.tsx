import { useState } from 'react';
import { Button } from '@hushbox/ui';
import { AlertTriangle } from '@hushbox/ui/icons';
import { Notice } from '@hushbox/ui/notice';
import { TEST_IDS } from '@/test-ids';
import type { ValidationEntry } from '@hushbox/docket';
import type { JSX } from 'react';

/**
 * A finding the format rejected is invisible everywhere else in the console, so
 * the reader is told rather than left with a queue that is quietly short.
 */
export function ValidationBanner({
  entries,
}: Readonly<{ entries: readonly ValidationEntry[] }>): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);

  if (entries.length === 0 || dismissed) return null;

  return (
    <Notice
      tone="error"
      icon={AlertTriangle}
      destructive
      data-testid={TEST_IDS.validationBanner}
      title={
        entries.length === 1
          ? '1 finding could not be read and is missing from every section'
          : `${String(entries.length)} findings could not be read and are missing from every section`
      }
      end={
        <Button
          variant="outline"
          onClick={() => {
            setDismissed(true);
          }}
        >
          Dismiss
        </Button>
      }
    >
      <ul className="mt-1 flex flex-col gap-0.5">
        {entries.map((entry) => (
          <li key={entry.id} className="font-mono text-sm break-words">
            {entry.id}: {entry.issues.map((issue) => issue.message).join('; ')}
          </li>
        ))}
      </ul>
    </Notice>
  );
}
