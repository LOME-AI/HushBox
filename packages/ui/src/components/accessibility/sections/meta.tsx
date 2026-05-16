import * as React from 'react';

import { cn } from '../../../lib/utilities';
import { useA11yStore } from '../store';

const BUTTON_CLASSES = cn(
  'border-foreground/20 bg-background text-foreground hover:bg-accent hover:text-accent-foreground hover:border-foreground/40 focus-visible:border-ring focus-visible:ring-ring/50 inline-flex cursor-pointer items-center justify-center rounded-md border-2 px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px]'
);

export function MetaSection(): React.JSX.Element {
  const reset = useA11yStore((s) => s.reset);

  return (
    <section aria-labelledby="a11y-meta-heading" className="flex flex-col gap-2">
      <h2 id="a11y-meta-heading" className="sr-only">
        Reset
      </h2>
      <button type="button" className={BUTTON_CLASSES} onClick={reset}>
        Reset all to defaults
      </button>
    </section>
  );
}
