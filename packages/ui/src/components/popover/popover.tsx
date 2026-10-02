'use client';

import * as React from 'react';

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
// scrolling popover rather than an empty or uncapped one. In the column every child keeps its
// own height (`*:shrink-0`), so a body of fixed height still scrolls the popover. A child takes
// the scroll itself, keeping what sits around it in view, only with `min-h-0` and a shrink that
// outranks `*:shrink-0`, which Tailwind sorts after a plain `shrink`: `[&]:shrink` does.
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

/** A rectangle the popover hangs from: the caller's anchor, or else its own trigger. */
interface HangPoint {
  getBoundingClientRect: () => DOMRect;
}

/**
 * Where the anchored popover hangs. It is always one registered anchor, the caller's or else a
 * stand-in that measures the trigger, so Radix never swaps the trigger in and out as its own
 * anchor: each swap remounts the trigger node, which drops focus from it and can leave Radix
 * measuring a node no longer on the page. It registers a commit after the trigger, because the
 * trigger registers itself whenever its ref attaches, which StrictMode repeats after the
 * anchor's one registration in the same commit.
 */
function useHangPoint(
  anchor: Measurable | null | undefined,
  trigger: React.RefObject<HTMLElement | null>
): { current: HangPoint } | undefined {
  const [triggerAttached, setTriggerAttached] = React.useState(false);
  React.useEffect(() => {
    setTriggerAttached(true);
  }, []);
  return React.useMemo(() => {
    if (!triggerAttached) return;
    if (anchor) return { current: anchor };
    return {
      current: {
        getBoundingClientRect: () => (trigger.current ?? document.body).getBoundingClientRect(),
      },
    };
  }, [anchor, trigger, triggerAttached]);
}

type ContentProps = Pick<
  PopoverProps,
  'title' | 'align' | 'side' | 'width' | 'boundary' | 'data-testid' | 'children'
>;

function AnchoredContent({
  title,
  align = 'center',
  side = 'bottom',
  width = 'sm',
  boundary,
  'data-testid': testId,
  children,
}: Readonly<ContentProps>): React.JSX.Element {
  return (
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
  );
}

function SheetContent({
  title,
  open,
  onOpenChange,
  'data-testid': testId,
  children,
}: Readonly<
  ContentProps & { open: boolean; onOpenChange: (open: boolean) => void }
>): React.JSX.Element {
  return (
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
  );
}

/**
 * A small panel opened from a control. From 768 it hangs from its trigger, or from `anchor`, and
 * fits the room it opens in: it flips to the other side only when its own side is short, caps its
 * height to the room and scrolls, and stays inside `boundary`. Below 768 it is a bottom sheet
 * headed by its title, with a close button.
 *
 * One trigger serves both presentations, so crossing 768 never replaces the node a reader is
 * focused on or the popover is measured from.
 */
function Popover({
  open: requestedOpen,
  onOpenChange,
  trigger,
  anchor,
  ...content
}: Readonly<PopoverProps>): React.JSX.Element {
  const { band } = useFormFactor();
  const [open, setOpen] = useOpenState(requestedOpen, onOpenChange);
  const presentation = useOpenedValue<Presentation>(open, band === 'phone' ? 'sheet' : 'anchored');
  const sheet = presentation === 'sheet';
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const hangPoint = useHangPoint(anchor, triggerRef);
  return (
    // As a sheet the Radix popover stays shut and the overlay is what opens; its trigger still
    // toggles through Radix, which reports a press while shut as a request to open.
    <PopoverRoot open={open && !sheet} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={triggerRef}
        asChild
        {...(sheet && { 'aria-expanded': open, 'aria-controls': undefined })}
      >
        {trigger}
      </PopoverTrigger>
      {hangPoint !== undefined && <PopoverAnchor virtualRef={hangPoint} />}
      {sheet ? (
        <SheetContent {...content} open={open} onOpenChange={setOpen} />
      ) : (
        <AnchoredContent {...content} />
      )}
    </PopoverRoot>
  );
}

export { Popover };
export type { PopoverProps };
