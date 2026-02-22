import * as React from 'react';
import { ChevronUp } from 'lucide-react';
import { cn, DropdownMenu, DropdownMenuTrigger, DropdownMenuContent } from '@hushbox/ui';

interface SidebarFooterBaseProps {
  /** Icon rendered inside the circle avatar */
  icon: React.ReactNode;
  /** Primary label text */
  label: string;
  /** Secondary label text (smaller, muted) */
  sublabel?: string | undefined;
  /** Whether the content is loading */
  isStable?: boolean | undefined;
  /** Click handler for the trigger area */
  onClick?: (() => void) | undefined;
  /** Dropdown menu content (overrides onClick) */
  dropdownContent?: React.ReactNode | undefined;
  /** Whether the footer is in collapsed (rail) mode */
  collapsed?: boolean | undefined;

  /** Test ID prefix */
  testId?: string | undefined;
}

export function SidebarFooterBase({
  icon,
  label,
  sublabel,
  onClick,
  dropdownContent,
  collapsed,
  testId,
}: Readonly<SidebarFooterBaseProps>): React.JSX.Element {
  const triggerContent = (
    <button
      data-testid={testId === undefined ? undefined : `${testId}-trigger`}
      type="button"
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-md p-2 transition-colors',
        'hover:bg-sidebar-border/50 hover:ring-sidebar-border hover:ring-1 focus:outline-none',
        collapsed && 'justify-center'
      )}
      {...(dropdownContent === undefined && onClick !== undefined ? { onClick } : {})}
    >
      <div className="bg-muted text-muted-foreground flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
        {icon}
      </div>
      {!collapsed && (
        <>
          <div className="flex min-w-0 flex-1 flex-col text-left text-sm">
            <span className="truncate">{label}</span>
            {sublabel !== undefined && (
              <span className="text-muted-foreground text-xs">{sublabel}</span>
            )}
          </div>
          <ChevronUp className="text-muted-foreground size-4" />
        </>
      )}
    </button>
  );

  const innerContent =
    dropdownContent === undefined ? (
      triggerContent
    ) : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>{triggerContent}</DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-56">
          {dropdownContent}
        </DropdownMenuContent>
      </DropdownMenu>
    );

  return (
    <div
      data-testid={testId === undefined ? undefined : `${testId}-footer`}
      className={cn('border-sidebar-border border-t p-2', collapsed && 'flex justify-center')}
    >
      {innerContent}
    </div>
  );
}
