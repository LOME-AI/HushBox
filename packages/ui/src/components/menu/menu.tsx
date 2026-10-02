'use client';

import * as React from 'react';

import { cn } from '../../lib/utilities';
import { useFormFactor } from '../platform/use-form-factor';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '../primitives/dropdown-menu';
import { useOpenedValue, useOpenState } from '../overlay/open-state';
import { MenuAfterCloseContext, MenuContext, type MenuPresentation } from './menu-context';
import { MenuSheet } from './menu-sheet';
import type { MenuEntry } from './menu-sheet-list';

interface MenuProps {
  trigger: React.ReactElement;
  /** Names the sheet, and heads it unless `sheetHeader` is `none`. */
  title: string;
  align?: 'start' | 'end';
  side?: 'top' | 'bottom';
  /** The least width of the anchored menu. */
  minWidth?: '12rem' | '16rem';
  /** Below 768px: a bottom sheet, or anchored as at every other width. */
  phonePresentation?: 'sheet' | 'anchored';
  /** Whether the sheet shows its title row with a close button, or only its handle. */
  sheetHeader?: 'title' | 'none';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Placed on the menu list in both presentations. */
  'data-testid'?: string;
  /**
   * Wherever the menu is anchored rather than a sheet, the element it opens `offset` beyond, edge
   * aligned by `align`, in place of its trigger.
   */
  anchor?: MenuAnchor;
  /**
   * Wherever the menu is anchored, the element focus returns to on close while the trigger is
   * hidden and cannot take it back, as when a caller opens the menu from another control.
   */
  fallbackFocus?: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
}

interface MenuAnchor {
  element: React.RefObject<HTMLElement | null>;
  offset: '0.5rem';
}

const ANCHOR_OFFSET_REM: Readonly<Record<MenuAnchor['offset'], number>> = { '0.5rem': 0.5 };

/** The trigger-relative offsets that place the content against the anchor instead. */
interface AnchorOffsets {
  /** From the trigger's bottom edge, while the content sits below. */
  below: number;
  /** From the trigger's top edge, while the content sits above. */
  above: number;
  align: number;
}

// The 16rem floor stays a rem inside the viewport, so large text on a narrow phone never
// pushes the menu past the screen's edge.
const MIN_WIDTH_CLASS: Readonly<Record<NonNullable<MenuProps['minWidth']>, string>> = {
  '12rem': 'min-w-48',
  '16rem': 'min-w-[min(16rem,calc(100vw-1rem))]',
};

interface MenuState {
  open: boolean;
  setOpen: (open: boolean) => void;
  /** How the menu is drawn: held from the open through the close, until the next open. */
  presentation: MenuPresentation;
  /** How the trigger opens it: the width's presentation while closed, the drawn one while open. */
  wiring: MenuPresentation;
  entry: MenuEntry;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  /** Opens the sheet; the trigger takes focus first, so the sheet returns focus to it. */
  openSheet: (from: MenuEntry) => void;
}

function useMenuState({
  open: controlledOpen,
  onOpenChange,
  phonePresentation = 'sheet',
}: Readonly<Pick<MenuProps, 'open' | 'onOpenChange' | 'phonePresentation'>>): MenuState {
  const { band } = useFormFactor();
  const [open, setOpen] = useOpenState(controlledOpen, onOpenChange);
  const current: MenuPresentation =
    band === 'phone' && phonePresentation === 'sheet' ? 'sheet' : 'anchored';
  const presentation = useOpenedValue(open, current);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const [entry, setEntry] = React.useState<MenuEntry>('pointer');
  // A pointer press on a button leaves focus elsewhere in some engines.
  const openSheet = (from: MenuEntry): void => {
    triggerRef.current?.focus({ preventScroll: true });
    setEntry(from);
    setOpen(true);
  };
  return {
    open,
    setOpen,
    presentation,
    wiring: open ? presentation : current,
    entry,
    triggerRef,
    openSheet,
  };
}

