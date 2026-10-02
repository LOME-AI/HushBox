import * as React from 'react';

interface PressTooltip {
  /** Spread on the `Tooltip` root. */
  readonly root: {
    readonly open: boolean;
    readonly onOpenChange: (open: boolean) => void;
  };
  /** Spread on the element the `TooltipTrigger` wraps. */
  readonly trigger: {
    readonly onPointerDown: () => void;
    readonly onClickCapture: () => void;
    readonly onClick: (event: React.MouseEvent) => void;
  };
}

/**
 * A toggle chip's tooltip that every press opens and keeps open, showing the state that press
 * left, so a touch screen, which never hovers, still names what the chip does. Every other
 * close (a tap elsewhere, Escape, the pointer leaving, focus moving on) goes through.
 */
export function usePressTooltip(onPress: () => void): PressTooltip {
  const [open, setOpen] = React.useState(false);
  // The tooltip closes itself on its trigger's pointerdown and, on a touch screen, toggles
  // itself on the trigger's click, each in the same event dispatch as the handlers here. A
  // close that arrives before that dispatch's microtasks run is the press's own, so it is
  // dropped; one from any later event is not.
  const pressing = React.useRef(false);
  const holdThroughDispatch = (): void => {
    pressing.current = true;
    queueMicrotask(() => {
      pressing.current = false;
    });
  };
  return {
    root: {
      open,
      onOpenChange: (next) => {
        if (!next && pressing.current) return;
        setOpen(next);
      },
    },
    trigger: {
      onPointerDown: holdThroughDispatch,
      // The capture phase reaches a disabled chip too, whose own click handler never runs.
      onClickCapture: () => {
        setOpen(true);
      },
      onClick: (event) => {
        // Keeps the tooltip's own close-on-click from running where it honours it.
        event.preventDefault();
        holdThroughDispatch();
        onPress();
      },
    },
  };
}
