import * as React from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '../../lib/utilities';

const toggleVariants = cva(
  "hover:bg-accent/45 hover:text-muted-foreground focus-visible:border-ring data-[state=on]:bg-accent data-[state=on]:text-accent-foreground data-[state=on]:inset-ring-muted-foreground aria-invalid:border-destructive inline-flex items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-[color,box-shadow] disabled:pointer-events-none disabled:opacity-50 data-[state=on]:font-semibold data-[state=on]:inset-ring-2 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border-border-control border bg-transparent shadow-xs',
      },
      size: {
        default: 'h-9 min-w-9 px-2 pointer-coarse:h-11',
        sm: 'h-8 min-w-8 px-1.5 pointer-coarse:h-11',
        lg: 'h-10 min-w-10 px-2.5 pointer-coarse:h-11',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

const ToggleGroupContext = React.createContext<VariantProps<typeof toggleVariants>>({
  size: 'default',
  variant: 'default',
});

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const UNCHECKED_FOCUSED_ITEM = '[data-slot="toggle-group-item"][data-state="off"]:focus';

/**
 * Gives a single-choice group the radio-group keyboard pattern, where the item an arrow
 * key focuses is the checked one. Radix moves focus a task after the keydown, so the
 * check waits one task for focus to land.
 */
function checkItemFocusedByArrow(event: React.KeyboardEvent<HTMLDivElement>): void {
  if (!ARROW_KEYS.has(event.key)) return;
  const group = event.currentTarget;
  const from = event.target;
  setTimeout(() => {
    const focused = group.querySelector<HTMLElement>(UNCHECKED_FOCUSED_ITEM);
    if (focused !== null && focused !== from) focused.click();
  });
}

function ToggleGroup({
  className,
  variant = 'default',
  size = 'default',
  children,
  onKeyDown,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Root> &
  VariantProps<typeof toggleVariants>): React.JSX.Element {
  const checksOnArrow = props.type === 'single';
  return (
    <ToggleGroupPrimitive.Root
      data-slot="toggle-group"
      data-variant={variant}
      data-size={size}
      className={cn(
        'group/toggle-group flex w-fit items-center rounded-md data-[variant=outline]:shadow-xs',
        className
      )}
      {...props}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (checksOnArrow) checkItemFocusedByArrow(event);
      }}
    >
      <ToggleGroupContext.Provider value={{ variant, size }}>
        {children}
      </ToggleGroupContext.Provider>
    </ToggleGroupPrimitive.Root>
  );
}

function ToggleGroupItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof ToggleGroupPrimitive.Item>): React.JSX.Element {
  const { variant, size } = React.useContext(ToggleGroupContext);

  return (
    <ToggleGroupPrimitive.Item
      data-slot="toggle-group-item"
      data-variant={variant}
      data-size={size}
      className={cn(
        toggleVariants({ variant, size }),
        'min-w-fit flex-1 shrink-0 rounded-none shadow-none first:rounded-l-md last:rounded-r-md focus:z-10 focus-visible:z-10 data-[variant=outline]:not-first:-ml-px',
        className
      )}
      {...props}
    >
      {children}
    </ToggleGroupPrimitive.Item>
  );
}

export { ToggleGroup, ToggleGroupItem };
