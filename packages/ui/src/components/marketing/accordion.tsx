import * as React from 'react';
import { cn } from '../../lib/utilities';

interface AccordionProps extends React.ComponentProps<'div'> {
  trigger: React.ReactNode;
  defaultOpen?: boolean;
}

function Accordion({
  trigger,
  defaultOpen = false,
  className,
  children,
  ...props
}: Readonly<AccordionProps>): React.JSX.Element {
  const [open, setOpen] = React.useState(defaultOpen);

  return (
    <div data-slot="accordion" className={cn('border-b', className)} {...props}>
      <button
        type="button"
        onClick={(): void => {
          setOpen((previous) => !previous);
        }}
        className="hover:bg-muted/50 -mx-2 flex w-full cursor-pointer items-center justify-between rounded-lg px-2 py-3 text-left text-sm font-medium transition-colors"
        aria-expanded={open}
      >
        {trigger}
        <span className={cn('transition-transform duration-200', open && 'rotate-180')}>
          &#9662;
        </span>
      </button>
      <div
        className={cn(
          'overflow-hidden transition-all duration-200',
          open ? 'max-h-[2000px] pb-4 opacity-100' : 'max-h-0 opacity-0'
        )}
        style={{ visibility: open ? 'visible' : 'hidden' }}
      >
        {children}
      </div>
    </div>
  );
}

export { Accordion, type AccordionProps };
