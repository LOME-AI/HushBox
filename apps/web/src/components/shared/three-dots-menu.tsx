import * as React from 'react';
import { MoreVertical } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, IconButton } from '@hushbox/ui';

interface ThreeDotsMenuProps {
  children: React.ReactNode;
  align?: 'start' | 'end';
  className?: string;
  'data-testid'?: string;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}

export function ThreeDotsMenu({
  children,
  align = 'end',
  className,
  onClick,
  ...props
}: Readonly<ThreeDotsMenuProps>): React.JSX.Element {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton className={className} data-testid={props['data-testid']} data-menu-trigger="" onClick={onClick}>
          <MoreVertical className="h-4 w-4" />
          <span className="sr-only">More options</span>
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align}>{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}
