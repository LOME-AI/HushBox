import type * as React from 'react';

interface PopoverFactProps {
  icon: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}

/** One line of a popover's facts: a muted icon centred on however many lines its text takes. */
function PopoverFact({ icon: Icon, children }: Readonly<PopoverFactProps>): React.JSX.Element {
  return (
    <div className="flex items-center gap-2.5 leading-[1.45]">
      <span aria-hidden="true" className="flex shrink-0">
        <Icon className="text-muted-foreground size-4" />
      </span>
      <span className="min-w-0">{children}</span>
    </div>
  );
}

export { PopoverFact };
