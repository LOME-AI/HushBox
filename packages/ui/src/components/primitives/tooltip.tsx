import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { useIsTouchDevice } from '../../hooks/use-is-touch-device';
import { cn } from '../../lib/utilities';
import { usePortalContainer } from './portal-container';

// Context for touch-mode communication between Tooltip root and TooltipTrigger
interface TouchTooltipContextValue {
  toggle: () => void;
  notePointerDown: () => void;
}

const TouchTooltipContext = React.createContext<TouchTooltipContextValue | null>(null);

function TooltipProvider({
  delayDuration = 0,
  ...props
}: Readonly<React.ComponentProps<typeof TooltipPrimitive.Provider>>): React.JSX.Element {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  );
}

// Touch-mode controlled wrapper — manages open state via click-to-toggle
function TouchTooltipRoot({
  children,
  open: controlledOpen,
  defaultOpen,
  onOpenChange: controlledOnOpenChange,
  ...rest
}: Readonly<React.ComponentProps<typeof TooltipPrimitive.Root>>): React.JSX.Element {
  const isControlled = controlledOpen !== undefined;
  const [internalOpen, setInternalOpen] = React.useState(defaultOpen ?? false);
  const open = isControlled ? controlledOpen : internalOpen;

  const setOpen = React.useCallback(
    (value: boolean) => {
      if (!isControlled) setInternalOpen(value);
      controlledOnOpenChange?.(value);
    },
    [isControlled, controlledOnOpenChange]
  );

  // Radix's own trigger pointerdown handler closes an open tooltip before the tap's
  // click reaches the toggle, so a tap on an open trigger would otherwise re-open it.
  // The state the toggle inverts is therefore the one captured at pointerdown; a click
  // with no pointerdown before it (keyboard Enter or Space) inverts the live state.
  const openBeforeTapRef = React.useRef<boolean | null>(null);

  const notePointerDown = React.useCallback(() => {
    openBeforeTapRef.current = open;
  }, [open]);

  const toggle = React.useCallback(() => {
    const from = openBeforeTapRef.current ?? open;
    openBeforeTapRef.current = null;
    setOpen(!from);
  }, [open, setOpen]);

  const contextValue = React.useMemo(
    () => ({ toggle, notePointerDown }),
    [toggle, notePointerDown]
  );

  return (
    <TouchTooltipContext.Provider value={contextValue}>
      <TooltipProvider>
        <TooltipPrimitive.Root data-slot="tooltip" open={open} onOpenChange={setOpen} {...rest}>
          {children}
        </TooltipPrimitive.Root>
      </TooltipProvider>
    </TouchTooltipContext.Provider>
  );
}

function Tooltip(
  props: Readonly<React.ComponentProps<typeof TooltipPrimitive.Root>>
): React.JSX.Element {
  const isTouch = useIsTouchDevice();

  if (isTouch) {
    return <TouchTooltipRoot {...props} />;
  }

  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  );
}

function TooltipTrigger({
  onClick,
  onPointerDown,
  onPointerMove,
  onPointerLeave,
  onBlur,
  onFocus,
  ...props
}: Readonly<React.ComponentProps<typeof TooltipPrimitive.Trigger>>): React.JSX.Element {
  const touchContext = React.useContext(TouchTooltipContext);

  // Radix opens on any focus. Focus that follows a pointer or a tap (an overlay handing focus
  // back to its opener after a click outside, say) is not keyboard-visible, and a tooltip
  // raised by it covers the page with nothing asking for it. preventDefault() stops Radix's
  // composed handler from opening.
  const handleFocus = (event: React.FocusEvent<HTMLButtonElement>): void => {
    onFocus?.(event);
    if (!event.currentTarget.matches(':focus-visible')) event.preventDefault();
  };

  if (!touchContext) {
    return (
      <TooltipPrimitive.Trigger
        data-slot="tooltip-trigger"
        onClick={onClick}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerLeave={onPointerLeave}
        onBlur={onBlur}
        {...props}
        onFocus={handleFocus}
      />
    );
  }

  // Touch mode: intercept the hover events so only click toggles open state.
  // preventDefault() blocks Radix's composeEventHandlers from calling internal handlers.
  // It is deliberately absent from pointerdown, click and blur: on pointerdown it
  // suppresses the compatibility mouse events and with them the tap's own focus, and on
  // click it would swallow the default action of whatever `asChild` wraps.
  return (
    <TooltipPrimitive.Trigger
      data-slot="tooltip-trigger"
      {...props}
      onPointerMove={(event: React.PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        onPointerMove?.(event);
      }}
      onPointerLeave={(event: React.PointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        onPointerLeave?.(event);
      }}
      onPointerDown={(event: React.PointerEvent<HTMLButtonElement>) => {
        // stopPropagation prevents DismissableLayer's document listener
        // from closing the tooltip before our onClick toggle fires
        event.stopPropagation();
        touchContext.notePointerDown();
        onPointerDown?.(event);
      }}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        touchContext.toggle();
        onClick?.(event);
      }}
      onBlur={onBlur}
      onFocus={handleFocus}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  container,
  ...props
}: Readonly<
  React.ComponentProps<typeof TooltipPrimitive.Content> & {
    /**
     * The element the tooltip portals into; else the nearest `PortalContainerProvider`'s element,
     * else the document body.
     */
    container?: React.ComponentProps<typeof TooltipPrimitive.Portal>['container'];
  }
>): React.JSX.Element {
  return (
    <TooltipPrimitive.Portal container={usePortalContainer(container)}>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-popover w-fit max-w-64 origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance',
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-popover size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