/** What the trigger carries while the menu is a sheet: it opens a dialog, on the click. */
type SheetTriggerProps = Pick<
  React.ComponentProps<'button'>,
  'aria-haspopup' | 'aria-expanded' | 'onPointerDown' | 'onClick'
> & { 'data-state': 'open' | 'closed' };

/**
 * Radix places content against its trigger alone, so the anchor becomes trigger-relative offsets,
 * measured as the menu opens, whether its trigger or its caller opens it. A hidden trigger measures
 * as an empty box at the page's origin, and the offsets reach the anchor from there.
 */
function measureAnchor(
  anchor: Readonly<MenuAnchor>,
  trigger: HTMLElement | null,
  align: 'start' | 'end'
): AnchorOffsets | undefined {
  const element = anchor.element.current;
  if (element === null || trigger === null) return undefined;
  const a = element.getBoundingClientRect();
  const t = trigger.getBoundingClientRect();
  const rootPx = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  const offset = ANCHOR_OFFSET_REM[anchor.offset] * rootPx;
  return {
    below: a.bottom - t.bottom + offset,
    above: t.top - a.top + offset,
    align: align === 'start' ? a.left - t.left : t.right - a.right,
  };
}

/**
 * The anchor's offsets, measured on each open, and whether the content has flipped off its
 * preferred side. The two sides sit different distances from the trigger, so a flip holds for the
 * rest of the open: switching offsets back could flip the content back, and so on.
 */
function useAnchorPlacement({
  anchor,
  triggerRef,
  align,
  side,
  anchoredOpen,
}: Readonly<{
  anchor: Readonly<MenuAnchor> | undefined;
  triggerRef: React.RefObject<HTMLButtonElement | null>;
  align: 'start' | 'end';
  side: 'top' | 'bottom';
  /** Whether the menu is open in its anchored form, when the anchor is measured. */
  anchoredOpen: boolean;
}>): Partial<React.ComponentProps<typeof DropdownMenuContent>> {
  const [offsets, setOffsets] = React.useState<AnchorOffsets>();
  const [flipped, setFlipped] = React.useState(false);
  // The content mounts a render after the open, through Radix's portal, so it is held as state.
  const [content, setContent] = React.useState<HTMLDivElement | null>(null);
  const element = anchor?.element;
  const offset = anchor?.offset;
  // A passive effect, so a caller that opens the menu as it mounts has attached the anchor's ref
  // first; an open from a press flushes it before the next paint.
  React.useEffect(() => {
    if (!anchoredOpen) return;
    setFlipped(false);
    setOffsets(
      element === undefined || offset === undefined
        ? undefined
        : measureAnchor({ element, offset }, triggerRef.current, align)
    );
  }, [anchoredOpen, element, offset, triggerRef, align]);
  React.useEffect(() => {
    if (offsets === undefined || content === null) return;
    // Radix names the side it placed the content on only as this attribute, and may have set it
    // before this runs.
    const readSide = (): void => {
      if (content.dataset['side'] !== side) setFlipped(true);
    };
    readSide();
    const observer = new MutationObserver(readSide);
    observer.observe(content, { attributes: true, attributeFilter: ['data-side'] });
    return (): void => {
      observer.disconnect();
    };
  }, [content, offsets, side]);
  if (offsets === undefined) return {};
  const onTop = (side === 'top') !== flipped;
  return {
    ref: setContent,
    sideOffset: onTop ? offsets.above : offsets.below,
    alignOffset: offsets.align,
    // The default keeps the content overlapping its trigger, which would pull it off an anchor
    // wider than the trigger.
    sticky: 'always',
  };
}

