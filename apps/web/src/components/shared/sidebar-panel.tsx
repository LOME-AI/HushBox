import * as React from 'react';
import { cn, Sheet, SheetContent } from '@hushbox/ui';
import { X, PanelLeft, PanelRight } from 'lucide-react';
import { useIsMobile } from '@/hooks/use-is-mobile';

interface SidebarPanelProps {
  side: 'left' | 'right';
  open: boolean;
  onOpenChange: (open: boolean) => void;
  collapsed?: boolean | undefined;
  headerIcon?: React.ReactNode | undefined;
  headerTitle?: React.ReactNode | undefined;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode | undefined;
  testId?: string | undefined;
}

interface SidebarPanelHeaderProps {
  side: 'left' | 'right';
  collapsed: boolean;
  headerIcon?: React.ReactNode;
  headerTitle?: React.ReactNode;
  onClose: () => void;
  testId?: string | undefined;
}

function SidebarPanelHeader({
  side,
  collapsed,
  headerIcon,
  headerTitle,
  onClose,
  testId,
}: Readonly<SidebarPanelHeaderProps>): React.JSX.Element {
  const CollapsedIcon = side === 'left' ? PanelLeft : PanelRight;

  const closeButton = (
    <button
      type="button"
      onClick={onClose}
      className="hover:bg-sidebar-border/50 rounded p-1"
      aria-label="Close sidebar"
    >
      <X className="h-4 w-4" />
    </button>
  );

  const titleGroup = (
    <div className="flex items-center gap-2">
      {side === 'left' && headerIcon}
      {headerTitle !== undefined && (
        <span className="text-primary text-lg font-bold">{headerTitle}</span>
      )}
      {side === 'right' && headerIcon}
    </div>
  );

  const testIdProps = testId === undefined ? {} : { 'data-testid': `${testId}-header` };
  const baseClasses =
    'border-sidebar-border flex h-[53px] shrink-0 items-center border-b px-4 whitespace-nowrap';

  if (collapsed) {
    return (
      <div {...testIdProps} className={cn(baseClasses, 'justify-center')}>
        <button
          type="button"
          onClick={onClose}
          className="hover:bg-sidebar-border/50 rounded p-1"
          aria-label="Expand sidebar"
        >
          <CollapsedIcon className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <div {...testIdProps} className={cn(baseClasses, 'justify-between')}>
      {side === 'left' ? (
        <>
          {titleGroup}
          {closeButton}
        </>
      ) : (
        <>
          {closeButton}
          {titleGroup}
        </>
      )}
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
  onClose,
  children,
  footer,
  testId,
}: Readonly<SidebarPanelProps>): React.JSX.Element {
  const isMobile = useIsMobile();

  const header = (
    <SidebarPanelHeader
      side={side}
      collapsed={collapsed ?? false}
      headerIcon={headerIcon}
      headerTitle={headerTitle}
      onClose={onClose}
      testId={testId}
    />
  );

  const body = <div className="flex min-h-0 flex-1 flex-col p-2">{children}</div>;

  const content = (
    <>
      {header}
      {body}
      {footer}
    </>
  );

  if (isMobile) {
    return (
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent
          side={side}
          className="bg-sidebar text-sidebar-foreground flex w-72 flex-col p-0"
          showCloseButton={false}
          {...(testId === undefined ? {} : { 'data-testid': testId })}
        >
          {content}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <aside
      {...(testId === undefined ? {} : { 'data-testid': testId })}
      className={cn(
        'bg-sidebar text-sidebar-foreground border-sidebar-border flex h-dvh flex-col overflow-hidden',
        'transition-[width] duration-200 ease-in-out',
        side === 'left' && 'hidden border-r md:flex',
        side === 'right' && 'hidden border-l md:flex',
        collapsed ? 'w-12' : 'w-72'
      )}
    >
      <div className={cn('flex h-full flex-col', collapsed ? 'min-w-12' : 'min-w-72')}>
        {content}
      </div>
    </aside>
  );
}
