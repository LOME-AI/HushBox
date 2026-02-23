import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { useIsTouchDevice } from '../hooks/use-is-touch-device';
import { cn } from '../lib/utilities';

// Context for touch-mode communication between Tooltip root and TooltipTrigger
interface TouchTooltipContextValue {
  toggle: () => void;
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

  const toggle = React.useCallback(() => {
    setOpen(!open);
  }, [open, setOpen]);

  const contextValue = React.useMemo(() => ({ toggle }), [toggle]);

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
  ...props
}: Readonly<React.ComponentProps<typeof TooltipPrimitive.Trigger>>): React.JSX.Element {
  const touchContext = React.useContext(TouchTooltipContext);

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
      />
    );
  }

  // Touch mode: intercept all hover/focus events so only click toggles open state.
  // preventDefault() blocks Radix's composeEventHandlers from calling internal handlers.
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
        event.preventDefault();
        event.stopPropagation();
        onPointerDown?.(event);
      }}
      onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
        event.preventDefault();
        touchContext.toggle();
        onClick?.(event);
      }}
      onBlur={(event: React.FocusEvent<HTMLButtonElement>) => {
        event.preventDefault();
        onBlur?.(event);
      }}
    />
  );
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: Readonly<React.ComponentProps<typeof TooltipPrimitive.Content>>): React.JSX.Element {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          'bg-foreground text-background animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-fit origin-(--radix-tooltip-content-transform-origin) rounded-md px-3 py-1.5 text-xs text-balance',
          className
        )}
        {...props}
      >
        {children}
        <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
