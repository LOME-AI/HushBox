import * as React from 'react';
import { TEST_IDS, TEST_SIGNALS } from '@hushbox/shared';
import { cn } from '@hushbox/ui';

/**
 * Stands in for a message written under keys that failed verification. It is
 * chrome, not the sender's words, so it stays in the sans even inside a
 * reading bubble.
 */
export function InvalidKeysNotice({
  className,
}: Readonly<{ className?: string | undefined }>): React.JSX.Element {
  return (
    <p
      data-testid={TEST_IDS.messageInvalidKeys}
      {...{ [TEST_SIGNALS.epochState]: 'bad' }}
      className={cn('text-muted-foreground font-sans text-sm', className)}
    >
      Unreadable: written under invalid keys
    </p>
  );
}
