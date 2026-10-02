import { useState } from 'react';
import { Button } from '@hushbox/ui';
import { Info } from '@hushbox/ui/icons';
import { Notice } from '@hushbox/ui/notice';
import type { JSX } from 'react';

/**
 * A link the console could not honour as written. The url is repaired on
 * arrival, so without this the reader is left on a section they did not ask for
 * with nothing on screen naming the finding they did.
 */
export function ArrivalNotice({
  message,
}: Readonly<{ message: string | null }>): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false);

  if (message === null || dismissed) return null;

  return (
    <div className="border-border border-b">
      <Notice
        tone="neutral"
        icon={Info}
        destructive={false}
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
        {message}
      </Notice>
    </div>
  );
}
