'use client';

import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';

import { cn } from '../../lib/utilities';
import { useFormFactor } from '../platform/use-form-factor';
import { Overlay } from '../overlay/overlay';
import { OverlayContent } from '../overlay/overlay-content';
import { SheetHead } from '../overlay/sheet-head';
import { useOpenedValue, useOpenState } from '../overlay/open-state';
import {
  Popover as PopoverRoot,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from '../primitives/popover';

const WIDTH_CLASS = {
  sm: 'w-72',
  md: 'w-92',
  lg: 'w-100',
} as const;

// Radix measures the room on the side the popover lands on, inside the boundary, into these
// variables; capping to them is what narrows it to the room and scrolls a body taller than it.
// The height cap never drops below 10rem, so a boundary with no room left still leaves a
// scrolling popover rather than an empty or uncapped one. The column lets a child that opts
// into shrinking, with `min-h-0`, take the scroll itself and keep what sits around it in view;
// every other child keeps its own height, so a body of fixed height still scrolls the popover.
const ANCHORED_CLASS =
  'flex flex-col *:shrink-0 max-h-[max(10rem,var(--radix-popover-content-available-height))] max-w-(--radix-popover-content-available-width) overflow-y-auto';

/** The popover's text size, anchored and as a sheet alike. */
const TEXT_CLASS = 'text-sm';

/** The gap between the popover and what it opens from. */
const SIDE_OFFSET_PX = 8;

/** The least room kept between the popover and the edge of the viewport or its boundary. */
const COLLISION_PADDING_PX = 16;

type Measurable = Element | { getBoundingClientRect(): DOMRect };

interface PopoverProps {
  trigger: React.ReactElement;
  /** Names the popover at every width, and heads it as a sheet. */
  title: string;
  align?: 'start' | 'center' | 'end';
  /** The side it prefers; it flips to the other only when this one lacks the room. */
  side?: 'top' | 'bottom';
  width?: keyof typeof WIDTH_CLASS;
  /** Positions against this element or rectangle instead of the trigger, from 768. */
  anchor?: Measurable | null;
  /** From 768, keeps the popover inside this element's box. */
  boundary?: HTMLElement | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  'data-testid'?: string;
  children: React.ReactNode;
}

type Presentation = 'anchored' | 'sheet';

function AnchoredPopover({
  trigger,
  title,
  align = 'center',
  side = 'bottom',
  width = 'sm',
  anchor,
  boundary,
  open,
  onOpenChange,
  'data-testid': testId,
  children,
}: Readonly<
  PopoverProps & { open: boolean; onOpenChange: (open: boolean) => void }
>): React.JSX.Element {
  const anchorRef = React.useMemo(() => (anchor ? { current: anchor } : undefined), [anchor]);
  return (
    <PopoverRoot open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>{trigger}</PopoverTrigger>
      {anchorRef !== undefined && <PopoverAnchor virtualRef={anchorRef} />}
      <PopoverContent
        aria-label={title}
        side={side}
        align={align}
        sideOffset={SIDE_OFFSET_PX}
        collisionPadding={COLLISION_PADDING_PX}
        collisionBoundary={boundary ?? []}
        className={cn(WIDTH_CLASS[width], ANCHORED_CLASS, TEXT_CLASS)}
        {...(testId !== undefined && { 'data-testid': testId })}
      >
        {children}
      </PopoverContent>
    </PopoverRoot>
  );
}

function SheetPopover({
  trigger,
  title,
  open,
  onOpenChange,
  'data-testid': testId,
  children,
}: Readonly<
  PopoverProps & { open: boolean; onOpenChange: (open: boolean) => void }
>): React.JSX.Element {
  return (
    <>
      <Slot
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          onOpenChange(!open);
        }}
      >
        {trigger}
      </Slot>
      <Overlay open={open} onOpenChange={onOpenChange} ariaLabel={title} showCloseButton={false}>
        <OverlayContent
          className={TEXT_CLASS}
          {...(testId !== undefined && { 'data-testid': testId })}
        >
          <SheetHead
            title={title}
            onClose={() => {
              onOpenChange(false);
            }}
          />
          {children}
        </OverlayContent>
      </Overlay>
    </>
  );
}

/**
 * A small panel opened from a control. From 768 it hangs from its trigger, or from `anchor`, and
 * fits the room it opens in: it flips to the other side only when its own side is short, caps its
 * height to the room and scrolls, and stays inside `boundary`. Below 768 it is a bottom sheet
 * headed by its title, with a close button.
 */
function Popover({
  open: requestedOpen,
  onOpenChange,
  ...props
}: Readonly<PopoverProps>): React.JSX.Element {
  const { band } = useFormFactor();
  const [open, setOpen] = useOpenState(requestedOpen, onOpenChange);
  const presentation = useOpenedValue<Presentation>(open, band === 'phone' ? 'sheet' : 'anchored');
  return presentation === 'sheet' ? (
    <SheetPopover {...props} open={open} onOpenChange={setOpen} />
  ) : (
    <AnchoredPopover {...props} open={open} onOpenChange={setOpen} />
  );
}

export { Popover };
export type { PopoverProps };
