import * as React from 'react';
import { X, PanelLeft, PanelRight } from 'lucide-react';
import { cn } from '../../lib/utilities';
import { HIT_AREA_CLASSES, IconButton } from '../button/icon-button';
import { useFormFactor } from '../platform/use-form-factor';
import { Sheet, SheetContent, SheetTitle } from '../primitives/sheet';

interface SidebarDrawer {
  isDrawer: boolean;
  close: () => void;
}

const NO_DRAWER: SidebarDrawer = {
  isDrawer: false,
  close: () => {
    /* only the phone drawer closes; the desktop panel and anything outside a panel stay put */
  },
};

const SidebarDrawerContext = React.createContext<SidebarDrawer>(NO_DRAWER);

/** Whether the caller sits in the phone drawer, and a close that dismisses only that drawer. */
export function useSidebarDrawer(): SidebarDrawer {
  return React.useContext(SidebarDrawerContext);
}

interface SidebarPanelProps {
  side: 'left' | 'right';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collapsed?: boolean | undefined;
  headerIcon?: React.ReactNode | undefined;
  headerTitle?: React.ReactNode | undefined;
  /**
   * Accessible name for the mobile Sheet — Radix Dialog requires a Title for
   * screen readers. Rendered visually-hidden inside SheetContent; the visible
   * header still uses `headerTitle`. Defaults to "Sidebar".
   */
  ariaLabel?: string | undefined;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode | undefined;
  /** Whether a rule divides the head from the body. Defaults to on. */
  headerRule?: boolean | undefined;
  testId?: string | undefined;
}

interface SidebarPanelHeaderProps {
  side: 'left' | 'right';
  collapsed: boolean;
  /**
   * Whether the close control toggles a region that persists in a collapsed
   * state — true only on the desktop panel. The header is also rendered inside
   * dialogs (the mobile Sheet, the accessibility widget), where the control
   * dismisses a surface that unmounts, so there is no region for a disclosure
   * state to describe and none is written.
   */
  collapsible?: boolean;
  headerIcon?: React.ReactNode;
  headerTitle?: React.ReactNode;
  rule?: boolean | undefined;
  /**
   * Draws a plain 1.5rem close control with even insets instead of the side panels'
   * 2.25rem icon button, for a standalone sheet whose head keeps that drawing.
   */
  compact?: boolean | undefined;
  onClose: () => void;
  testId?: string | undefined;
}

interface CloseControlProps {
  icon: typeof X;
  compact: boolean;
  onClose: () => void;
  disclosureState: { 'aria-expanded'?: boolean };
}

// The compact control is drawn exactly as the plain button it has always been; its
// touch target is the icon button's extend layer, invisible and centred over it, so
// nothing it paints moves.
const COMPACT_CLOSE_CLASSES = cn('hover:bg-sidebar-border/50 rounded p-1', HIT_AREA_CLASSES.extend);

function CloseControl({
  icon: Icon,
  compact,
  onClose,
  disclosureState,
}: Readonly<CloseControlProps>): React.JSX.Element {
  if (compact) {
    return (
      <button
        type="button"
        onClick={onClose}
        className={COMPACT_CLOSE_CLASSES}
        aria-label="Close sidebar"
        {...disclosureState}
      >
        <Icon className="h-4 w-4" />
      </button>
    );
  }
  return (
    <IconButton
      type="button"
      icon={Icon}
      hitArea="extend"
      onClick={onClose}
      aria-label="Close sidebar"
      {...disclosureState}
    />
  );
}

interface HeadTitleProps {
  side: 'left' | 'right';
  headerIcon?: React.ReactNode;
  headerTitle?: React.ReactNode;
}

function HeadTitle({ side, headerIcon, headerTitle }: Readonly<HeadTitleProps>): React.JSX.Element {
  return (
    <div className="flex h-9 items-center gap-2">
      {side === 'left' && headerIcon}
      {headerTitle !== undefined && (
        <span className="text-primary text-lg font-bold">{headerTitle}</span>
      )}
      {side === 'right' && headerIcon}
    </div>
  );
}

// Only the left panel folds to a rail it reopens from, so only it wears the panel icon
// while open; the right panel's control reads as a close.
function closeIconFor(side: 'left' | 'right', collapsible: boolean): typeof X {
  return collapsible && side === 'left' ? PanelLeft : X;
}

// In the icon-button head the control's edge sits closer to the panel's edge than the
// title does; the compact head keeps even insets.
function headInsets(side: 'left' | 'right', compact: boolean): string {
  if (compact) return 'justify-between px-4';
  return side === 'left' ? 'justify-between pr-2 pl-4' : 'justify-between pr-4 pl-2';
}

