import * as React from 'react';
import { cn, Kbd } from '@hushbox/ui';
import { Button } from '@hushbox/ui/button';
import { Icon, type IconComponent } from '@hushbox/ui/icons';

interface SidebarActionRowProps {
  icon: IconComponent;
  label: string;
  href?: string | undefined;
  onClick?: ((event: React.MouseEvent) => void) | undefined;
  /** A `useHotkeys` combo, drawn as the row's hint from the desktop band on a fine pointer. */
  kbd?: string | undefined;
  collapsed?: boolean | undefined;
  testId?: string | undefined;
}

// The outline row takes the page surface and a faint ink wash on hover in both themes,
// with no shadow; the outline button's own dark fill and hover would read as a field.
const ROW_LOOK = 'shadow-none dark:bg-background hover:bg-foreground/6 dark:hover:bg-foreground/6';

const EXPANDED = 'w-full justify-start';

const RAIL = 'size-9 justify-center p-0 has-[>svg]:px-0 pointer-coarse:size-11';

/**
 * The sidebar's outline action row: an icon, a label and an optional shortcut hint, or
 * the icon alone on the collapsed rail. With an `href` it is a link, so a modified or
 * middle click opens the destination in a new tab.
 */
export function SidebarActionRow({
  icon,
  label,
  href,
  onClick,
  kbd,
  collapsed = false,
  testId,
}: Readonly<SidebarActionRowProps>): React.JSX.Element {
  const content = (
    <>
      <Icon icon={icon} />
      {!collapsed && <span>{label}</span>}
      {!collapsed && kbd !== undefined && <Kbd combo={kbd} form="text" className="ml-auto" />}
    </>
  );

  const shared = {
    variant: 'outline',
    size: 'lg',
    onClick,
    'aria-label': label,
    className: cn(ROW_LOOK, collapsed ? RAIL : EXPANDED),
    ...(testId === undefined ? {} : { 'data-testid': testId }),
  } as const;

  if (href !== undefined) {
    return (
      <Button asChild {...shared}>
        <a href={href}>{content}</a>
      </Button>
    );
  }

  return (
    <Button type="button" {...shared}>
      {content}
    </Button>
  );
}