function sheetTriggerProps(open: boolean, onOpen: () => void): SheetTriggerProps {
  return {
    'aria-haspopup': 'dialog',
    'aria-expanded': open,
    'data-state': open ? 'open' : 'closed',
    // Radix opens on the press; the sheet opens on the click, so the release lands on nothing new.
    onPointerDown: (event: React.PointerEvent): void => {
      event.preventDefault();
    },
    onClick: onOpen,
  };
}

/**
 * A menu anchored to its trigger from 768px and, by default, a bottom sheet below it. Both hold
 * one `menu` with the same item roles and arrow-key movement, so an item is found the same way
 * at either width; the sheet is a dialog around that menu.
 */
function Menu(props: Readonly<MenuProps>): React.JSX.Element {
  const {
    trigger,
    title,
    minWidth,
    sheetHeader = 'title',
    'data-testid': testId,
    children,
  } = props;
  const { open, setOpen, presentation, wiring, entry, triggerRef, openSheet } = useMenuState(props);
  const anchoredOpen = presentation === 'anchored' && open;
  const align = props.align ?? 'end';
  const side = props.side ?? 'bottom';
  const placement = useAnchorPlacement({
    anchor: props.anchor,
    triggerRef,
    align,
    side,
    anchoredOpen,
  });
  const close = React.useCallback((): void => {
    setOpen(false);
  }, [setOpen]);
  const pendingAction = React.useRef<(() => void) | null>(null);
  const runAfterClose = React.useCallback((action: () => void): void => {
    pendingAction.current = action;
  }, []);
  const runPendingAction = React.useCallback((): void => {
    const action = pendingAction.current;
    pendingAction.current = null;
    action?.();
  }, []);
  const context = React.useMemo(() => ({ presentation, close }), [presentation, close]);
  const testIdProps = testId === undefined ? {} : { 'data-testid': testId };

  // As a sheet, Radix's menu stays closed but still owns the trigger's keys, so it only ever asks
  // to open through this, from the keyboard: the sheet's own press path is the click.
  const handleRootOpenChange = (next: boolean): void => {
    if (wiring === 'sheet') {
      openSheet('keyboard');
      return;
    }
    setOpen(next);
  };

  // A trigger that draws no box, hidden by its caller, cannot take focus back as the menu closes.
  // A held action runs here, once focus is back, so whatever it opens records the trigger as its
  // opener.
  const handleCloseAutoFocus = (event: Event): void => {
    const fallback = props.fallbackFocus?.current;
    const triggerHidden = triggerRef.current?.getClientRects().length === 0;
    if (fallback != null && triggerHidden) {
      event.preventDefault();
      fallback.focus({ preventScroll: true });
    } else if (pendingAction.current !== null) {
      event.preventDefault();
      triggerRef.current?.focus({ preventScroll: true });
    }
    runPendingAction();
  };

  return (
    <MenuContext value={context}>
      <MenuAfterCloseContext value={runAfterClose}>
        <DropdownMenu open={anchoredOpen} onOpenChange={handleRootOpenChange}>
          <DropdownMenuTrigger
            asChild
            ref={triggerRef}
            {...(wiring === 'sheet' &&
              sheetTriggerProps(open, () => {
                openSheet('pointer');
              }))}
          >
            {trigger}
          </DropdownMenuTrigger>
          {presentation === 'anchored' && (
            <DropdownMenuContent
              align={align}
              side={side}
              className={cn(minWidth !== undefined && MIN_WIDTH_CLASS[minWidth])}
              {...placement}
              onCloseAutoFocus={handleCloseAutoFocus}
              {...testIdProps}
            >
              {children}
            </DropdownMenuContent>
          )}
        </DropdownMenu>
        {presentation === 'sheet' && (
          <MenuSheet
            open={open}
            onOpenChange={setOpen}
            onClosed={runPendingAction}
            title={title}
            header={sheetHeader}
            entry={entry}
            {...testIdProps}
          >
            {children}
          </MenuSheet>
        )}
      </MenuAfterCloseContext>
    </MenuContext>
  );
}

export { Menu };
export type { MenuProps };
