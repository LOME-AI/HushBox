import * as React from 'react';
import { Button } from '@hushbox/ui/button';
import { ChevronRight, GitBranch } from '@hushbox/ui/icons';

export interface ForkMarkProps {
  /** How many other branches part at this point. */
  readonly more: number;
  /** Opens the conversation's branches. */
  readonly onOpen: () => void;
}

/**
 * The thread's mark where branches part: a quiet rule with "Branched here · N more" at its
 * centre, which opens the branch switcher. Below 768 it is the way into the switcher.
 */
export function ForkMark({ more, onOpen }: Readonly<ForkMarkProps>): React.JSX.Element {
  return (
    <div
      data-chrome=""
      className="text-muted-foreground before:bg-border after:bg-border flex items-center gap-3 text-xs before:h-px before:flex-1 after:h-px after:flex-1"
    >
      <Button
        variant="link"
        aria-haspopup="dialog"
        onClick={onOpen}
        className="text-muted-foreground hover:text-primary gap-1.5 text-xs font-normal"
      >
        <GitBranch aria-hidden="true" className="size-3.5" />
        Branched here · {more} more
        <ChevronRight aria-hidden="true" className="size-3.5" />
      </Button>
    </div>
  );
}
