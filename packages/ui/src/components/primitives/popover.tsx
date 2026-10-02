import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { cn } from '../../lib/utilities';
import { revealFocusAfterCancelledTab } from '../../lib/reveal-focus-after-tab';
import { usePortalContainer } from './portal-container';

function Popover({
  ...props
}: Readonly<React.ComponentProps<typeof PopoverPrimitive.Root>>): React.JSX.Element {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({
  ...props
}: Readonly<React.ComponentProps<typeof PopoverPrimitive.Trigger>>): React.JSX.Element {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverAnchor({
  ...props
}: Readonly<React.ComponentProps<typeof PopoverPrimitive.Anchor>>): React.JSX.Element {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverContent({
  className,
  align = 'center',
  sideOffset = 4,
  onKeyDown,
  container,
  ...props
}: Readonly<
  React.ComponentProps<typeof PopoverPrimitive.Content> & {
    /**
     * The element the content portals into; else the nearest `PortalContainerProvider`'s element,
     * else the document body.
     */
    container?: React.ComponentProps<typeof PopoverPrimitive.Portal>['container'];
  }
>): React.JSX.Element {
  return (
    <PopoverPrimitive.Portal container={usePortalContainer(container)}>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        align={align}
        sideOffset={sideOffset}
        className={cn(
          'bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-popover w-72 origin-(--radix-popover-content-transform-origin) rounded-md border p-4 shadow-md outline-none',
          className
        )}
        {...props}
        onKeyDown={(event) => {
          onKeyDown?.(event);
          revealFocusAfterCancelledTab(event);
        }}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverTrigger, PopoverContent, PopoverAnchor };
