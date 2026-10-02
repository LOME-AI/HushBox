import * as React from 'react';
import { Search } from 'lucide-react';
import { Button, ThemeToggle } from '@hushbox/ui';
import { TEST_IDS } from '@hushbox/shared';
import { usePalette } from '@/components/palette/palette-provider';
import { ActorSwitcher } from './actor-switcher.js';

export function AdminTopbar(): React.JSX.Element {
  const { setOpen } = usePalette();
  // The row wraps: at a phone width the search trigger and the trailing group
  // each fit it alone and do not fit it together, and the shell clips
  // horizontally with no scrollbar, so a row held to one line puts the
  // trailing controls where nothing can reach them. The trigger is capped
  // rather than fixed because `w-64` is rem-sized: at the accessibility
  // widget's largest font tier it is wider than the whole row on its own.
  return (
    <header
      data-chrome=""
      data-testid={TEST_IDS.adminTopbar}
      className="border-border flex min-h-[var(--app-header-height)] shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2"
    >
      <Button
        variant="outline"
        size="sm"
        data-testid={TEST_IDS.adminSearch}
        className="text-muted-foreground w-64 max-w-full justify-start"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Search className="mr-2 h-4 w-4" />
        Search
        <kbd className="bg-muted ml-auto rounded px-1.5 font-mono text-xs">⌘K</kbd>
      </Button>
      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
        <ActorSwitcher />
        <ThemeToggle />
      </div>
    </header>
  );
}