function headClasses(rule: boolean, layout: string): string {
  return cn(
    'flex min-h-[var(--app-header-height)] shrink-0 items-center py-2 whitespace-nowrap',
    rule && 'border-sidebar-border border-b',
    layout
  );
}

export function SidebarPanelHeader({
  side,
  collapsed,
  collapsible = false,
  headerIcon,
  headerTitle,
  rule = true,
  compact = false,
  onClose,
  testId,
}: Readonly<SidebarPanelHeaderProps>): React.JSX.Element {
  // The panel's own `complementary` role does not support aria-expanded, so the
  // disclosure state rides its control. Both close controls below are the same
  // toggle wearing two labels, and both stay silent outside a collapsible panel.
  const disclosureState: { 'aria-expanded'?: boolean } = collapsible
    ? { 'aria-expanded': !collapsed }
    : {};
  const testIdProps = testId === undefined ? {} : { 'data-testid': `${testId}-header` };

  // Each control keeps its drawn square on touch, so the head keeps its height; the
  // touch target is laid over the square.
  if (collapsed) {
    return (
      <div {...testIdProps} className={headClasses(rule, 'justify-center px-0')}>
        <IconButton
          type="button"
          icon={side === 'left' ? PanelLeft : PanelRight}
          hitArea="extend"
          onClick={onClose}
          aria-label="Expand sidebar"
          {...disclosureState}
        />
      </div>
    );
  }

  const closeButton = (
    <CloseControl
      icon={closeIconFor(side, collapsible)}
      compact={compact}
      onClose={onClose}
      disclosureState={disclosureState}
    />
  );
  const title = <HeadTitle side={side} headerIcon={headerIcon} headerTitle={headerTitle} />;

  const [first, second] = side === 'left' ? [title, closeButton] : [closeButton, title];
  return (
    <div {...testIdProps} className={headClasses(rule, headInsets(side, compact))}>
      {first}
      {second}
    </div>
  );
}

export function SidebarPanel({
  side,
  open,
  onOpenChange,
  collapsed,
  headerIcon,
  headerTitle,
  ariaLabel = 'Sidebar',
  onClose,
  children,
  footer,
  headerRule = true,
  testId,
}: Readonly<SidebarPanelProps>): React.JSX.Element {
  const isDrawer = useFormFactor().band === 'phone';
  const drawer = React.useMemo<SidebarDrawer>(
    () =>
      isDrawer
        ? {
            isDrawer: true,
            close: () => {
              onOpenChange(false);
            },
          }
        : NO_DRAWER,
    [isDrawer, onOpenChange]
  );

  const body = <div className="flex min-h-0 flex-1 flex-col p-2">{children}</div>;

  const content = (collapsible: boolean): React.JSX.Element => (
    <>
      <SidebarPanelHeader
        side={side}
        collapsed={collapsed ?? false}
        collapsible={collapsible}
        headerIcon={headerIcon}
        headerTitle={headerTitle}
        rule={headerRule}
        onClose={onClose}
        testId={testId}
      />
      {body}
      {footer}
    </>
  );

  if (isDrawer) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side={side}
          className="bg-sidebar text-sidebar-foreground flex w-full flex-col gap-0 p-0 pt-[env(safe-area-inset-top,0px)] sm:max-w-none"
          showCloseButton={false}
          // The drawer is navigation with nothing to describe beyond its title; the explicit
          // undefined is how Radix records that a dialog has no description.
          aria-describedby={undefined}
          data-chrome=""
          {...(testId === undefined ? {} : { 'data-testid': testId })}
        >
          <SheetTitle className="sr-only">{ariaLabel}</SheetTitle>
          <SidebarDrawerContext.Provider value={drawer}>
            {content(false)}
          </SidebarDrawerContext.Provider>
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      data-chrome=""
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className={cn(
        // h-full, never h-dvh: the root route's h-dvh container is the single
        // viewport-height authority. Re-declaring viewport height here would
        // push the sidebar (and flex siblings) off-screen whenever an
        // app-wide banner occupies space above the flex row.
        'bg-sidebar text-sidebar-foreground border-sidebar-border flex h-full flex-col overflow-hidden',
        'transition-[width] duration-200 ease-in-out',
        side === 'left' && 'hidden border-r md:flex',
        side === 'right' && 'hidden border-l md:flex',
        collapsed ? 'w-14' : 'w-72'
      )}
    >
      <div className={cn('flex h-full flex-col', collapsed ? 'min-w-14' : 'min-w-72')}>
        {content(true)}
      </div>
    </aside>
  );
}
